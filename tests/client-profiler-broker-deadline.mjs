#!/usr/bin/env node
// Run after compiling the plugin through run-all.mjs --managed --test client-profiler-broker-deadline.mjs.
// Executes the actual compiled ClientBroker with fake engine services and a
// deterministic coroutine scheduler. No real profiler, network wait or timer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpClient, runTest } from './lib/mcp-client.mjs';

const brokerSource = readFileSync(new URL('../studio-plugin/out/modules/ClientBroker.luau', import.meta.url), 'utf8');

await runTest('Client profiler broker bounded round-trip', async ({ track }) => {
  const client = track(new McpClient('client-profiler-broker-deadline', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const instanceId = process.env.MCP_INSTANCE_ID;
  assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
  const result = await client.callTool('execute_luau', {
    instance_id: instanceId,
    target: 'edit',
    code: `
local now = 0
local sleepers = {}
local threads = {}
local ignoreCancellation = false
local function resume(thread, ...)
  local ok, detail = coroutine.resume(thread, ...)
  assert(ok, tostring(detail))
end
local function advance(seconds)
  local untilTime = now + seconds
  local steps = 0
  while true do
    local nextThread, nextAt
    for thread, at in pairs(sleepers) do
      if at <= untilTime and (nextAt == nil or at < nextAt) then
        nextThread, nextAt = thread, at
      end
    end
    if nextThread == nil then break end
    steps += 1
    assert(steps < 10000, 'scheduler did not make progress')
    now = nextAt
    sleepers[nextThread] = nil
    resume(nextThread)
  end
  now = untilTime
end
local task = {
  spawn = function(callback, ...)
    local thread = coroutine.create(callback)
    table.insert(threads, thread)
    resume(thread, ...)
    return thread
  end,
  wait = function(seconds)
    local duration = math.max(seconds or 0.01, 0.0001)
    sleepers[coroutine.running()] = now + duration
    return coroutine.yield()
  end,
  cancel = function(thread)
    if ignoreCancellation then error('simulated engine wait cannot be cancelled') end
    sleepers[thread] = nil
    coroutine.close(thread)
  end,
}
function task.delay(seconds, callback, ...)
  local args = {...}
  return task.spawn(function() task.wait(seconds) callback(table.unpack(args)) end)
end
local os = {clock = function() return now end}
local player = {Name = 'FixturePlayer', Parent = {}}
local removed
local running = true
local localRole = 'server'
local invocations = 0
local captures = 0
local mode = 'success'
local blockedThread
local lastEnvelope
local remote = {Parent = {}}
function remote:IsA(class) return class == 'RemoteFunction' end
function remote:GetAttribute() return nil end
function remote:SetAttribute() end
function remote:InvokeServer() return {success = true} end
function remote:InvokeClient(target, envelope)
  assert(target == player)
  invocations += 1
  lastEnvelope = envelope
  if mode == 'throw' then error('injected InvokeClient error') end
  if mode == 'nil' then return nil end
  if mode == 'cutoff-success' then
    task.wait(envelope.remainingMs / 1000 + 0.01)
    return {success = true, capture = 'at-cutoff'}
  end
  if mode == 'handler-error' then return {error = 'script_profiler_start_failed', message = 'injected profiler failure'} end
  if mode == 'hang' then
    blockedThread = coroutine.running()
    coroutine.yield()
    return {success = true, capture = 'late'}
  end
  if mode == 'delayed-success' then task.wait(0.1) end
  return self.OnClientInvoke(envelope)
end
local services = {
  HttpService = {
    JSONEncode = function(_, value) return value end,
    JSONDecode = function(_, value) return value end,
    RequestAsync = function(_, request)
      if string.sub(request.Url, -6) == '/ready' then
        return {Success = true, Body = {success = true, peerId = 'fixture-peer', instanceId = 'fixture-instance', assignedRole = 'client-1'}}
      end
      return {Success = true, Body = {}}
    end,
  },
  Players = {PlayerRemoving = {Connect = function(_, callback) removed = callback end}},
  ReplicatedStorage = {FindFirstChild = function() return remote end, WaitForChild = function() return remote end},
  RunService = {IsRunning = function() return running end},
  Workspace = {GetServerTimeNow = function() return 1000000 + now end},
}
local modules = {
  services = services,
  PluginSession = {
    peerId = 'fixture-server',
    getInstanceId = function() return 'fixture-instance' end,
    getMultiplayerGroupId = function() return nil end,
    createReadyPayload = function() return {} end,
  },
  PeerRole = {detect = function() return localRole end},
  ScriptProfilerHandlers = {captureScriptProfiler = function(data)
    captures += 1
    return {success = true, capture = captures, duration_ms = data.duration_ms}
  end},
}
local unused = {'RuntimeLogBuffer', 'MemoryHandlers', 'SceneAnalysisHandlers', 'CaptureHandlers', 'CaptureTransfer', 'InputHandlers', 'MetadataHandlers', 'EvalRuntimeHandlers', 'BreakpointHandlers', 'MicroProfilerHandlers', 'LuauExec', 'HttpDiagnostics', 'TopologyId'}
for _, name in ipairs(unused) do modules[name] = {} end
local runtime = {
  getModule = function(_, _, name) return assert(modules[name], name) end,
  import = function(_, location, ...)
    local names = {...}
    if #names == 0 then return location end
    return assert(modules[names[#names]], tostring(names[#names]))
  end,
}
local script = {}
setmetatable(script, {__index = function(_, key)
  if key == 'WaitForChild' or key == 'FindFirstAncestor' then return function() return script end end
  return script
end})
local require = function() return runtime end
local game = {GetService = function(_, name) return services[name] or {} end, BindToClose = function() end}
local broker = (function()
${brokerSource}
end)()
broker.setupServerBroker()
assert(remote.OnServerInvoke(player, {kind = 'identity', peerId = 'fixture-peer'}).success)
localRole = 'client'
broker.setupClientBroker()
localRole = 'server'
local endpoint = '/api/capture-script-profiler'
local requestNumber = 0
local function dispatch(budget, cancelled)
  requestNumber += 1
  local context = {
    requestId = 'fixture-' .. requestNumber,
    deadlineAt = now + (budget or 30),
    isCancelled = cancelled or function() return false end,
  }
  local call = {context = context, startedAt = now}
  call.thread = task.spawn(function()
    call.result = broker.dispatchClientRequest('fixture-peer', 'client-1', endpoint, {duration_ms = 100}, context)
    call.completedAt = now
  end)
  return call
end

-- The regression: a healthy first call must not make a nonresponding second
-- InvokeClient invisible until the outer 30-second request deadline.
local first = dispatch()
advance(0.2)
assert(first.result and first.result.capture == 1, 'first capture must succeed')
mode = 'hang'
local second = dispatch()
advance(29)
assert(second.result ~= nil, 'nonresponding second InvokeClient must settle before the outer 30-second deadline')
assert(second.result.error == 'client_broker_timeout', 'must report broker wait timeout, not profiler execution failure')
assert(second.result.stage == 'client_broker_wait')
assert(second.context.executionOutcome == 'unknown', 'remote execution outcome remains unknown')
assert(second.result.requestId == second.context.requestId)
assert(second.completedAt - second.startedAt <= 25.01)
assert(coroutine.status(blockedThread) == 'dead', 'cancel the local InvokeClient coroutine when the scheduler supports it')
assert(invocations == 2, 'timeout must never retry the remote invocation')

mode = 'delayed-success'
local third = dispatch()
advance(0.2)
assert(third.result and third.result.capture == 2, 'healthy sequential capture after timeout must work')
assert(lastEnvelope.requestId == third.context.requestId)
assert(lastEnvelope.remainingMs > 0 and lastEnvelope.remainingMs <= 25000)

-- Remaining request budget, rather than a fresh 30 seconds, bounds the wait.
mode = 'hang'
local short = dispatch(7)
advance(3)
assert(short.result and short.result.error == 'client_broker_timeout')
assert(short.completedAt - short.startedAt <= 2.01, 'reserve five seconds for delivering the diagnostic')
assert(lastEnvelope.remainingMs <= 2000)

local callsBeforeAdmission = invocations
local expired = dispatch(1)
assert(expired.result and expired.result.error == 'client_broker_timeout')
assert(expired.context.executionOutcome == 'not_executed')
local cancelledBefore = dispatch(30, function() return true end)
assert(cancelledBefore.result and cancelledBefore.result.error == 'client_broker_cancelled')
assert(cancelledBefore.context.executionOutcome == 'not_executed')
assert(invocations == callsBeforeAdmission, 'expired or cancelled admission must not invoke the client')

local cancelNow = false
local cancelledDuring = dispatch(30, function() return cancelNow end)
cancelNow = true
advance(0.2)
assert(cancelledDuring.result and cancelledDuring.result.error == 'client_broker_cancelled')
assert(cancelledDuring.context.executionOutcome == 'unknown', 'local cancellation cannot prove remote rollback')

mode = 'throw'
local thrown = dispatch()
advance(0.2)
assert(thrown.result and thrown.result.error == 'client_broker_invoke_failed')
assert(string.find(thrown.result.message, 'injected InvokeClient error', 1, true))
assert(thrown.context.executionOutcome == 'unknown', 'InvokeClient failure alone does not prove remote execution failed')
mode = 'nil'
local missing = dispatch()
advance(0.2)
assert(missing.result and missing.result.error == 'client_broker_nil_response')
assert(missing.context.executionOutcome == 'unknown')

mode = 'handler-error'
local handlerError = dispatch()
advance(0.2)
assert(handlerError.result and handlerError.result.error == 'script_profiler_start_failed')
assert(handlerError.context.executionOutcome == nil, 'confirmed handler response retains ordinary outcome classification')

-- The remote coroutine resumes after its cutoff before the polling waiter runs.
-- A completion flag alone would incorrectly accept this successful late result.
mode = 'cutoff-success'
local cutoff = dispatch(7)
sleepers[cutoff.thread] = cutoff.startedAt + 2.1
advance(2.1)
assert(cutoff.result and cutoff.result.error == 'client_broker_timeout', 'completion after the deadline is not success')
assert(cutoff.context.executionOutcome == 'unknown')

-- A late engine response cannot overwrite the chosen timeout, even if cancelling
-- the local engine wait was unavailable. A new request keeps its own result.
mode = 'hang'
ignoreCancellation = true
local late = dispatch(7)
local lateThread = blockedThread
advance(3)
local timedOut = late.result
assert(timedOut and timedOut.error == 'client_broker_timeout')
local callsBeforeLate = invocations
resume(lateThread)
assert(late.result == timedOut and late.result.error == 'client_broker_timeout')
assert(invocations == callsBeforeLate, 'late completion must not trigger retries')
ignoreCancellation = false
mode = 'success'
local afterLate = dispatch()
advance(0.2)
assert(afterLate.result and afterLate.result.capture == 3)

-- The client checks the engine-synchronized expiry before starting work. Its
-- local os.clock deliberately differs from the sending VM's clock.
local capturedBeforeExpiry = captures
local clientExpired = remote.OnClientInvoke({endpoint = endpoint, data = {duration_ms = 100},
  requestId = 'expired-in-transit', remainingMs = 1000, expiresAtServerTime = 1000000 + now - 1})
assert(clientExpired.error == 'client_broker_expired' and clientExpired.stage == 'client_broker_pre_start')
assert(captures == capturedBeforeExpiry, 'expired envelope must not start profiling')
local legacy = remote.OnClientInvoke({endpoint = endpoint, data = {duration_ms = 100}})
assert(legacy.success, 'older broker envelopes retain existing healthy behavior')

mode = 'hang'
local disconnected = dispatch()
player.Parent = nil
removed(player)
advance(0.2)
assert(disconnected.result and disconnected.result.error == 'client_broker_disconnected')
assert(disconnected.context.executionOutcome == 'unknown')
assert(coroutine.status(blockedThread) == 'dead')
for _, thread in ipairs(threads) do
  assert(coroutine.status(thread) == 'dead', 'settled requests must release local scheduler waits')
end
return 'client-profiler-broker-deadline-passed'
`,
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(String(result.returnValue), 'client-profiler-broker-deadline-passed');
});

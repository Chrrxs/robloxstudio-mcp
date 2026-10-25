#!/usr/bin/env node
// Run after compiling the plugin through run-all.mjs --managed --test client-broker-liveness.mjs.
// Executes the compiled ClientBroker and CaptureTransfer with fake engine
// services, a fake heartbeat RemoteEvent and a deterministic coroutine
// scheduler. Covers every forwarded endpoint, not only the profiler: a client
// request that never answers must settle before the MCP deadline with a
// diagnosis of the client bridge, a stalled bridge must refuse new requests
// instead of queueing them, and a request that reaches the client late must
// not run there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpClient, runTest } from './lib/mcp-client.mjs';

const brokerSource = readFileSync(new URL('../studio-plugin/out/modules/ClientBroker.luau', import.meta.url), 'utf8');
const transferSource = readFileSync(new URL('../studio-plugin/out/modules/CaptureTransfer.luau', import.meta.url), 'utf8');

export const fixture = `
local now = 0
local sleepers = {}
local threads = {}
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
    assert(steps < 100000, 'scheduler did not make progress')
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
    sleepers[thread] = nil
    coroutine.close(thread)
  end,
}
function task.delay(seconds, callback, ...)
  local args = {...}
  return task.spawn(function() task.wait(seconds) callback(table.unpack(args)) end)
end
local os = {clock = function() return now end}
local warnings = {}
local warn = function(message) table.insert(warnings, tostring(message)) end
local player = {Name = 'FixturePlayer', Parent = {}}
local running = true
local localRole = 'server'

-- Engine stand-ins. 'deliver' runs the client callback; 'drop' never delivers
-- (a request stuck between server and client); dropRead drops only chunk reads.
local mode = 'deliver'
local dropRead = false
local invocations = 0
local droppedEnvelope
local remote = {Name = '__MCPClientBroker', Parent = {}}
function remote:IsA(class) return class == 'RemoteFunction' end
function remote:GetAttribute() return nil end
function remote:SetAttribute() end
function remote:InvokeServer() return {success = true} end
function remote:InvokeClient(target, envelope)
  assert(target == player)
  invocations += 1
  if mode == 'drop' or (dropRead and envelope.endpoint == '/__mcp/capture-studio/read') then
    droppedEnvelope = envelope
    coroutine.yield()
    error('dropped invocation resumed')
  end
  return self.OnClientInvoke(envelope)
end

local serverListener, clientListener
local heartbeatsBlocked = false
local pingsBlocked = false
local heartbeat = {Name = '__MCPClientBrokerHeartbeat', Parent = {}}
function heartbeat:IsA(class) return class == 'RemoteEvent' end
heartbeat.OnServerEvent = {Connect = function(_, callback) serverListener = callback end}
heartbeat.OnClientEvent = {Connect = function(_, callback) clientListener = callback end}
function heartbeat:FireServer(payload)
  if not heartbeatsBlocked and serverListener then serverListener(player, payload) end
end
function heartbeat:FireClient(target, payload)
  assert(target == player)
  if not pingsBlocked and clientListener then clientListener(payload) end
end

local children = {[remote.Name] = remote, [heartbeat.Name] = heartbeat}
local guid = 0
local services = {
  HttpService = {
    JSONEncode = function(_, value) return value end,
    JSONDecode = function(_, value) return value end,
    GenerateGUID = function() guid += 1 return 'transfer-' .. guid end,
    RequestAsync = function(_, request)
      if string.sub(request.Url, -6) == '/ready' then
        return {Success = true, Body = {success = true, peerId = 'fixture-peer', instanceId = 'fixture-instance', assignedRole = 'client-1'}}
      end
      return {Success = true, Body = {}}
    end,
  },
  Players = {PlayerRemoving = {Connect = function() end}},
  ReplicatedStorage = {
    FindFirstChild = function(_, name) return children[name] end,
    WaitForChild = function(_, name) return children[name] end,
  },
  RunService = {IsRunning = function() return running end},
  Workspace = {GetServerTimeNow = function() return 1000000 + now end},
}
local game = {GetService = function(_, name) return services[name] or {} end, BindToClose = function() end}

local handlerCalls = 0
local hangHandler = false
local hangCapture = false
local modules = {
  services = services,
  PluginSession = {
    peerId = 'fixture-server',
    getInstanceId = function() return 'fixture-instance' end,
    getMultiplayerGroupId = function() return nil end,
    createReadyPayload = function() return {} end,
  },
  PeerRole = {detect = function() return localRole end},
  EvalRuntimeHandlers = {evalRuntime = function(data)
    handlerCalls += 1
    if hangHandler then coroutine.yield() end
    return {bridge = 'ok', ok = true, result = tostring(data.code)}
  end},
  RuntimeLogBuffer = {query = function() return {entries = {}, totalDropped = 0, nextSince = 1} end},
  CaptureHandlers = {captureStudio = function()
    if hangCapture then coroutine.yield() end
    return {success = true, encoding = 'png', source = 'StudioCaptureService', width = 1, height = 1,
      nativeWidth = 1, nativeHeight = 1, data = 'AAAAAAAA'}
  end},
}
local unused = {'MemoryHandlers', 'SceneAnalysisHandlers', 'InputHandlers', 'MetadataHandlers', 'BreakpointHandlers', 'ScriptProfilerHandlers', 'MicroProfilerHandlers', 'SimulationHandlers', 'LuauExec', 'HttpDiagnostics', 'TopologyId'}
for _, name in ipairs(unused) do modules[name] = {} end
modules.CaptureTransfer = (function()
${transferSource}
end)()
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
local broker = (function()
${brokerSource}
end)()

broker.setupServerBroker()
assert(remote.OnServerInvoke(player, {kind = 'identity', peerId = 'fixture-peer'}).success)
localRole = 'client'
broker.setupClientBroker()
localRole = 'server'
assert(clientListener ~= nil, 'client listens for server pings')
advance(2.5)

local requestNumber = 0
local function dispatch(endpoint, budget, data)
  requestNumber += 1
  local context = {
    requestId = 'fixture-' .. requestNumber,
    deadlineAt = now + (budget or 30),
    isCancelled = function() return false end,
  }
  local call = {context = context, startedAt = now}
  call.thread = task.spawn(function()
    call.result = broker.dispatchClientRequest('fixture-peer', 'client-1', endpoint, data or {code = 'return ' .. requestNumber}, context)
    call.completedAt = now
  end)
  return call
end
local function has(text, needle)
  return type(text) == 'string' and string.find(text, needle, 1, true) ~= nil
end

-- Healthy bridge: ordinary round trip with the envelope deadline attached.
local healthy = dispatch('/api/eval-runtime')
advance(0.1)
assert(healthy.result and healthy.result.ok == true, 'healthy eval round trip')
assert(healthy.context.executionOutcome == nil, 'a delivered response keeps normal outcome classification')

-- A client handler that never returns ends the broker wait before the 30 s MCP
-- deadline, and the heartbeat tells the caller it is running inside the client.
hangHandler = true
local hung = dispatch('/api/eval-runtime', 30)
advance(26)
assert(hung.result and hung.result.error == 'client_broker_timeout', 'hung eval settles with a broker timeout')
assert(hung.result.stage == 'client_broker_wait')
assert(hung.context.executionOutcome == 'unknown')
local hungTook = hung.completedAt - hung.startedAt
assert(hungTook >= 24.9 and hungTook <= 25.01, 'leave five seconds to deliver the diagnosis: ' .. hungTook)
assert(hung.result.bridge.requestState == 'running', 'heartbeat reports the request as running on the client')
assert(has(hung.result.message, 'handler has been running'), hung.result.message)
hangHandler = false

-- One stuck handler does not wedge the bridge.
local afterHung = dispatch('/api/eval-runtime')
advance(0.1)
assert(afterHung.result and afterHung.result.ok == true, 'healthy request after a stuck handler')

-- Server-to-client backlog: the request and the pings stop arriving, while the
-- client's own heartbeats still reach the server.
mode = 'drop'
pingsBlocked = true
local stuck = dispatch('/api/eval-runtime', 30)
local stuckEnvelope = droppedEnvelope
advance(26)
assert(stuck.result and stuck.result.error == 'client_broker_timeout')
assert(stuck.context.executionOutcome == 'unknown')
assert(stuck.result.bridge.requestState == 'not_received', tostring(stuck.result.bridge.requestState))
assert(stuck.result.bridge.serverToClientDelayMs > 10000)
assert(has(stuck.result.message, 'has not reached the client'), stuck.result.message)

-- A stalled channel refuses new work at once instead of letting it queue up and
-- run long after the caller saw a timeout.
local invocationsBeforeRefusal = invocations
local refused = dispatch('/api/execute-luau', 30)
assert(refused.result and refused.result.error == 'client_bridge_unresponsive', 'stalled bridge refuses immediately')
assert(refused.result.stage == 'client_broker_admission')
assert(refused.context.executionOutcome == 'not_executed')
assert(refused.completedAt == refused.startedAt, 'refusal does not wait')
assert(invocations == invocationsBeforeRefusal, 'refused request is never sent')
assert(has(refused.result.message, 'not necessarily the game'), refused.result.message)

-- When the backlog drains, the request that timed out reaches the client after
-- its deadline and must not run.
local callsBeforeLate = handlerCalls
local late = remote.OnClientInvoke(stuckEnvelope)
assert(late.error == 'client_broker_expired' and late.stage == 'client_broker_pre_start')
assert(late.executionOutcome == 'not_executed' and late.lateMs > 0)
assert(handlerCalls == callsBeforeLate, 'late request did not run')
local legacy = remote.OnClientInvoke({endpoint = '/api/eval-runtime', data = {code = 'legacy'}})
assert(legacy.ok == true, 'envelopes without a deadline keep working')

-- Recovery once pings flow again.
mode = 'deliver'
pingsBlocked = false
advance(2)
local recovered = dispatch('/api/eval-runtime')
advance(0.1)
assert(recovered.result and recovered.result.ok == true, 'bridge recovers when the channel drains')

-- Heartbeats stop. While requests are still answered, silence alone must not
-- block the channel: a broken heartbeat is not a broken bridge.
heartbeatsBlocked = true
advance(11)
local answered = dispatch('/api/get-runtime-logs', 5)
advance(0.1)
assert(answered.result and answered.result.nextSince == 1, 'working channel is not refused for missing heartbeats')
-- Once a request also goes unanswered, the diagnosis names the silence and
-- later requests are refused.
mode = 'drop'
local silent = dispatch('/api/get-runtime-logs', 5)
advance(5)
assert(silent.result and silent.result.error == 'client_broker_timeout')
assert(has(silent.result.message, 'stopped sending heartbeats'), silent.result.message)
local silentRefused = dispatch('/api/get-runtime-logs', 5)
assert(silentRefused.result and silentRefused.result.error == 'client_bridge_unresponsive')
assert(silentRefused.context.executionOutcome == 'not_executed')
mode = 'deliver'
heartbeatsBlocked = false
advance(2)
local afterSilence = dispatch('/api/get-runtime-logs', 5)
advance(0.1)
assert(afterSilence.result and afterSilence.result.nextSince == 1, 'resumed heartbeats lift the refusal')

-- Runtime log fan-out uses a 5 s budget; it keeps most of it.
mode = 'drop'
local short = dispatch('/api/get-runtime-logs', 5)
advance(5)
assert(short.result and short.result.error == 'client_broker_timeout')
local shortTook = short.completedAt - short.startedAt
assert(shortTook >= 3.9 and shortTook <= 4.01, 'short budget keeps 80%: ' .. shortTook)
mode = 'deliver'
advance(2)

-- Screenshot transfer: a chunk read that never answers ends the transfer with a
-- structured broker failure, not an opaque capture error.
dropRead = true
local capture = dispatch('/api/capture-studio', 30, {encoding = 'png'})
advance(26)
assert(capture.result and capture.result.error == 'client_broker_timeout', tostring(capture.result and capture.result.error))
assert(capture.result.endpoint == '/api/capture-studio')
assert(has(capture.result.message, '/__mcp/capture-studio/read'), capture.result.message)
assert(capture.context.executionOutcome == 'unknown')
dropRead = false
advance(2)
local captured = dispatch('/api/capture-studio', 30, {encoding = 'png'})
advance(0.1)
assert(captured.result and captured.result.success == true and captured.result.data == 'AAAAAAAA', 'healthy capture transfer')

-- Captures that never finish on the client hold its two transfer slots only
-- until their request deadline, not until the playtest restarts.
hangCapture = true
local heldA = dispatch('/api/capture-studio', 30, {encoding = 'png'})
local heldB = dispatch('/api/capture-studio', 30, {encoding = 'png'})
advance(1)
hangCapture = false
local full = dispatch('/api/capture-studio', 30, {encoding = 'png'})
advance(0.1)
assert(full.result and has(full.result.error, 'still hold'), tostring(full.result and full.result.error))
assert(has(full.result.error, 'frees itself in 2'), full.result.error)
advance(26)
assert(heldA.result and heldA.result.error == 'client_broker_timeout')
assert(heldB.result and heldB.result.error == 'client_broker_timeout')
local freed = dispatch('/api/capture-studio', 30, {encoding = 'png'})
advance(0.1)
assert(freed.result and freed.result.success == true, 'slots are free once the timed-out captures pass their deadline')

running = false
advance(3)
for _, name in ipairs(warnings) do
  assert(not has(name, 'liveness is unavailable'), name)
end
return 'client-broker-liveness-passed'
`;

if (process.env.CLIENT_BROKER_LIVENESS_PRINT === '1') {
  process.stdout.write(fixture);
} else {
  await runTest('Client broker bounded waits and liveness', async ({ track }) => {
    const client = track(new McpClient('client-broker-liveness', { startupTimeoutMs: 20000 }));
    await client.start();
    await client.initialize();
    const instanceId = process.env.MCP_INSTANCE_ID;
    assert.ok(instanceId, 'Run with an explicitly targeted managed instance');
    const result = await client.callTool('execute_luau', { instance_id: instanceId, target: 'edit', code: fixture });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(String(result.returnValue), 'client-broker-liveness-passed');
  });
}

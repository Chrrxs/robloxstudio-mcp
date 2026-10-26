#!/usr/bin/env node
// Diagnostic, opt-in: a sustained client-to-server transfer over a
// RemoteFunction drops the playtest client in a busy game. It does, without the
// MCP broker, what the broker does to copy a client capture or screenshot back:
// the server calls InvokeClient back to back and the client answers each call
// with 1 MiB of base64.
//
// Reproduces in a solo playtest of a busy game (build-a-titanic, where calls
// took ~250 ms server-to-client and ~800 ms client-to-server): back to back,
// the client was dropped after 36.6 s / 32.5 MB, 38.9 s / 34.6 MB and
// 44.8 s / 40.9 MB, each time with Studio logging
// "Connection closed with reason: QUIC: 1 (Internal Error)" and "Disconnected
// from game, please reconnect". Idling as long as each call took (pace_ms -1)
// kept it connected for 120 s / 50 MB, as did a 1 s wait between calls
// (120 s / 58 MB). On the test Baseplate it does not reproduce: calls take
// ~30 ms, and 1.25 GB went through in 90 s, also with replication, RemoteEvent
// and client frame-time loads (load_parts, spawn_parts, remote_kb,
// client_busy_ms) and with the game's place in the test Studio.
//
// Run it against an open Studio with the game's playtest running:
//   MCP_INSTANCE_ID=instance:... REPRO_USE_RUNNING_PLAYTEST=1 node tests/client-broker-transfer-repro.mjs
// REPRO_EXPERIMENTS='[{"name":"half-duty","seconds":120,"pace_ms":-1}]' replaces
// the default experiments; without REPRO_USE_RUNNING_PLAYTEST each experiment
// starts and stops a playtest (REPRO_SETTLE_MS waits for the game to load).
// The managed runner (which passes no environment) runs the defaults on the
// Baseplate:
//   node scripts/studio-test-profile.mjs run -- tests/run-all.mjs --managed --test client-broker-transfer-repro.mjs
// It records facts only; it fails only if an experiment cannot run.
// Output: BROKER_TRANSFER_REPRO <json>.

import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, routingPeers, runTest, startPlaytestAndWait } from './lib/mcp-client.mjs';

// The broker reads client captures in 768 KiB chunks.
const CHUNK_BYTES = 768 * 1024;
const EXPERIMENT_DEFAULTS = { seconds: 60, chunk_bytes: CHUNK_BYTES, pace_ms: 0, load_parts: 0, spawn_parts: 0, spawn_cap: 40000, remote_kb: 0, client_busy_ms: 0, ping_only: false };
const DEFAULT_EXPERIMENTS = [
  { name: 'back-to-back', seconds: 90 },
  { name: 'half-duty', seconds: 120, pace_ms: -1 },
].map((experiment) => ({ ...EXPERIMENT_DEFAULTS, ...experiment }));
const EXPERIMENTS = process.env.REPRO_EXPERIMENTS
  ? JSON.parse(process.env.REPRO_EXPERIMENTS).map((experiment, index) => ({
    ...EXPERIMENT_DEFAULTS, name: `custom-${index + 1}`, ...experiment,
  }))
  : DEFAULT_EXPERIMENTS;
// Against an open instance, REPRO_USE_RUNNING_PLAYTEST=1 runs inside its
// current playtest instead of starting and stopping one per experiment.
const USE_RUNNING_PLAYTEST = process.env.REPRO_USE_RUNNING_PLAYTEST === '1';
// A game place can need longer than the Baseplate to load after Play.
const SETTLE_MS = Number(process.env.REPRO_SETTLE_MS ?? 2000);
const REMOTE = 'RsmcpBrokerRepro';
const LOAD_EVENT = 'RsmcpBrokerReproLoad';
const STATE = 'RsmcpBrokerReproState';

const SERVER_SETUP = `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
for _, name in { "${REMOTE}", "${LOAD_EVENT}" } do
  local old = ReplicatedStorage:FindFirstChild(name)
  if old then old:Destroy() end
end
local rf = Instance.new("RemoteFunction")
rf.Name = "${REMOTE}"
rf.Parent = ReplicatedStorage
local event = Instance.new("RemoteEvent")
event.Name = "${LOAD_EVENT}"
event.Parent = ReplicatedStorage
game:GetService("ServerStorage"):SetAttribute("${STATE}", nil)
return true`;

// Random bytes, so the payload compresses no better than a capture.
const CLIENT_SETUP = (experiment) => `
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local rf = ReplicatedStorage:WaitForChild("${REMOTE}", 10)
local event = ReplicatedStorage:WaitForChild("${LOAD_EVENT}", 10)
assert(rf and event, "the repro remotes did not replicate")
local size = ${experiment.chunk_bytes}
local raw = buffer.create(size)
local rng = Random.new()
for i = 0, size - 4, 4 do buffer.writeu32(raw, i, rng:NextInteger(0, 4294967295)) end
local data = buffer.tostring(game:GetService("EncodingService"):Base64Encode(raw))
local received = 0
event.OnClientEvent:Connect(function(blob) received += #blob end)
local frames, windowStart, fps = 0, os.clock(), 0
local until_ = os.clock() + ${experiment.seconds + 30}
local conn
conn = RunService.RenderStepped:Connect(function()
  frames += 1
  local now = os.clock()
  if now - windowStart >= 1 then
    fps = frames / (now - windowStart)
    frames, windowStart = 0, now
  end
  if ${experiment.client_busy_ms} > 0 then
    local stop = now + ${experiment.client_busy_ms} / 1000
    while os.clock() < stop do end
  end
  if now > until_ then conn:Disconnect() end
end)
rf.OnClientInvoke = function(request)
  local at = workspace:GetServerTimeNow()
  if request.ping then return { ok = true, data = "", at = at, fps = fps, received = received } end
  return { ok = true, offset = request.offset, length = size, data = data, at = at, fps = fps, received = received }
end
return #data`;

const SERVER_LOOP = (experiment) => `
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local rf = ReplicatedStorage:FindFirstChild("${REMOTE}")
local event = ReplicatedStorage:FindFirstChild("${LOAD_EVENT}")
local player = Players:GetPlayers()[1]
assert(rf and event and player, "no remote or no player")
local started = os.clock()
local state = { status = "running", calls = 0, bytes = 0, max_ms = 0, slow_calls = 0, max_s2c_ms = 0, max_c2s_ms = 0,
  per_5s = {}, last_ms = {}, last_s2c_ms = {}, last_c2s_ms = {}, server_frames = 0 }
local function keep(list, value)
  table.insert(list, value)
  if #list > 12 then table.remove(list, 1) end
end
local function save()
  state.elapsed_s = os.clock() - started
  state.server_fps = state.server_frames / math.max(state.elapsed_s, 0.001)
  ServerStorage:SetAttribute("${STATE}", HttpService:JSONEncode(state))
end
local left
left = Players.PlayerRemoving:Connect(function(p)
  if p ~= player then return end
  if state.status == "running" then
    state.status = "player_left"
    state.left_after_s = os.clock() - started
    state.left_after_bytes = state.bytes
    save()
  end
  left:Disconnect()
end)
local parts = {}
local folder = Instance.new("Folder")
folder.Name = "RsmcpBrokerReproParts"
folder.Parent = workspace
for i = 1, ${experiment.load_parts} do
  local part = Instance.new("Part")
  part.Anchored = true
  part.Size = Vector3.new(1, 1, 1)
  part.Position = Vector3.new(i % 100, 50, i // 100)
  part.Parent = folder
  parts[i] = part
end
local blob = string.rep("x", ${experiment.remote_kb} * 1024)
local spawned, first, last = {}, 1, 0
state.spawned = 0
task.spawn(function()
  while state.status == "running" do
    state.server_frames += 1
    local t = os.clock()
    for i, part in parts do
      part.CFrame = CFrame.new(i % 100, 50 + math.sin(t + i), i // 100) * CFrame.Angles(0, t, 0)
    end
    for _ = 1, ${experiment.spawn_parts} do
      local part = Instance.new("Part")
      part.Anchored = true
      part.Size = Vector3.new(math.random(), math.random(), math.random())
      part.Position = Vector3.new(math.random(-500, 500), math.random(0, 200), math.random(-500, 500))
      part:SetAttribute("n", state.spawned)
      part.Parent = folder
      last += 1
      spawned[last] = part
      state.spawned += 1
    end
    while last - first + 1 > ${experiment.spawn_cap} do
      spawned[first]:Destroy()
      spawned[first] = nil
      first += 1
    end
    if #blob > 0 and player.Parent then event:FireClient(player, blob) end
    RunService.Heartbeat:Wait()
  end
  folder:Destroy()
end)
task.spawn(function()
  while state.status == "running" and os.clock() - started < ${experiment.seconds} do
    local t0 = os.clock()
    local sentAt = workspace:GetServerTimeNow()
    local ok, res = pcall(function() return rf:InvokeClient(player, { offset = state.bytes, ping = ${experiment.ping_only} }) end)
    local ms = math.floor((os.clock() - t0) * 1000)
    if state.status ~= "running" then break end
    if not ok then
      state.status = "invoke_error"
      state.error = tostring(res)
      break
    end
    state.calls += 1
    state.bytes += #res.data
    state.max_ms = math.max(state.max_ms, ms)
    if ms > 1000 then state.slow_calls += 1 end
    local bucket = math.floor((os.clock() - started) / 5) + 1
    state.per_5s[bucket] = (state.per_5s[bucket] or 0) + #res.data
    keep(state.last_ms, ms)
    local s2c = math.floor((res.at - sentAt) * 1000)
    local c2s = math.floor((workspace:GetServerTimeNow() - res.at) * 1000)
    state.max_s2c_ms = math.max(state.max_s2c_ms, s2c)
    state.max_c2s_ms = math.max(state.max_c2s_ms, c2s)
    keep(state.last_s2c_ms, s2c)
    keep(state.last_c2s_ms, c2s)
    state.client_fps = res.fps
    state.client_received_remote_bytes = res.received
    save()
    -- pace_ms < 0 waits as long as the call took, so the link idles half the time.
    local pace = ${experiment.ping_only ? 1000 : experiment.pace_ms}
    if pace < 0 then pace = ms end
    if pace > 0 then task.wait(pace / 1000) end
  end
  if state.status == "running" then state.status = "completed" end
  save()
end)
return true`;

const READ_STATE = `
local raw = game:GetService("ServerStorage"):GetAttribute("${STATE}")
return raw or "null"`;

async function roles(client) {
  return routingPeers(await client.callTool('get_connected_instances', {})).map((peer) => peer.role);
}

// execute_luau returns a decoded value or its JSON text; READ_STATE returns JSON text.
function luauValue(body) {
  let value = body.returnValue;
  while (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

async function run(client, experiment) {
  await client.callTool('execute_luau', { target: 'server', code: SERVER_SETUP }, 20_000);
  const encoded = await client.callTool('execute_luau', { target: 'client-1', code: CLIENT_SETUP(experiment) }, 60_000);
  await client.callTool('execute_luau', { target: 'server', code: SERVER_LOOP(experiment) }, 60_000);
  const deadline = Date.now() + (experiment.seconds + 30) * 1000;
  let state;
  let failedReads = 0;
  while (Date.now() < deadline) {
    await delay(5000);
    const read = await client.callToolResult('execute_luau', { target: 'server', code: READ_STATE }, 20_000);
    if (read.isError) {
      console.log(`  ${experiment.name}: state read failed: ${JSON.stringify(read.body).slice(0, 300)}`);
      // The server Peer is gone: the playtest itself ended.
      if (++failedReads >= 3) {
        state = { ...state, status: 'playtest_ended' };
        break;
      }
      continue;
    }
    failedReads = 0;
    const value = luauValue(read.body);
    if (value === null && state !== undefined) {
      // A new server DataModel has no state: someone restarted the playtest.
      state = { ...state, status: 'playtest_restarted_elsewhere' };
      console.log(`  ${experiment.name}: the playtest was restarted by something else; stopping`);
      break;
    }
    state = value ?? undefined;
    const mbPerS = state && state.elapsed_s > 0 ? (state.bytes / 1e6 / state.elapsed_s).toFixed(2) : '?';
    console.log(`  ${experiment.name}: ${state?.status} after ${state?.elapsed_s?.toFixed(1)} s, ${state?.calls} calls, `
      + `${(state?.bytes / 1e6).toFixed(1)} MB (${mbPerS} MB/s), max call ${state?.max_ms} ms, `
      + `last s2c ${state?.last_s2c_ms?.at(-1)} ms / c2s ${state?.last_c2s_ms?.at(-1)} ms, `
      + `server ${state?.server_fps?.toFixed(0)} fps, client ${state?.client_fps?.toFixed?.(0)} fps, spawned ${state?.spawned}`);
    if (state && state.status !== 'running') break;
  }
  await delay(3000);
  return { ...experiment, chunk_base64_bytes: luauValue(encoded), state, roles_after: await roles(client) };
}

await runTest('Client broker transfer repro', async ({ track }) => {
  const client = track(new McpClient('client-broker-transfer-repro'));
  const report = { chunk_bytes: CHUNK_BYTES, experiments: [] };
  try {
    await client.start();
    await client.initialize();
    for (const experiment of EXPERIMENTS) {
      if (!USE_RUNNING_PLAYTEST) {
        await startPlaytestAndWait(client, { timeoutSec: 120 });
        await delay(SETTLE_MS);
      }
      report.experiments.push(await run(client, experiment));
      if (!USE_RUNNING_PLAYTEST) {
        await client.callTool('solo_playtest', { action: 'stop' }, 30_000).catch(() => undefined);
        await delay(3000);
      }
    }
  } finally {
    console.log(`BROKER_TRANSFER_REPRO ${JSON.stringify(report)}`);
    if (!USE_RUNNING_PLAYTEST) await client.callTool('solo_playtest', { action: 'stop' }, 30_000).catch(() => undefined);
  }
}).then((ok) => process.exit(ok ? 0 : 1));

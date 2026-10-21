#!/usr/bin/env node
// Diagnostic probe (opt-in): measures client-peer round trips through the
// server broker while the playtest is stressed in different ways: a client
// eval that yields past its deadline, a client script that never yields, a
// large replication burst, RemoteEvent floods and screenshots. It records what
// happens instead of asserting, so the output shows which condition stalls
// client-peer requests, what the broker reports, and whether they recover.
//
//   node scripts/studio-test-profile.mjs run -- tests/run-all.mjs --managed --test client-broker-backlog-repro.mjs
//
// The managed runner runs every scenario. Against an already-open instance
// (MCP_INSTANCE_ID set), BROKER_PROBE_SCENARIOS=long-yield,capture selects some.

import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, runTest, safeStopPlaytest, startPlaytestAndWait } from './lib/mcp-client.mjs';

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function clientProbe(client, label, code = 'return os.clock()') {
  const started = Date.now();
  try {
    const result = await client.callToolResult('eval_client_runtime', { code }, 60_000);
    const ms = Date.now() - started;
    const body = result.body;
    const summary = result.isError || body?.ok !== true
      ? `ERROR ${JSON.stringify(body).slice(0, 600)}`
      : `ok ${String(body.result).slice(0, 200)}`;
    console.log(`[${stamp()}] ${label}: ${ms}ms ${summary}`);
    return { ms, ok: !result.isError && body?.ok === true, body };
  } catch (error) {
    console.log(`[${stamp()}] ${label}: ${Date.now() - started}ms THROW ${error.message.slice(0, 400)}`);
    return { ms: Date.now() - started, ok: false };
  }
}

async function serverEval(client, code) {
  const result = await client.callToolResult('eval_server_runtime', { code }, 60_000);
  console.log(`[${stamp()}] server: ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}

async function poll(client, label, seconds, everyMs = 2000, code) {
  const end = Date.now() + seconds * 1000;
  let index = 0;
  const results = [];
  while (Date.now() < end) {
    results.push(await clientProbe(client, `${label}#${index++}`, code));
    await delay(everyMs);
  }
  return results;
}

async function healthy(client) {
  const probe = await clientProbe(client, 'health');
  return probe.ok && probe.ms < 5000;
}

async function restart(client) {
  await safeStopPlaytest(client);
  await delay(3000);
  await startPlaytestAndWait(client, { timeoutSec: 60 });
  await delay(2000);
}

await runTest('Client broker backlog diagnostic', async ({ track }) => {
  const client = track(new McpClient('client-broker-backlog', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  const only = process.env.BROKER_PROBE_SCENARIOS?.split(',');
  const run = (name) => only === undefined || only.includes(name);

  await startPlaytestAndWait(client, { timeoutSec: 60 });
  await delay(2000);
  await poll(client, 'baseline', 6, 1000);

  if (run('long-yield')) {
    // Does one client request that yields past the waiter block later ones?
    console.log(`[${stamp()}] === long-yield: one 45 s client eval, then short evals`);
    const long = clientProbe(client, 'long-yield-45s', 'task.wait(45) return "long done"');
    await delay(1500);
    await poll(client, 'during-long', 60, 3000);
    await long;
    if (!(await healthy(client))) await restart(client);
  }

  if (run('busy')) {
    // A client script that never yields blocks the whole client Luau scheduler,
    // including the bridge's heartbeat, until Studio's script timeout (about
    // 10 s) stops it.
    console.log(`[${stamp()}] === busy: client eval spins 40 s without yielding`);
    const busy = clientProbe(client, 'busy-40s', 'local t = os.clock() while os.clock() - t < 40 do end return "busy done"');
    await delay(12_000);
    await poll(client, 'during-busy', 50, 3000);
    await busy;
    if (!(await healthy(client))) await restart(client);
  }

  if (run('replication')) {
    // Large server-to-client replication burst, like a ship being built.
    console.log(`[${stamp()}] === replication: 300 parts per frame for 15 s`);
    await serverEval(client, `
local folder = Instance.new("Folder") folder.Name = "__ProbeFlood" folder.Parent = workspace
local started = os.clock()
local count = 0
task.spawn(function()
  while os.clock() - started < 15 do
    for i = 1, 300 do
      local p = Instance.new("Part")
      p.Anchored = true
      p.Size = Vector3.new(math.random(), math.random(), math.random())
      p.Position = Vector3.new(math.random(-500, 500), math.random(0, 200), math.random(-500, 500))
      p:SetAttribute("n", count)
      p.Parent = folder
      count += 1
    end
    task.wait()
  end
  workspace:SetAttribute("__ProbeFloodCount", count)
end)
return "flood started"`);
    await poll(client, 'during-replication', 90, 2000,
      'local f = workspace:FindFirstChild("__ProbeFlood") return {parts = f and #f:GetChildren() or 0, serverCount = workspace:GetAttribute("__ProbeFloodCount")}');
    await serverEval(client, 'local f = workspace:FindFirstChild("__ProbeFlood") local n = f and #f:GetChildren() or 0 if f then f:Destroy() end return n');
    if (!(await healthy(client))) await restart(client);
  }

  if (run('remote-flood')) {
    // Large reliable RemoteEvent traffic from server to client.
    console.log(`[${stamp()}] === remote-flood: 64 KiB RemoteEvent per frame for 15 s`);
    await serverEval(client, `
local re = Instance.new("RemoteEvent") re.Name = "__ProbeRemote" re.Parent = game:GetService("ReplicatedStorage")
local blob = string.rep("x", 65536)
local started = os.clock()
task.spawn(function()
  while os.clock() - started < 15 do
    re:FireAllClients(blob)
    task.wait()
  end
end)
return "remote flood started"`);
    await poll(client, 'during-remote-flood', 90, 2000);
    if (!(await healthy(client))) await restart(client);
  }

  if (run('capture')) {
    console.log(`[${stamp()}] === capture: three client screenshots`);
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const outcome = await client.rpc('tools/call', {
        name: 'capture_screenshot',
        arguments: { instance_id: process.env.MCP_INSTANCE_ID },
      }, 90_000).then(
        (res) => (res?.content ?? []).map((item) => item.type === 'image'
          ? `image(${item.data.length} b64)` : String(item.text).slice(0, 300)).join(' | ') + ` isError=${res?.isError === true}`,
        (error) => `THROW ${error.message.slice(0, 300)}`,
      );
      console.log(`[${stamp()}] capture#${i}: ${Date.now() - started}ms ${outcome}`);
      await clientProbe(client, `after-capture#${i}`);
    }
    await poll(client, 'after-captures', 30, 2000);
  }

  await safeStopPlaytest(client);
});

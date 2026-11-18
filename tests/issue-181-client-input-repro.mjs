#!/usr/bin/env node
// Diagnostic probe (opt-in) for issue #181 on a baseplate. Records, without
// failing early, whether:
//   1. simulate_mouse_input clicks activate ScreenGui tab buttons (simulator off,
//      then under a phone preset),
//   2. client-1 attaches in solo and 1-player multiplayer playtests, and the
//      role-suffixed instance_id reaches the multiplayer client,
//   3. a client eval yielding 40 s times out and whether the bridge recovers,
//   4. fireproximityprompt exists in the client VM.
//
//   node scripts/studio-test-profile.mjs run -- tests/run-all.mjs --managed --test issue-181-client-input-repro.mjs

import { setTimeout as delay } from 'node:timers/promises';
import {
  McpClient, runTest, routingPeers, safeStopPlaytest, selectEditInstance, startPlaytestAndWait, waitForEditPeer,
} from './lib/mcp-client.mjs';

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...args) => console.log(`[${stamp()}]`, ...args);
const findings = {};

const GUI = '__RSMCP_Issue181Tabs';
const SETUP = String.raw`
local Players = game:GetService("Players")
local pg = Players.LocalPlayer:WaitForChild("PlayerGui")
local old = pg:FindFirstChild("${GUI}")
if old then old:Destroy() end
local gui = Instance.new("ScreenGui")
gui.Name = "${GUI}"
gui.ResetOnSpawn = false
gui.DisplayOrder = 1000
local bar = Instance.new("Frame")
bar.Name = "TabBar"
bar.Position = UDim2.new(0, 0, 1, -60)
bar.Size = UDim2.new(1, 0, 0, 60)
bar.Parent = gui
for i = 1, 4 do
  local b = Instance.new("TextButton")
  b.Name = "Tab" .. i
  b.Text = "Tab " .. i
  b.Position = UDim2.new((i - 1) / 4, 8, 0, 8)
  b.Size = UDim2.new(0.25, -16, 0, 44)
  b.Parent = bar
  b.Activated:Connect(function()
    gui:SetAttribute("tab", i)
    gui:SetAttribute("hits" .. i, (gui:GetAttribute("hits" .. i) or 0) + 1)
  end)
end
gui.Parent = pg
task.wait(0.3)
local inset = game:GetService("GuiService"):GetGuiInset()
local centers = {}
for i = 1, 4 do
  local b = bar["Tab" .. i]
  local p = b.AbsolutePosition + b.AbsoluteSize / 2 + inset
  centers[i] = { math.round(p.X), math.round(p.Y) }
end
local vp = workspace.CurrentCamera.ViewportSize
local UIS = game:GetService("UserInputService")
return { centers = centers, viewport = { vp.X, vp.Y }, inset = { inset.X, inset.Y },
  touch = UIS.TouchEnabled, mouse = UIS.MouseEnabled }
`;
const READ = String.raw`
task.wait(0.2)
local gui = game:GetService("Players").LocalPlayer.PlayerGui.${GUI}
return { tab = gui:GetAttribute("tab"), hits = { gui:GetAttribute("hits1") or 0, gui:GetAttribute("hits2") or 0,
  gui:GetAttribute("hits3") or 0, gui:GetAttribute("hits4") or 0 } }
`;
const CLEANUP = String.raw`
local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${GUI}")
if gui then gui:Destroy() end
return true
`;

async function tool(client, name, args, timeoutMs = 60_000) {
  const started = Date.now();
  try {
    const result = await client.callToolResult(name, args, timeoutMs);
    const ms = Date.now() - started;
    return { ms, isError: result.isError, body: result.body };
  } catch (error) {
    return { ms: Date.now() - started, isError: true, thrown: error.message };
  }
}

function brief(value, n = 400) {
  return JSON.stringify(value)?.slice(0, n);
}

async function clientEval(client, code, extra = {}, timeoutMs = 60_000) {
  const r = await tool(client, 'eval_client_runtime', { target: 'client-1', code, ...extra }, timeoutMs);
  const ok = !r.isError && r.body?.ok === true;
  let value = r.body?.result;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { /* keep string */ } }
  return { ok, ms: r.ms, value, raw: r };
}

async function peers(client) {
  const connected = await client.callTool('get_connected_instances', {});
  return { connected, peers: routingPeers(connected, undefined) };
}

async function waitForRole(client, role, seconds) {
  const end = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < end) {
    last = await peers(client);
    const peer = last.peers.find((p) => p.role === role);
    if (peer) return { attached: true, afterMs: Date.now() - (end - seconds * 1000), peer };
    await delay(1000);
  }
  return { attached: false, roles: last?.peers.map((p) => p.role) };
}

async function clickTabs(client, label) {
  const setup = await clientEval(client, SETUP);
  if (!setup.ok) { findings[label] = { setupFailed: brief(setup.raw) }; return; }
  const { centers, viewport, inset, touch, mouse } = setup.value;
  const shot = await tool(client, 'capture_screenshot', { target: 'client-1' });
  const shotText = brief(shot.body ?? shot.thrown, 300);
  log(`${label}: viewport ${viewport} inset ${inset} touch=${touch} mouse=${mouse} centers ${JSON.stringify(centers)}; screenshot ${shotText}`);
  const results = [];
  for (let round = 1; round <= 3; round += 1) {
    for (let i = 0; i < 4; i += 1) {
      const [x, y] = centers[i];
      const click = await tool(client, 'simulate_mouse_input', { target: 'client-1', action: 'click', x, y });
      const read = await clientEval(client, READ);
      const hit = read.ok && read.value.tab === i + 1;
      results.push({ round, tab: i + 1, x, y, clickOk: !click.isError, hit, state: read.value, err: click.isError ? brief(click.body ?? click.thrown) : undefined });
      log(`${label} round ${round} tab ${i + 1} @(${x},${y}) click ${click.isError ? 'ERROR ' + brief(click.body ?? click.thrown, 200) : 'ok'} -> ${brief(read.value)}`);
    }
  }
  findings[label] = { viewport, inset, touch, mouse, hits: results.filter((r) => r.hit).length, total: results.length, results };
  await clientEval(client, CLEANUP);
}

await runTest('Issue #181 client input/targeting diagnostic', async ({ track }) => {
  const client = track(new McpClient('issue-181', { startupTimeoutMs: 20000 }));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client);
  const editId = process.env.MCP_INSTANCE_ID ?? selectEditInstance(await client.callTool('get_connected_instances', {}), undefined)?.id;

  // --- Solo playtest -------------------------------------------------------
  try {
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    findings.soloClientAttach = await waitForRole(client, 'client-1', 30);
    log('solo client-1 attach', brief(findings.soloClientAttach));

    await tool(client, 'set_device_simulator', { target: 'client-1', stopSimulation: true });
    await clickTabs(client, 'clicksSimulatorOff');

    const sim = await tool(client, 'set_device_simulator', { target: 'client-1', deviceId: 'iphone_14', orientation: 'LandscapeRight' });
    log('simulator on', brief(sim.body ?? sim.thrown));
    await delay(1500);
    await clickTabs(client, 'clicksIphone14');
    await tool(client, 'set_device_simulator', { target: 'client-1', stopSimulation: true });

    const fpp = await clientEval(client, 'return typeof(fireproximityprompt)');
    findings.fireproximityprompt = fpp.value;
    log('typeof(fireproximityprompt) in client VM:', fpp.value);

    log('long eval: task.wait(40)');
    const long = await clientEval(client, 'task.wait(40) return "long done"', {}, 90_000);
    findings.longEval = { ms: long.ms, ok: long.ok, body: brief(long.raw.body ?? long.raw.thrown, 700) };
    log('long eval ->', brief(findings.longEval, 900));
    const after = [];
    for (let i = 0; i < 10; i += 1) {
      const probe = await clientEval(client, 'return os.clock()', {}, 40_000);
      after.push({ at: stamp(), ok: probe.ok, ms: probe.ms, err: probe.ok ? undefined : brief(probe.raw.body ?? probe.raw.thrown, 300) });
      log('after-long probe', brief(after.at(-1)));
      await delay(3000);
    }
    findings.afterLongEval = after;
    findings.clientAttachedAfterLongEval = (await peers(client)).peers.some((p) => p.role === 'client-1');
  } finally {
    await safeStopPlaytest(client);
  }

  await delay(4000);

  // --- One-player multiplayer ---------------------------------------------
  try {
    const start = await tool(client, 'multiplayer_playtest', { action: 'start', numPlayers: 1, timeout: 60, instance_id: editId }, 120_000);
    findings.multiplayerStart = { isError: start.isError, roles: start.body?.roles, body: start.isError ? brief(start.body ?? start.thrown, 600) : undefined };
    log('multiplayer start', brief(findings.multiplayerStart));
    const attach = await waitForRole(client, 'client-1', 30);
    findings.multiplayerClientAttach = { attached: attach.attached, roles: attach.roles };
    const { connected } = await peers(client);
    const grouped = routingPeers(connected, undefined).filter((p) => p.connectedInstanceId);
    log('grouped peers', brief(grouped, 800));
    const clientPeer = grouped.find((p) => p.role === 'client-1');
    if (clientPeer) {
      const viaSuffix = await tool(client, 'eval_client_runtime', { instance_id: clientPeer.connectedInstanceId, code: 'return game:GetService("Players").LocalPlayer.Name' });
      findings.roleSuffixedEvalClient = { instanceId: clientPeer.connectedInstanceId, isError: viaSuffix.isError, body: brief(viaSuffix.body ?? viaSuffix.thrown) };
      const viaExec = await tool(client, 'execute_luau', { instance_id: clientPeer.connectedInstanceId, target: 'client-1', code: 'return game:GetService("RunService"):IsClient()' });
      findings.roleSuffixedExecuteLuau = { isError: viaExec.isError, body: brief(viaExec.body ?? viaExec.thrown) };
      const viaTarget = await tool(client, 'eval_client_runtime', { instance_id: editId, target: 'client-1', code: 'return 1' });
      findings.editIdTargetClient = { isError: viaTarget.isError, body: brief(viaTarget.body ?? viaTarget.thrown) };
      log('role-suffixed', brief(findings.roleSuffixedEvalClient), brief(findings.roleSuffixedExecuteLuau), brief(findings.editIdTargetClient));
    }
  } finally {
    const end = await tool(client, 'multiplayer_playtest', { action: 'end', instance_id: editId, timeout: 30 }, 60_000);
    if (end.isError) await safeStopPlaytest(client);
  }

  console.log('\n=== ISSUE 181 FINDINGS ===');
  console.log(JSON.stringify(findings, null, 2));
}).then((ok) => process.exit(ok ? 0 : 1));

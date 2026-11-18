#!/usr/bin/env node
// Issue #185: a multiplayer client whose Studio process exits keeps its Player on
// the server until the engine's connection timeout (a minute or more). status must
// flag it once its bridge heartbeat stops, and leave_client must remove it promptly
// instead of waiting out the 25 s broker timeout.
//
// Kills one client Studio process (command line containing StartClient) that
// started after this test's multiplayer start, so run it on the Windows desktop
// hosting the test Studio, not alongside another runner's multiplayer test.

import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  McpClient,
  runTest,
  assert,
  selectEditInstance,
  waitForEditPeer,
} from './lib/mcp-client.mjs';

console.log('\n=== multiplayer leave_client removes a client whose process exited ===');

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  }).trim();
}

function clientProcessesSince(startedAt) {
  const output = powershell(`
$ErrorActionPreference = 'Stop'
$clients = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'RobloxStudio%'" |
  Where-Object { $_.CommandLine -match 'StartClient' } |
  ForEach-Object { @{ pid = $_.ProcessId; created = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } })
ConvertTo-Json -Compress -InputObject $clients
`);
  const processes = output ? JSON.parse(output) : [];
  return processes.filter((entry) => entry.created >= startedAt - 5_000).sort((a, b) => b.created - a.created);
}

async function pickInstanceId(client) {
  await waitForEditPeer(client);
  if (process.env.MCP_INSTANCE_ID) return process.env.MCP_INSTANCE_ID;
  const connected = await client.callTool('get_connected_instances', {});
  const edit = selectEditInstance(connected, undefined);
  if (!edit) throw new Error(`No edit Studio instance connected: ${JSON.stringify(connected)}`);
  return edit.id;
}

await runTest('multiplayer leave_client removes a client whose process exited', async ({ track }) => {
  const client = track(new McpClient('multi-exited'));
  await client.start();
  await client.initialize();
  const instanceId = await pickInstanceId(client);

  try {
    const startedAt = Date.now();
    const start = await client.callTool('multiplayer_playtest', { action: 'start', numPlayers: 2, timeout: 60, instance_id: instanceId });
    assert(start.success === true, 'multiplayer_playtest start succeeds');
    assert((start.roles ?? []).includes('client-2'), `both clients register (${JSON.stringify(start.roles)})`);

    const candidates = clientProcessesSince(startedAt);
    assert(candidates.length >= 2, `found this test's client Studio processes (${JSON.stringify(candidates)})`);
    powershell(`Stop-Process -Id ${Number(candidates[0].pid)} -Force`);
    const killedAt = Date.now();

    let flagged;
    let state;
    while (Date.now() - killedAt < 40_000) {
      state = await client.callTool('multiplayer_playtest', { action: 'status', instance_id: instanceId });
      flagged = state.unresponsiveClients?.[0]
        ?? ['client-1', 'client-2'].find((role) => !(state.roles ?? []).includes(role));
      if (flagged) break;
      await delay(1000);
    }
    assert(flagged !== undefined, `status flags the exited client within 40 s (${JSON.stringify(state)})`);
    console.log(`  exited client: ${flagged} after ${((Date.now() - killedAt) / 1000).toFixed(1)} s`);

    const leaveStartedAt = Date.now();
    const leave = await client.callTool('multiplayer_playtest', { action: 'leave_client', target: flagged, timeout: 30, instance_id: instanceId });
    const leaveSeconds = (Date.now() - leaveStartedAt) / 1000;
    assert(leave.success === true, `leave_client succeeds for the exited client (${JSON.stringify(leave)})`);
    assert(leaveSeconds < 15, `leave_client returns promptly (${leaveSeconds.toFixed(1)} s)`);
    assert(/exited|already left/.test(leave.message ?? ''), `leave_client explains the client was gone (${leave.message})`);

    state = await client.callTool('multiplayer_playtest', { action: 'status', instance_id: instanceId });
    assert(!(state.roles ?? []).includes(flagged), `status no longer lists ${flagged} (${JSON.stringify(state.roles)})`);
    assert((state.roles ?? []).some((role) => /^client-\d+$/.test(role)), 'the surviving client is still listed');

    const end = await client.callTool('multiplayer_playtest', { action: 'end', timeout: 45, instance_id: instanceId });
    assert(end.success === true, 'multiplayer_playtest end succeeds');
  } finally {
    try {
      await client.callTool('multiplayer_playtest', { action: 'end', instance_id: instanceId, timeout: 10 });
    } catch {
      // Best-effort cleanup only; failed assertions should remain primary.
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

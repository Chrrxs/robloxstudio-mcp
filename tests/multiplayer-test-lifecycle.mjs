#!/usr/bin/env node
// Exercises the explicit StudioTestService multiplayer lifecycle tools.

import { McpClient, runTest, assert, assertContains, waitForEditPeer } from './lib/mcp-client.mjs';

console.log('\n=== multiplayer_test lifecycle controls clients explicitly ===');

const MARKER = `MULTI_TEST_${Date.now()}`;

async function pickInstanceId(client) {
  if (process.env.MCP_INSTANCE_ID) return process.env.MCP_INSTANCE_ID;
  await waitForEditPeer(client);
  const connected = await client.callTool('get_connected_instances', {});
  const instances = connected.instances ?? [];
  const edit = instances.find((i) => i.role === 'edit');
  if (!edit) throw new Error(`No edit Studio instance connected: ${JSON.stringify(connected)}`);
  return edit.instanceId;
}

await runTest('multiplayer_test lifecycle controls clients explicitly', async ({ track }) => {
  const client = track(new McpClient('multi'));
  await client.start();
  await client.initialize();
  const instanceId = await pickInstanceId(client);

  try {
    const start = await client.callTool('multiplayer_test_start', {
      numPlayers: 1,
      testArgs: { marker: MARKER, mode: 'multi' },
      timeout: 45,
      instance_id: instanceId,
    });
    assert(start.success === true, 'multiplayer_test_start succeeds');
    assert(start.ready === true, `initial server/client peers register (${JSON.stringify(start.roles)})`);
    assertContains(JSON.stringify(start), MARKER, 'start/state preserves testArgs marker');

    let state = await client.callTool('multiplayer_test_state', { instance_id: instanceId });
    assert(state.phase === 'running', `state phase is running (got ${state.phase})`);
    assert((state.clientRoles ?? []).includes('client-1'), 'state includes client-1');
    assert((state.playerCount ?? 0) >= 1, `server sees at least one player (${state.playerCount})`);

    const add = await client.callTool('multiplayer_test_add_players', { numPlayers: 1, timeout: 45, instance_id: instanceId });
    assert(add.success === true, 'multiplayer_test_add_players succeeds');
    assert(add.ready === true, `client-2 registers (${JSON.stringify(add.roles)})`);

    state = await client.callTool('multiplayer_test_state', { instance_id: instanceId });
    assert((state.clientRoles ?? []).includes('client-2'), 'state includes client-2 after add');
    assert((state.players ?? []).some((p) => p.name === 'Player2'), 'server sees Player2');

    const leave = await client.callTool('multiplayer_test_leave_client', { target: 'client-2', timeout: 45, instance_id: instanceId });
    assert(leave.success === true, 'multiplayer_test_leave_client succeeds');
    assert(leave.left === true, 'client-2 disconnects');

    state = await client.callTool('multiplayer_test_state', { instance_id: instanceId });
    assert(!(state.clientRoles ?? []).includes('client-2'), 'state no longer includes client-2');
    assert((state.players ?? []).every((p) => p.name !== leave.localPlayer), `server no longer sees ${leave.localPlayer}`);

    const end = await client.callTool('multiplayer_test_end', {
      value: { status: 'multi-ok', marker: MARKER },
      timeout: 45,
      instance_id: instanceId,
    });
    assert(end.success === true, 'multiplayer_test_end succeeds');
    assert(end.ended === true, 'server peer drains after EndTest');
    assertContains(JSON.stringify(end), MARKER, 'end state contains returned marker');
  } finally {
    try {
      await client.callTool('multiplayer_test_end', { instance_id: instanceId, timeout: 10 });
    } catch {
      try {
        await client.callTool('stop_playtest', { instance_id: instanceId });
      } catch {
        // Best-effort cleanup only; failed assertions should remain primary.
      }
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

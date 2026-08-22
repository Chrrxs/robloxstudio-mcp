#!/usr/bin/env node
// Exercises the explicit StudioTestService multiplayer lifecycle tools.

import { McpClient, runTest, assert, waitForEditPeer } from './lib/mcp-client.mjs';

console.log('\n=== multiplayer_test lifecycle controls clients explicitly ===');

const MARKER = `MULTI_TEST_${Date.now()}`;

async function pickInstanceId(client) {
  if (process.env.MCP_INSTANCE_ID) return process.env.MCP_INSTANCE_ID;
  await waitForEditPeer(client);
  const connected = await client.callTool('get_connected_instances', {});
  const instances = connected.instances ?? [];
  const edit = instances.find((i) => i.roles?.includes('edit'));
  if (!edit) throw new Error(`No edit Studio instance connected: ${JSON.stringify(connected)}`);
  return edit.id;
}

await runTest('multiplayer_test lifecycle controls clients explicitly', async ({ track }) => {
  const client = track(new McpClient('multi'));
  await client.start();
  await client.initialize();
  const instanceId = await pickInstanceId(client);

  try {
    const start = await client.callTool('multiplayer_playtest', {
      action: 'start',
      numPlayers: 1,
      testArgs: { marker: MARKER, mode: 'multi' },
      timeout: 45,
      instance_id: instanceId,
    });
    assert(start.success === true, 'multiplayer_playtest start succeeds');
    assert((start.roles ?? []).includes('client-1'), `initial server/client peers register (${JSON.stringify(start.roles)})`);

    let state = await client.callTool('multiplayer_playtest', { action: 'status', instance_id: instanceId });
    assert(state.phase === 'running', `state phase is running (got ${state.phase})`);
    assert((state.roles ?? []).includes('client-1'), 'state includes client-1');
    assert((state.playerCount ?? 0) >= 1, `server sees at least one player (${state.playerCount})`);

    const add = await client.callTool('multiplayer_playtest', { action: 'add_players', numPlayers: 1, timeout: 45, instance_id: instanceId });
    assert(add.success === true, 'multiplayer_playtest add_players succeeds');
    assert((add.roles ?? []).includes('client-2'), `client-2 registers (${JSON.stringify(add.roles)})`);

    state = await client.callTool('multiplayer_playtest', { action: 'status', instance_id: instanceId });
    assert((state.roles ?? []).includes('client-2'), 'state includes client-2 after add');
    assert((state.playerCount ?? 0) >= 2, 'server sees both players');

    const leave = await client.callTool('multiplayer_playtest', { action: 'leave_client', target: 'client-2', timeout: 45, instance_id: instanceId });
    assert(leave.success === true, 'multiplayer_playtest leave_client succeeds');

    state = await client.callTool('multiplayer_playtest', { action: 'status', instance_id: instanceId });
    assert(!(state.roles ?? []).includes('client-2'), 'state no longer includes client-2');

    const end = await client.callTool('multiplayer_playtest', {
      action: 'end',
      value: { status: 'multi-ok', marker: MARKER },
      timeout: 45,
      instance_id: instanceId,
    });
    assert(end.success === true, 'multiplayer_playtest end succeeds');
    assert(end.teardownConfirmed === true, 'server peer drains after EndTest');
  } finally {
    try {
      await client.callTool('multiplayer_playtest', { action: 'end', instance_id: instanceId, timeout: 10 });
    } catch {
      try {
        await client.callTool('solo_playtest', { action: 'stop', instance_id: instanceId });
      } catch {
        // Best-effort cleanup only; failed assertions should remain primary.
      }
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

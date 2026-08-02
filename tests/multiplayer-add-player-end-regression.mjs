#!/usr/bin/env node
// Regression: StudioTestService:EndTest must tear down a multiplayer session
// after AddPlayers while every client remains connected.

import { McpClient, runTest, assert, waitForEditPeer } from './lib/mcp-client.mjs';

async function pickInstanceId(client) {
  if (process.env.MCP_INSTANCE_ID) return process.env.MCP_INSTANCE_ID;
  await waitForEditPeer(client);
  const connected = await client.callTool('get_connected_instances', {});
  const edit = (connected.instances ?? []).find((instance) => instance.role === 'edit');
  if (!edit) throw new Error(`No edit Studio instance connected: ${JSON.stringify(connected)}`);
  return edit.instanceId;
}

await runTest('multiplayer ends after adding a player', async ({ track }) => {
  const client = track(new McpClient('multiplayer-add-end'));
  await client.start();
  await client.initialize();
  const instanceId = await pickInstanceId(client);
  let started = false;

  try {
    const start = await client.callTool('multiplayer_playtest', {
      action: 'start',
      numPlayers: 1,
      timeout: 45,
      instance_id: instanceId,
    });
    started = start.success === true;
    assert(start.success === true, 'multiplayer starts');
    assert((start.roles ?? []).includes('client-1'), 'start includes client-1');

    const add = await client.callTool('multiplayer_playtest', {
      action: 'add_players',
      numPlayers: 1,
      timeout: 45,
      instance_id: instanceId,
    });
    assert(add.success === true, 'adding one player succeeds');
    assert((add.roles ?? []).includes('client-1'), 'add keeps client-1 connected');
    assert((add.roles ?? []).includes('client-2'), 'add connects client-2');
    assert(add.playerCount === 2, `server sees two players (got ${add.playerCount})`);

    const end = await client.callTool('multiplayer_playtest', {
      action: 'end',
      value: { status: 'add-player-end-ok' },
      timeout: 45,
      instance_id: instanceId,
    });
    assert(end.success === true, 'ending after AddPlayers succeeds');
    assert(end.teardownConfirmed === true, 'all multiplayer runtime peers disconnect');
    started = false;

    const status = await client.callTool('multiplayer_playtest', {
      action: 'status',
      instance_id: instanceId,
    });
    assert(status.phase === 'completed', `edit-side session completes (got ${status.phase})`);
    assert(!(status.roles ?? []).some((role) => role.startsWith('client-')), 'no multiplayer clients remain');
  } finally {
    if (started) {
      try {
        await client.callTool('multiplayer_playtest', { action: 'end', timeout: 15, instance_id: instanceId });
      } catch {
        // Best-effort cleanup only; failed assertions should remain primary.
      }
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

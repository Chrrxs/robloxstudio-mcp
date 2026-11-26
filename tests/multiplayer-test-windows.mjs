#!/usr/bin/env node
// Regression for issue #190: MCP finds a multiplayer playtest's Studio test
// windows by process, and end confirms teardown only once no test window
// process remains.

import {
  McpClient,
  runTest,
  assert,
  selectEditInstance,
  waitForEditPeer,
} from './lib/mcp-client.mjs';

async function pickInstanceId(client) {
  await waitForEditPeer(client);
  if (process.env.MCP_INSTANCE_ID) return process.env.MCP_INSTANCE_ID;
  const connected = await client.callTool('get_connected_instances', {});
  const edit = selectEditInstance(connected, undefined);
  if (!edit) throw new Error(`No edit Studio instance connected: ${JSON.stringify(connected)}`);
  return edit.id;
}

// Studio may still open a window after a call returns; give it time to show up.
async function assertNoTestWindows(client, instanceId, label, waitMs = 10_000) {
  const deadline = Date.now() + waitMs;
  let status;
  for (;;) {
    status = await client.callTool('multiplayer_playtest', { action: 'status', instance_id: instanceId });
    if (status.testWindows !== undefined || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(status.testWindows === undefined, `${label}: no test window is left running (${JSON.stringify(status)})`);
  assert(!(status.roles ?? []).some((role) => role === 'server' || role.startsWith('client-')),
    `${label}: no runtime peer is left connected (${JSON.stringify(status.roles)})`);
}

await runTest('multiplayer_playtest tracks test windows by process', async ({ track }) => {
  const client = track(new McpClient('multiplayer-test-windows'));
  await client.start();
  await client.initialize();
  const instanceId = await pickInstanceId(client);

  try {
    // A deliberately failed start would trip the harness's launch_failed stop
    // condition, so the abandoned-start path is covered by core unit tests.
    await assertNoTestWindows(client, instanceId, 'before start', 0);

    const start = await client.callTool('multiplayer_playtest', {
      action: 'start',
      numPlayers: 1,
      timeout: 60,
      instance_id: instanceId,
    });
    assert(start.success === true, `multiplayer starts (${JSON.stringify(start)})`);
    assert(start.closedStaleTestWindows === undefined, 'no earlier window was left for start to close');

    const status = await client.callTool('multiplayer_playtest', { action: 'status', instance_id: instanceId });
    assert(status.testWindows === 2, `status counts the Server and client windows (${JSON.stringify(status)})`);
    assert(status.unansweredTestWindows === undefined, 'every window has a connected plugin');

    const end = await client.callTool('multiplayer_playtest', { action: 'end', timeout: 45, instance_id: instanceId });
    assert(end.success === true && end.teardownConfirmed === true, `end confirms teardown (${JSON.stringify(end)})`);
    await assertNoTestWindows(client, instanceId, 'after end');

    const again = await client.callTool('multiplayer_playtest', { action: 'end', timeout: 10, instance_id: instanceId });
    assert(again.success === true && again.message === 'Multiplayer playtest already ended.',
      `a second end finds nothing to close (${JSON.stringify(again)})`);
  } finally {
    try {
      await client.callTool('multiplayer_playtest', { action: 'end', instance_id: instanceId, timeout: 10 });
    } catch {
      // Best-effort cleanup only; failed assertions should remain primary.
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

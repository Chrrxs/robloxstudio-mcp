#!/usr/bin/env node
// Regression for issue #190: a multiplayer start that gives up before its
// peers register must not leave Studio test windows running, and end must
// confirm teardown only once no test window process remains.

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
async function assertNoTestWindows(client, instanceId, label) {
  const deadline = Date.now() + 10_000;
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

await runTest('multiplayer_playtest closes test windows it cannot reach', async ({ track }) => {
  const client = track(new McpClient('multiplayer-test-windows'));
  await client.start();
  await client.initialize();
  const instanceId = await pickInstanceId(client);

  try {
    // The windows need seconds to register; a 1 s ready timeout gives up first.
    const failed = await client.callTool('multiplayer_playtest', {
      action: 'start',
      numPlayers: 1,
      ready_timeout_s: 1,
      instance_id: instanceId,
    });
    assert(failed.success === false, `a start that times out fails (${JSON.stringify(failed)})`);
    assert(failed.error === 'multiplayer_start_not_detected', `it reports undetected peers (${failed.error})`);
    assert(failed.teardownConfirmed === true, `MCP ends the abandoned attempt (${JSON.stringify(failed)})`);
    await assertNoTestWindows(client, instanceId, 'after the failed start');

    const start = await client.callTool('multiplayer_playtest', {
      action: 'start',
      numPlayers: 1,
      timeout: 60,
      instance_id: instanceId,
    });
    assert(start.success === true, `a new start succeeds after the failed one (${JSON.stringify(start)})`);
    assert(start.closedStaleTestWindows === undefined, 'the failed start left no window for the next start to close');

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

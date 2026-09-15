#!/usr/bin/env node
// Field report #11 (+ the instances half of #9): get_connected_instances returns playtest {active, mode, startedAt}
// plus windowTitle/processId for every instance.
// Evidence: active:false before play -> active:true, mode:"play", ISO startedAt during play -> false after stop;
// windowTitle contains the place name, processId is a positive integer.
import { McpClient, assert, runTest, waitForEditPeer } from '../lib/mcp-client.mjs';

const instanceId = process.env.MCP_INSTANCE_ID;
if (!instanceId) throw new Error('Run this test through the managed runner');

async function ourInstance(client, step) {
  const connected = await client.callTool('get_connected_instances', {});
  const instance = (connected.instances ?? []).find((entry) => entry.id === instanceId);
  console.log(JSON.stringify({ step, instance }));
  assert(instance, `get_connected_instances lists ${instanceId}`);
  return instance;
}

await runTest('field #11 get_connected_instances playtest + window', async ({ track }) => {
  const client = track(new McpClient('field-11-connected'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client, { timeoutMs: 120_000 });

  const idle = await ourInstance(client, 'before-play');
  assert(idle.playtest && typeof idle.playtest === 'object', 'playtest field present before play');
  assert(idle.playtest.active === false, 'playtest.active is false before play');
  assert(typeof idle.windowTitle === 'string' && idle.windowTitle.length > 0, `windowTitle is a string (got ${JSON.stringify(idle.windowTitle)})`);
  assert(idle.windowTitle.includes(idle.placeName), `windowTitle "${idle.windowTitle}" contains place name "${idle.placeName}"`);
  assert(Number.isSafeInteger(idle.processId) && idle.processId > 0, `processId is a positive integer (got ${JSON.stringify(idle.processId)})`);

  const started = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'start', mode: 'play', timeout: 60 }, 90_000);
  assert(started.success === true, 'start succeeds');
  try {
    const playing = await ourInstance(client, 'during-play');
    assert(playing.playtest.active === true, 'playtest.active is true during play');
    assert(playing.playtest.mode === 'play', `playtest.mode is "play" (got ${playing.playtest.mode})`);
    const startedAt = Date.parse(playing.playtest.startedAt);
    assert(Number.isFinite(startedAt), `playtest.startedAt is ISO (got ${playing.playtest.startedAt})`);
    assert(Math.abs(Date.now() - startedAt) < 120_000, 'playtest.startedAt is recent');
    assert(playing.processId === idle.processId, 'processId is stable across play');
  } finally {
    const stopped = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'stop', timeout: 30 }, 60_000);
    assert(stopped.success === true, 'stop succeeds');
  }

  const after = await ourInstance(client, 'after-stop');
  assert(after.playtest.active === false, 'playtest.active is false after stop');
  assert(after.playtest.mode === undefined && after.playtest.startedAt === undefined, 'no mode/startedAt when idle');
}).then((ok) => process.exit(ok ? 0 : 1));

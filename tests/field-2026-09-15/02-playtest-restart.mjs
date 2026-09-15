#!/usr/bin/env node
// Field report #2: solo_playtest action="restart" stops and starts in one call, preserves the mode, and runs
// the before_start Luau on the edit DataModel before the new session starts so the change is visible in it.
// Evidence: timings of the old 3-call cycle (stop -> execute_luau -> start) versus one restart call;
// eval_server_runtime sees the Part created by before_start.
import { McpClient, assert, runTest, waitForEditPeer } from '../lib/mcp-client.mjs';

const instanceId = process.env.MCP_INSTANCE_ID;
if (!instanceId) throw new Error('Run this test through the managed runner');

const PART_NAME = 'FieldRestartPart';
const BASELINE_PART_NAME = 'FieldRestartBaselinePart';

function playtestOf(connected) {
  const instance = (connected.instances ?? []).find((entry) => entry.id === instanceId);
  return instance?.playtest;
}

await runTest('field #2 solo_playtest restart', async ({ track }) => {
  const client = track(new McpClient('field-02-restart'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client, { timeoutMs: 120_000 });

  await client.callTool('execute_luau', {
    instance_id: instanceId, target: 'edit',
    code: `for _, name in ipairs({"${PART_NAME}", "${BASELINE_PART_NAME}"}) do local p = workspace:FindFirstChild(name) if p then p:Destroy() end end return true`,
  });

  const startAt = Date.now();
  const started = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'start', mode: 'play', timeout: 60 }, 90_000);
  const initialStartMs = Date.now() - startAt;
  console.log(JSON.stringify({ step: 'start', elapsedMs: initialStartMs, result: started }));
  assert(started.success === true, 'initial start succeeds');

  const baselineAt = Date.now();
  const baselineStop = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'stop', timeout: 30 }, 60_000);
  const baselineStopMs = Date.now() - baselineAt;
  assert(baselineStop.success === true, 'baseline stop succeeds');
  const baselineSyncAt = Date.now();
  const baselineSync = await client.callTool('execute_luau', {
    instance_id: instanceId, target: 'edit',
    code: `local p = Instance.new("Part") p.Name = "${BASELINE_PART_NAME}" p.Anchored = true p.Parent = workspace return p:GetFullName()`,
  });
  const baselineSyncMs = Date.now() - baselineSyncAt;
  assert(baselineSync.success === true, 'baseline execute_luau succeeds');
  const baselineStartAt = Date.now();
  const baselineStart = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'start', mode: 'play', timeout: 60 }, 90_000);
  const baselineStartMs = Date.now() - baselineStartAt;
  assert(baselineStart.success === true, 'baseline start succeeds');
  const baselineTotalMs = Date.now() - baselineAt;
  console.log(JSON.stringify({
    step: 'baseline-3-calls', calls: 3, stopMs: baselineStopMs, syncMs: baselineSyncMs, startMs: baselineStartMs, totalMs: baselineTotalMs,
  }));

  const restartAt = Date.now();
  const restart = await client.callTool('solo_playtest', {
    instance_id: instanceId,
    action: 'restart',
    timeout: 60,
    before_start: `local p = Instance.new("Part") p.Name = "${PART_NAME}" p.Anchored = true p.Position = Vector3.new(0, 20, 0) p.Parent = workspace return p:GetFullName()`,
  }, 120_000);
  const restartWallMs = Date.now() - restartAt;
  console.log(JSON.stringify({ step: 'restart-1-call', calls: 1, wallMs: restartWallMs, result: restart }));
  assert(restart.success === true, `restart succeeds: ${JSON.stringify(restart)}`);
  assert(restart.action === 'restart', 'restart echoes action');
  assert(restart.wasRunning === true, 'restart reports wasRunning=true while a playtest was active');
  assert(restart.mode === 'play', 'restart preserves the previous play mode when mode is omitted');
  assert(Number.isFinite(restart.stoppedInMs) && restart.stoppedInMs >= 0, 'restart reports stoppedInMs');
  assert(Number.isFinite(restart.startedInMs) && restart.startedInMs > 0, 'restart reports startedInMs');
  assert(Number.isFinite(restart.totalMs) && restart.totalMs <= 60_000, `restart totalMs within 60 s (got ${restart.totalMs})`);
  assert(restart.beforeStart && restart.beforeStart.success === true, 'before_start ran on the edit peer');
  assert(String(restart.beforeStart.returnValue) === `Workspace.${PART_NAME}`, `before_start output returned (got ${JSON.stringify(restart.beforeStart)})`);

  const seen = await client.callTool('eval_server_runtime', {
    instance_id: instanceId,
    code: `return workspace:FindFirstChild("${PART_NAME}") ~= nil and workspace:FindFirstChild("${BASELINE_PART_NAME}") ~= nil`,
  }, 30_000);
  console.log(JSON.stringify({ step: 'eval_server_runtime', result: seen }));
  assert(seen.ok === true && String(seen.result) === 'true', `new play session sees the Part written before start: ${JSON.stringify(seen)}`);

  const status = await client.callTool('get_connected_instances', { instance_id: instanceId });
  const playtest = playtestOf(status);
  console.log(JSON.stringify({ step: 'connected-after-restart', playtest }));
  assert(playtest?.active === true && playtest?.mode === 'play', 'play session is active after restart');

  const stopped = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'stop', timeout: 30 }, 60_000);
  assert(stopped.success === true, 'stop after restart succeeds');

  const idleRestartAt = Date.now();
  const idleRestart = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'restart', timeout: 60 }, 120_000);
  console.log(JSON.stringify({ step: 'restart-when-idle', wallMs: Date.now() - idleRestartAt, result: idleRestart }));
  assert(idleRestart.success === true, `idle restart is a plain start: ${JSON.stringify(idleRestart)}`);
  assert(idleRestart.wasRunning === false, 'idle restart reports wasRunning=false');
  assert(idleRestart.mode === 'play', 'idle restart reuses the last known mode');
  assert(idleRestart.stoppedInMs === 0, 'idle restart spends no time stopping');

  const finalStop = await client.callTool('solo_playtest', { instance_id: instanceId, action: 'stop', timeout: 30 }, 60_000);
  assert(finalStop.success === true, 'final stop succeeds');

  console.log(JSON.stringify({
    summary: {
      before: { calls: 3, totalMs: baselineTotalMs, startMs: baselineStartMs },
      after: { calls: 1, totalMs: restart.totalMs, stoppedInMs: restart.stoppedInMs, startedInMs: restart.startedInMs, wallMs: restartWallMs },
      initialStartMs,
    },
  }));
}).then((ok) => process.exit(ok ? 0 : 1));

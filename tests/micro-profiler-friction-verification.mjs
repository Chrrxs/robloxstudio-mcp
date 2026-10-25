#!/usr/bin/env node
// Diagnostic, opt-in: records facts behind capture_micro_profiler friction in a
// solo playtest. Run through:
//   node scripts/studio-test-profile.mjs run -- tests/run-all.mjs --managed --test micro-profiler-friction-verification.mjs
//
// A. Render rate vs MicroProfiler frames: counts RenderStepped/Heartbeat in the
//    client and Heartbeat in the server while a server capture runs, and lists
//    the capture's render-group timers with their call counts.
// B. A large client capture: a scope load in the client for 6 s, then whether
//    the client Peer survives copying the capture back.
// It records facts only; it fails only if an experiment cannot run.
// Output: MP_FRICTION_VERIFY <json>.

import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, routingPeers, runTest, startPlaytestAndWait } from './lib/mcp-client.mjs';

const COUNT_FRAMES = (seconds, renderStepped) => `
local RunService = game:GetService("RunService")
local counts = { heartbeat = 0, render = 0 }
local hb = RunService.Heartbeat:Connect(function() counts.heartbeat += 1 end)
local rs = ${renderStepped ? 'RunService.RenderStepped:Connect(function() counts.render += 1 end)' : 'nil'}
local started = os.clock()
task.wait(${seconds})
local elapsed = os.clock() - started
hb:Disconnect()
if rs then rs:Disconnect() end
return { elapsed = elapsed, heartbeat_fps = counts.heartbeat / elapsed, render_fps = counts.render / elapsed }`;

const SCOPE_LOAD = (marker, seconds, scopesPerFrame) => `
local marker = ${JSON.stringify(marker)}
task.spawn(function()
  local deadline = os.clock() + ${seconds}
  while os.clock() < deadline do
    for _ = 1, ${scopesPerFrame} do
      debug.profilebegin(marker)
      debug.profileend()
    end
    task.wait()
  end
end)
return true`;

function frameFacts(capture) {
  const pick = (rows, fields) => (rows ?? []).map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
  return {
    ok: capture.ok,
    error: capture.error,
    bytes: capture.capture?.bytes,
    method: capture.capture?.method,
    frame_summary: capture.frame_summary,
    analysis_window: capture.analysis_window,
    notes: capture.data_quality?.notes,
    timers: pick(capture.top_timers, ['name', 'group', 'count', 'count_per_s', 'active_frame_count', 'inclusive_us_per_s']),
    groups: pick(capture.top_groups, ['group', 'count', 'count_per_s', 'count_per_frame', 'active_frame_count']),
    threads: pick(capture.top_threads, ['thread_name', 'count', 'count_per_s', 'inclusive_us_per_s']),
  };
}

await runTest('MicroProfiler friction verification', async ({ track }) => {
  const client = track(new McpClient('micro-profiler-friction-verification'));
  const report = {};
  try {
    await client.start();
    await client.initialize();
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    await delay(2000);

    // A. Render rate against the capture's frames.
    const clientCounts = client.callTool('execute_luau', { target: 'client-1', code: COUNT_FRAMES(3, true) }, 20_000);
    const serverCounts = client.callTool('execute_luau', { target: 'server', code: COUNT_FRAMES(3, false) }, 20_000);
    const renderCapture = await client.callToolResult('capture_micro_profiler',
      { target: 'server', duration_ms: 3000, focus: 'render', max_timers: 25, min_total_us: 0, spike_frames: 1 }, 90_000);
    report.client_rates = JSON.parse((await clientCounts).returnValue);
    report.server_rates = JSON.parse((await serverCounts).returnValue);
    report.server_render_capture = frameFacts(renderCapture.body);

    const clientSmall = await client.callToolResult('capture_micro_profiler',
      { target: 'client-1', duration_ms: 1000, focus: 'render', max_timers: 25, min_total_us: 0, spike_frames: 0 }, 90_000);
    report.client_render_capture = frameFacts(clientSmall.body);

    // B. A large client capture under a scope load.
    const marker = 'RSMCP_FRICTION_LOAD';
    await client.callTool('execute_luau', { target: 'client-1', code: SCOPE_LOAD(marker, 9, 4000) }, 20_000);
    const started = Date.now();
    const large = await client.callToolResult('capture_micro_profiler',
      { target: 'client-1', duration_ms: 6000, filter: marker, min_total_us: 0, spike_frames: 0 }, 180_000);
    report.large_client_capture = {
      elapsed_ms: Date.now() - started,
      is_error: large.isError,
      error: large.body?.error,
      message: large.body?.message,
      detail: large.body?.detail,
      bytes: large.body?.capture?.bytes,
      stream: large.body?.capture?.stream ?? large.body?.recording?.stream,
      frame_summary: large.body?.frame_summary,
    };
    await delay(3000);
    report.roles_after_large_capture = routingPeers(await client.callTool('get_connected_instances', {})).map((peer) => peer.role);
  } finally {
    console.log(`MP_FRICTION_VERIFY ${JSON.stringify(report)}`);
    await client.callTool('solo_playtest', { action: 'stop' }, 30_000).catch(() => undefined);
  }
}).then((ok) => process.exit(ok ? 0 : 1));

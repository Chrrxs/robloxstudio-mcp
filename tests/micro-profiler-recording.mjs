#!/usr/bin/env node
// capture_micro_profiler records whole windows and hands agents a reusable capture:
// 1. Under a scope load that leaves Studio's live MicroProfiler history only
//    ~13 frames (~0.2 s), a 5 s capture still analyzes about 5 s: the plugin
//    records a LibMP stream instead of reading the live history at the end.
// 2. action=start / action=stop record around work triggered by other calls,
//    and the saved capture can be re-analyzed with action=analyze.
// 3. A solo client's capture is recorded through the server Peer of the same
//    Studio process, labelled as such, and reports whether Studio drew every frame.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, assert, routingPeers, runTest, startPlaytestAndWait } from './lib/mcp-client.mjs';

const LOAD_PAIRS = 5000;
const LONG_CAPTURE_MS = 5000;

// Keeps the execute_luau request open for the whole load: its temporary
// payload is destroyed on return, so detached work is not a reliable source.
function loadCode(seconds, marker) {
  return `
local RunService = game:GetService("RunService")
local frames = 0
local connection = RunService.Heartbeat:Connect(function()
  frames += 1
  for _ = 1, ${LOAD_PAIRS} do
    debug.profilebegin(${JSON.stringify(marker)})
    debug.profileend()
  end
end)
task.wait(${seconds})
connection:Disconnect()
return frames`;
}

function markedWorkCode(marker) {
  return `
local deadline = os.clock() + 0.5
local iterations = 0
while os.clock() < deadline do
  debug.profilebegin(${JSON.stringify(marker)})
  local started = os.clock()
  while os.clock() - started < 0.002 do end
  debug.profileend()
  iterations += 1
  task.wait()
end
return iterations`;
}

async function waitForRuntimePeersToDrain(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const peers = routingPeers(await client.callTool('get_connected_instances', {}));
    if (!peers.some((peer) => peer.role === 'server' || peer.role.startsWith('client-'))) return;
    await delay(250);
  }
}

function findTimer(capture, marker) {
  return capture.top_timers?.find((timer) => typeof timer.name === 'string' && timer.name.endsWith(marker));
}

await runTest('capture_micro_profiler records whole windows and reusable captures', async ({ track }) => {
  const client = track(new McpClient('micro-profiler-recording'));
  // Captures stay in the test snapshot's tmp/ for offline analysis.
  const artifactDirectory = path.join(process.cwd(), 'tmp', 'micro-profiler-recording');
  mkdirSync(artifactDirectory, { recursive: true });
  let playtestStarted = false;
  const pending = [];
  try {
    await client.start();
    await client.initialize();
    playtestStarted = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });

    // 1. A long capture under load covers its whole window.
    const loadMarker = `RSMCP_LOAD_${randomUUID().replaceAll('-', '')}`;
    const load = client.callTool('execute_luau', { target: 'server', code: loadCode(LONG_CAPTURE_MS / 1000 + 3, loadMarker) }, 60_000);
    pending.push(load);
    await delay(1000);
    const started = Date.now();
    const long = await client.callTool('capture_micro_profiler', {
      target: 'server', duration_ms: LONG_CAPTURE_MS, max_timers: 5, max_groups: 5,
      output_path: path.join(artifactDirectory, 'long.gprx'),
    }, 120_000);
    const elapsedMs = Date.now() - started;
    const window = long.analysis_window ?? {};
    console.log(`  long capture: method=${long.capture?.method} ${window.analyzed_frame_count} frames, ${window.coverage_pct}% of ${window.capture_wall_ms} ms, ${long.capture?.bytes} bytes, ${long.counts?.events} events, ${elapsedMs} ms end to end`);
    assert(long.ok === true && long.schema_version === 3, `long capture succeeds with schema 3 (${long.error ?? ''} ${long.message ?? ''})`);
    assert(long.capture?.method === 'stream', `the capture is a recorded stream (${JSON.stringify(long.capture)})`);
    assert(window.coverage_pct >= 90 && window.frames_dropped === 0,
      `a ${LONG_CAPTURE_MS} ms capture under load analyzes its whole window (${JSON.stringify(window)})`);
    assert(window.analysis_duration_us >= LONG_CAPTURE_MS * 900,
      `the analysis spans about ${LONG_CAPTURE_MS} ms (${window.analysis_duration_us} us)`);
    assert(long.capture?.path === path.join(artifactDirectory, 'long.gprx') && existsSync(long.capture.path) && statSync(long.capture.path).size === long.capture.bytes,
      `the raw capture is saved (${long.capture?.path})`);
    assert(Array.isArray(long.spike_frames) && long.spike_frames.length > 0 && long.spike_frames[0].hot_paths?.length > 0,
      'the slowest frames are broken down');
    const loadFrames = Number((await load).returnValue);
    assert(loadFrames > 0, `the load ran (${loadFrames} frames)`);

    // The saved capture re-analyzes without Studio, narrowed to the load scope.
    const reanalyzed = await client.callTool('capture_micro_profiler', {
      action: 'analyze', input_path: long.capture.path, filter: loadMarker, min_total_us: 0, spike_frames: 0,
    }, 60_000);
    const loadRow = findTimer(reanalyzed, loadMarker);
    assert(reanalyzed.ok === true && loadRow && loadRow.count_per_frame >= LOAD_PAIRS * 0.9,
      `action=analyze re-reads the saved capture (${JSON.stringify(loadRow ?? reanalyzed.error)})`);

    // 2. start/stop around work triggered by another call.
    const marker = `RSMCP_STARTSTOP_${randomUUID().replaceAll('-', '')}`;
    const startReply = await client.callTool('capture_micro_profiler', { action: 'start', target: 'server' }, 60_000);
    assert(startReply.ok === true && startReply.recording?.method === 'stream', `start opens a recording (${JSON.stringify(startReply)})`);
    const again = await client.callToolError('capture_micro_profiler', { action: 'start', target: 'server' }, 60_000);
    assert(again.error === 'micro_profiler_recording_active', `a second start is refused while recording (${again.error})`);
    const work = await client.callTool('execute_luau', { target: 'server', code: markedWorkCode(marker) }, 30_000);
    assert(work.success === true, 'the triggered work runs while recording');
    const stopped = await client.callTool('capture_micro_profiler', {
      action: 'stop', target: 'server', filter: marker, min_total_us: 0,
      output_path: path.join(artifactDirectory, 'start-stop.gprx'),
    }, 120_000);
    const markerRow = findTimer(stopped, marker);
    console.log(`  start/stop: ${work.returnValue} iterations, ${markerRow?.count} recorded, window ${JSON.stringify(stopped.analysis_window)}, quality ${JSON.stringify(stopped.data_quality)}`);
    assert(stopped.ok === true && markerRow && markerRow.count >= Number(work.returnValue) * 0.9,
      `stop analyzes the work done between start and stop (${JSON.stringify(markerRow ?? stopped.error)})`);
    const noRecording = await client.callToolError('capture_micro_profiler', { action: 'stop', target: 'server' }, 60_000);
    assert(noRecording.error === 'micro_profiler_no_recording', `stop without a recording explains itself (${noRecording.error})`);

    // 3. A solo client shares the Studio process with the server, so it is
    //    recorded through the server Peer instead of copied through the broker.
    const clientCapture = await client.callTool('capture_micro_profiler', { target: 'client-1', duration_ms: 1000, max_timers: 5 }, 120_000);
    console.log(`  client capture: ${clientCapture.capture?.bytes} bytes, ${clientCapture.analysis_window?.analyzed_frame_count} frames, presented ${clientCapture.frame_summary?.presented_fps} of ${clientCapture.frame_summary?.frames_per_second} fps`);
    assert(clientCapture.ok === true && clientCapture.target === 'client-1' && clientCapture.recorded_by === 'server'
      && clientCapture.capture?.bytes > 768 * 1024,
    `a solo client capture is recorded whole through the server Peer (${clientCapture.error ?? ''} ${clientCapture.message ?? ''})`);
    assert(clientCapture.process_roles?.includes('client-1') && clientCapture.process_roles?.includes('server')
      && clientCapture.data_quality?.notes?.some((note) => note.includes('records the whole process')),
    `a solo capture says its Studio process is shared (${JSON.stringify(clientCapture.process_roles)})`);
    assert(clientCapture.frame_summary?.presented_frames > 0 && typeof clientCapture.data_quality?.render_throttled === 'boolean',
      `a capture reports how many frames Studio drew (${JSON.stringify(clientCapture.frame_summary)})`);
  } finally {
    await Promise.allSettled(pending);
    if (playtestStarted) {
      await client.callTool('solo_playtest', { action: 'stop' }, 30_000).catch(() => undefined);
      await waitForRuntimePeersToDrain(client);
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

#!/usr/bin/env node
// Regression for issue #137 on a live server peer:
// 1. Times use the snapshot's clock. A server workload busy-waits a measured
//    5 ms (os.clock) inside a profiled scope; the tool must report about 5 ms.
//    Before the fix it read ticks as nanoseconds (4.7x too long on a 4.7 GHz
//    timer).
// 2. The tool leaves capture as it found it. Studio peers start paused; a peer
//    that something else keeps recording must still be recording afterwards.
// 3. Only frames recorded during the capture are analyzed, not earlier history
//    or the time a paused peer spent paused, and frames the engine's memory
//    budget dropped are reported instead of silently shortening the analysis.
// Capture state is driven and observed through a staged copy of LibMP. Raw
// snapshots go to tmp/micro-profiler-units-and-state/ (kept when a run fails).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, assert, routingPeers, runTest, startPlaytestAndWait } from './lib/mcp-client.mjs';
import { removeLibMP, runLibMP, stageLibMP } from './lib/micro-profiler-libmp-probe.mjs';

const BUSY_MS = 5;
const CAPTURE_MS = 1000;

function busyWaitCode(marker) {
  return `
local marker = ${JSON.stringify(marker)}
local deadline = os.clock() + 3
local samples, total = 0, 0
while os.clock() < deadline do
  debug.profilebegin(marker)
  local started = os.clock()
  while os.clock() - started < ${BUSY_MS / 1000} do end
  total += os.clock() - started
  debug.profileend()
  samples += 1
  task.wait()
end
return {samples = samples, avg_us = total / samples * 1e6}`;
}

async function waitForRuntimePeersToDrain(client, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const peers = routingPeers(await client.callTool('get_connected_instances', {}));
    if (!peers.some((peer) => peer.role === 'server' || peer.role.startsWith('client-'))) return;
    await delay(250);
  }
}

const COVERAGE_REASONS = ['capture_history_truncated', 'capture_coverage_below_requested', 'event_limit_hit'];

function assertNoSilentTruncation(capture, label) {
  const window = capture.analysis_window ?? {};
  const quality = capture.data_quality ?? {};
  const reasons = (quality.partial_reasons ?? []).filter((reason) => COVERAGE_REASONS.includes(reason));
  assert(window.coverage_pct >= 90 || reasons.length > 0,
    `${label}: analysis covers the capture or says why not (${window.coverage_pct}% of ${window.capture_wall_ms} ms, ${window.frames_evicted} frames dropped, reasons=${JSON.stringify(reasons)})`);
  if (quality.history_truncated === true) {
    assert(window.frames_evicted > 0 && quality.partial_reasons?.includes('capture_history_truncated'),
      `${label}: a truncated capture reports the dropped frames and is partial`);
  }
}

function assertCaptureWindow(capture, label) {
  const analyzedUs = capture.analysis_window?.analysis_duration_us;
  const truncated = capture.data_quality?.history_truncated === true;
  // Earlier history would add seconds; one capture covers about CAPTURE_MS, or
  // less when the engine's memory budget dropped frames (reported as truncated).
  assert(typeof analyzedUs === 'number' && analyzedUs < CAPTURE_MS * 1300 && (truncated || analyzedUs > CAPTURE_MS * 500),
    `${label}: analysis covers the capture, not earlier history (${analyzedUs} us for ${CAPTURE_MS} ms, truncated=${truncated})`);
  assertNoSilentTruncation(capture, label);
}

// The analysis window must hold only frames with work (no warm-up frames
// without scope events, no paused frame), and cover the capture unless the
// engine's memory budget dropped frames, which must then be reported. That
// budget varies: a fresh server peer has held anywhere from 40 to 76 frames.
function assertCompleteWindow(capture, label) {
  const window = capture.analysis_window ?? {};
  const quality = capture.data_quality ?? {};
  const reasons = quality.partial_reasons ?? [];
  assert(window.selected_frame_event_coverage_pct === 100
    && (window.coverage_pct >= 95 || (quality.history_truncated === true && window.frames_evicted > 0)),
    `${label}: the window holds the capture's frames with work (${window.coverage_pct}%, waited ${window.first_frame_wait_ms} ms for the first frame with events, reasons ${JSON.stringify(reasons)}, window ${JSON.stringify(window)})`);
}

await runTest('capture_micro_profiler converts ticks and preserves capture state', async ({ track }) => {
  const client = track(new McpClient('micro-profiler-units-and-state'));
  let playtestStarted = false;
  let staged = false;
  const pending = [];
  try {
    await client.start();
    await client.initialize();
    staged = true;
    await stageLibMP(client);
    playtestStarted = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });

    const initial = await runLibMP(client, 'server', 'return state()');
    assert(initial.recording === false, `a Studio server peer starts with capture paused (${JSON.stringify(initial)})`);

    // 0. The first capture in this Studio session (fresh when run alone; the
    //    first frames after capture starts carry no scope events).
    const first = await client.callTool('capture_micro_profiler', { target: 'server', duration_ms: CAPTURE_MS, max_events: 1_000_000 }, 60_000);
    assert(first.ok === true && first.capture_state?.was_recording === false, `first capture succeeds (${first.error ?? ''})`);
    assertCaptureWindow(first, 'first capture in the session');
    assertCompleteWindow(first, 'first capture in the session');

    // Later playtests in the same Studio process start with that capture's frames
    // still held by the engine, as in the full suite.
    await client.callTool('solo_playtest', { action: 'stop' }, 30_000);
    await waitForRuntimePeersToDrain(client);
    await delay(1000);
    await startPlaytestAndWait(client, { timeoutSec: 60 });

    // 1. Units, on a paused peer in a later playtest.
    const marker = `RSMCP_UNITS_${randomUUID().replaceAll('-', '')}`;
    const workload = client.callTool('execute_luau', { target: 'server', code: busyWaitCode(marker) }, 20_000);
    pending.push(workload);
    await delay(300);
    // max_events covers the whole capture under this workload (~4,400 events per
    // frame), so coverage below shows timing, not the event limit.
    const capture = await client.callTool('capture_micro_profiler', {
      target: 'server', duration_ms: CAPTURE_MS, filter: marker, min_total_us: 0, max_events: 1_000_000,
      output_path: path.join(process.cwd(), 'tmp', 'micro-profiler-units-and-state', 'first.mp'),
    }, 60_000);
    const measured = JSON.parse((await workload).returnValue);
    assert(capture.ok === true && capture.schema_version === 2, `capture succeeds with schema 2 (${capture.error ?? ''})`);
    assert(capture.clock?.tick_to_ms_cpu > 0, `capture reports its clock (${JSON.stringify(capture.clock)})`);
    const row = capture.top_timers?.find((timer) => typeof timer.name === 'string' && timer.name.endsWith(marker));
    assert(row, 'the profiled workload scope is captured');
    const ratio = row.avg_invocation_us / measured.avg_us;
    assert(Math.abs(ratio - 1) < 0.05,
      `scope time matches the measured ${measured.avg_us.toFixed(1)} us (tool ${row.avg_invocation_us} us, ratio ${ratio.toFixed(4)})`);
    assert(capture.capture_state?.was_recording === false, 'the tool reports the peer was paused');
    assertCaptureWindow(capture, 'paused peer in a later playtest');
    assertCompleteWindow(capture, 'first capture in a later playtest');
    const afterPaused = await runLibMP(client, 'server', 'return state()');
    assert(afterPaused.recording === false, 'a paused peer is paused again afterwards');

    // 1b. The same peer, paused for a while with that capture still retained.
    await delay(1500);
    const resumed = await client.callTool('capture_micro_profiler', {
      target: 'server',
      duration_ms: CAPTURE_MS,
      output_path: path.join(process.cwd(), 'tmp', 'micro-profiler-units-and-state', 'resumed.mp'),
    }, 60_000);
    assert(resumed.ok === true && resumed.capture_state?.was_recording === false,
      `capture after a pause succeeds and sees a paused peer (${resumed.error ?? ''})`);
    assertCaptureWindow(resumed, 'peer resumed after a pause');

    // 1c. A capture longer than the engine's memory budget can hold (about 70
    // frames on a server peer here): what is lost must be reported.
    const long = await client.callTool('capture_micro_profiler', { target: 'server', duration_ms: 3000 }, 60_000);
    assert(long.ok === true, `long capture succeeds (${long.error ?? ''})`);
    assertNoSilentTruncation(long, 'long capture');
    console.log(`  long capture: ${long.analysis_window?.coverage_pct}% of ${long.analysis_window?.capture_wall_ms} ms analyzed, ${long.analysis_window?.frames_evicted} frames dropped, truncated=${long.data_quality?.history_truncated}`);

    // 2. A peer that something else keeps recording, with history from before the call.
    await runLibMP(client, 'server', 'Control:EnableCapture(true) task.wait(1.5) return state()');
    const recordingCapture = await client.callTool('capture_micro_profiler', { target: 'server', duration_ms: CAPTURE_MS }, 60_000);
    assert(recordingCapture.ok === true, `capture on a recording peer succeeds (${recordingCapture.error ?? ''})`);
    assert(recordingCapture.capture_state?.was_recording === true, 'the tool reports the peer was recording');
    assertCaptureWindow(recordingCapture, 'recording peer');
    const afterRecording = await runLibMP(client, 'server', 'return state()');
    assert(afterRecording.recording === true, 'a recording peer keeps recording afterwards');
    await runLibMP(client, 'server', 'Control:EnableCapture(false) return true');
  } finally {
    await Promise.allSettled(pending);
    if (playtestStarted) {
      await client.callTool('solo_playtest', { action: 'stop' }, 30_000).catch(() => undefined);
      await waitForRuntimePeersToDrain(client);
    }
    if (staged) await removeLibMP(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));

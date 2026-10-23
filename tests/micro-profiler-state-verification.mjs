#!/usr/bin/env node
// Diagnostic for issue #137: records how the engine MicroProfiler behaves so
// capture_micro_profiler can leave a peer as it found it. Run through:
//   node scripts/studio-test-profile.mjs run -- tests/run-all.mjs --managed --test micro-profiler-state-verification.mjs
//
// LibMP cannot read the capture state or the frame limit, so experiments drive
// the engine through a staged copy of LibMP (tests/lib/micro-profiler-libmp-probe.mjs)
// and observe effects: a peer is "recording" when the newest FrameAbsoluteId
// moves between reads 0.3 s apart.
// It records facts only; it fails only if an experiment cannot run.
// Output: ISSUE137_VERIFY <json> and tmp/issue-137-verify/report.json.

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, routingPeers, runTest, startPlaytestAndWait } from './lib/mcp-client.mjs';
import { removeLibMP, runLibMP, stageLibMP } from './lib/micro-profiler-libmp-probe.mjs';

const EXPERIMENTS = {
  // Default flags, and what each flag does on its own.
  defaults: `
local out = {}
out.untouched = state()
Control:EnableCapture(true)
out.capture_only = state()
Control:EnableCapture(false)
out.after_capture_off = state()
Control:EnableProfiler(false)
Control:EnableCapture(true)
out.profiler_off_capture_on = state()
Control:EnableProfiler(true)
out.profiler_on_capture_on = state()
Control:EnableCapture(false)
out.back_to_default = state()
return out`,
  // History length with the engine's default frame limit (no SetFrameLimit yet).
  default_frame_limit: `
Control:EnableCapture(true)
local samples = {}
for _ = 1, 4 do
  task.wait(2)
  local sample = newest()
  table.insert(samples, { frames = sample.frames, bytes = sample.bytes })
end
Control:EnableCapture(false)
return { history_every_2s = samples }`,
  // How many frames (task.wait resumptions) until a recording peer shows a new frame.
  frame_latency: `
Control:EnableCapture(true)
task.wait(0.2)
local waits, reads = {}, {}
for _ = 1, 30 do
  local before = newest()
  table.insert(reads, before.read_ms)
  local count = 0
  repeat task.wait() count += 1 until newest().abs ~= before.abs or count >= 30
  table.insert(waits, count)
end
Control:EnableCapture(false)
return { waits_until_new_frame = waits, read_ms = reads }`,
  // Does changing the frame limit clear counter history (LibMP docs say so)?
  counter_history: `
local function counterSamples()
  local session = LibMP.Session.OpenFromBuffer(Control:CaptureToBufferSync())
  local id = session:FindCounterId("**/Luau/heap")
  if id == 0 then id = session:FetchCounterIds()[1] or 0 end
  local count = if id ~= 0 then #session:FetchCounterSamples(id) else -1
  session:Dispose()
  return count
end
Control:EnableCapture(true)
Control:SetFrameLimit(128)
task.wait(2)
local out = { after_2s = counterSamples() }
Control:SetFrameLimit(128)
out.after_same_limit = counterSamples()
Control:SetFrameLimit(129)
out.right_after_change = counterSamples()
task.wait(0.5)
out.half_second_after_change = counterSamples()
Control:EnableCapture(false)
return out`,
  set_recording: `
Control:EnableProfiler(true)
Control:EnableCapture(true)
task.wait(0.5)
return state()`,
  set_profiler_off: `
Control:EnableCapture(false)
Control:EnableProfiler(false)
return state()`,
  // Infers the profiler flag without a lasting change, assuming capture is off.
  profiler_flag: `
local untouched = state()
if untouched.recording then return { untouched = untouched } end
Control:EnableCapture(true)
local captureOnly = state()
Control:EnableCapture(false)
return { untouched = untouched, capture_only = captureOnly }`,
  observe: `return state()`,
  // Frame-limit semantics: does changing it clear history, and does the same value?
  frame_limit_semantics: `
local out = {}
Control:EnableProfiler(true)
Control:EnableCapture(true)
Control:SetFrameLimit(256)
task.wait(6)
out.limit_256_after_6s = newest()
Control:SetFrameLimit(256)
out.same_value_immediately = newest()
Control:SetFrameLimit(32)
out.lower_to_32_immediately = newest()
task.wait(1)
out.lower_to_32_after_1s = newest()
Control:SetFrameLimit(64)
out.raise_to_64_immediately = newest()
task.wait(2)
out.raise_to_64_after_2s = newest()
Control:EnableCapture(false)
return out`,
};

function busyWaitCode(marker) {
  return `
local marker = ${JSON.stringify(marker)}
local deadline = os.clock() + 3
local samples, total = 0, 0
while os.clock() < deadline do
  debug.profilebegin(marker)
  local started = os.clock()
  while os.clock() - started < 0.005 do end
  local elapsed = os.clock() - started
  debug.profileend()
  samples += 1
  total += elapsed
  task.wait()
end
return {samples = samples, avg_us = total / samples * 1e6}`;
}

async function experiment(client, target, name) {
  return runLibMP(client, target, EXPERIMENTS[name]);
}

function captureSummary(capture) {
  return {
    ok: capture.ok,
    error: capture.error,
    frames_considered: capture.counts?.frames_considered,
    analyzed_frame_count: capture.analysis_window?.analyzed_frame_count,
    analysis_duration_us: capture.analysis_window?.analysis_duration_us,
    was_recording: capture.capture_state?.was_recording,
  };
}

async function unitsCheck(client, target) {
  const marker = `RSMCP_VERIFY_UNITS_${randomUUID().replaceAll('-', '')}`;
  const workload = client.callTool('execute_luau', { target, code: busyWaitCode(marker) }, 20_000);
  await delay(300);
  const capture = await client.callTool('capture_micro_profiler', { target, duration_ms: 1000, frame_window: 64, filter: marker, min_total_us: 0 }, 60_000);
  const measured = JSON.parse((await workload).returnValue);
  const row = capture.top_timers?.find((timer) => typeof timer.name === 'string' && timer.name.endsWith(marker));
  return { measured_avg_us: measured.avg_us, tool_avg_invocation_us: row?.avg_invocation_us, ratio: row ? row.avg_invocation_us / measured.avg_us : undefined };
}

async function toolOnState(client, target, setup, report, key) {
  const entry = {};
  report[key] = entry;
  entry.before = await experiment(client, target, setup);
  entry.capture = captureSummary(await client.callTool('capture_micro_profiler', { target, duration_ms: 1000 }, 60_000));
  entry.after = await experiment(client, target, 'profiler_flag');
}

async function waitForRuntimePeersToDrain(client, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const peers = routingPeers(await client.callTool('get_connected_instances', {}));
    if (!peers.some((peer) => peer.role === 'server' || peer.role.startsWith('client-'))) return;
    await delay(250);
  }
}

await runTest('issue #137: MicroProfiler state verification', async ({ track }) => {
  const client = track(new McpClient('micro-profiler-state-verification'));
  const report = { solo_server: {}, multiplayer_client: {} };
  const artifactDirectory = path.join(process.cwd(), 'tmp', 'issue-137-verify');
  mkdirSync(artifactDirectory, { recursive: true });
  let soloStarted = false;
  let multiplayerStarted = false;
  try {
    await client.start();
    await client.initialize();
    await stageLibMP(client);

    // Part A: solo playtest, server peer (one Studio process).
    soloStarted = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    const solo = report.solo_server;
    solo.defaults = await experiment(client, 'server', 'defaults');
    solo.default_frame_limit = await experiment(client, 'server', 'default_frame_limit');
    solo.frame_latency = await experiment(client, 'server', 'frame_latency');
    await toolOnState(client, 'server', 'set_recording', solo, 'tool_on_recording_peer');
    await toolOnState(client, 'server', 'set_profiler_off', solo, 'tool_on_profiler_off_peer');
    solo.frame_limit_semantics = await experiment(client, 'server', 'frame_limit_semantics');
    solo.units = await unitsCheck(client, 'server');
    await client.callTool('solo_playtest', { action: 'stop' }, 30_000);
    soloStarted = false;
    await waitForRuntimePeersToDrain(client);
    await delay(1000);

    // Part B: multiplayer playtest, client-1 (its own Studio process).
    multiplayerStarted = true;
    const started = await client.callTool('multiplayer_playtest', { action: 'start', numPlayers: 1, timeout: 90 }, 120_000);
    if (started.success !== true) throw new Error(`multiplayer start failed: ${JSON.stringify(started)}`);
    const mp = report.multiplayer_client;
    mp.default_frame_limit = await experiment(client, 'client-1', 'default_frame_limit');
    mp.defaults = await experiment(client, 'client-1', 'defaults');
    mp.frame_latency = await experiment(client, 'client-1', 'frame_latency');
    mp.counter_history = await experiment(client, 'client-1', 'counter_history');
    await toolOnState(client, 'client-1', 'observe', mp, 'tool_on_default_peer');
    await toolOnState(client, 'client-1', 'set_recording', mp, 'tool_on_recording_peer');
    mp.units = await unitsCheck(client, 'client-1');
  } finally {
    console.log(`ISSUE137_VERIFY ${JSON.stringify(report)}`);
    writeFileSync(path.join(artifactDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (soloStarted) {
      await client.callTool('solo_playtest', { action: 'stop' }, 30_000).catch(() => undefined);
      await waitForRuntimePeersToDrain(client).catch(() => undefined);
    }
    if (multiplayerStarted) {
      await client.callTool('multiplayer_playtest', { action: 'end', timeout: 45 }, 60_000).catch(() => undefined);
      await waitForRuntimePeersToDrain(client).catch(() => undefined);
    }
    await removeLibMP(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));

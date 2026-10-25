#!/usr/bin/env node
// Diagnostic: records how much MicroProfiler history a capture can reach, so
// capture_micro_profiler can record a whole requested window. Run through:
//   node scripts/studio-test-profile.mjs run -- tests/run-all.mjs --managed --test micro-profiler-recording-verification.mjs
//
// Experiments drive the engine through a staged copy of the bundled LibMP
// (tests/lib/micro-profiler-libmp-probe.mjs) under a synthetic scope load, and
// compare the live-data snapshot, the memory target, and streamed recordings.
// It records facts only; it fails only if an experiment cannot run.
// Output: MP_RECORDING_VERIFY <json> and tmp/micro-profiler-recording-verify/report.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpClient, runTest, startPlaytestAndWait } from './lib/mcp-client.mjs';
import { removeLibMP, runLibMP, stageLibMP } from './lib/micro-profiler-libmp-probe.mjs';

// About 10k scope events per frame, like a busy UI client.
const LOAD_PAIRS = 5000;

const HELPERS = `
local RunService = game:GetService("RunService")
local V1 = LibMP.Experimental and LibMP.Experimental.V1
local function startLoad(pairCount)
  if pairCount <= 0 then return function() end end
  local connection = RunService.Heartbeat:Connect(function()
    for _ = 1, pairCount do
      debug.profilebegin("RSMCP_RECORDING_LOAD")
      debug.profileend()
    end
  end)
  return function() connection:Disconnect() end
end
local function describe(session)
  local out = {}
  if not session then out.open = false return out end
  out.valid = session:IsValid()
  if not out.valid then session:Dispose() return out end
  local ok, err = pcall(function()
    out.tracks = session:GetTrackCount()
    if out.tracks > 0 then
      local segments = session:FetchSegments(0)
      out.segments = #segments
      local list = {}
      local frames, gaps = 0, 0
      local previousEndAbsolute
      for index, segment in segments do
        local count = segment.FrameIdEnd - segment.FrameIdBegin + 1
        frames += count
        local beginAbsolute = segment.FrameAbsoluteIdBegin
        if previousEndAbsolute ~= nil and beginAbsolute ~= previousEndAbsolute + 1 then gaps += 1 end
        previousEndAbsolute = beginAbsolute + count - 1
        if index <= 3 or index == #segments then
          table.insert(list, { index = index, frame_begin = segment.FrameIdBegin, frame_end = segment.FrameIdEnd, abs_begin = beginAbsolute, markers = segment.Markers })
        end
      end
      out.segment_frames = frames
      out.segment_abs_gaps = gaps
      out.segment_samples = list
      session:SelectTrack(0)
    end
    local minId, maxId = session:GetFrameIdMin(), session:GetFrameIdMax()
    out.frame_min, out.frame_max = minId, maxId
    out.frames = if maxId > 0 then maxId - minId + 1 else 0
    if maxId > 0 then
      local clock = session:FetchGlobalDesc()
      local first, last = session:FetchFrameDesc(minId), session:FetchFrameDesc(maxId)
      out.span_ms = (last.TickEndCpu - first.TickStartCpu) * clock.TickToMsCpu
      out.abs_min, out.abs_max = first.FrameAbsoluteId, last.FrameAbsoluteId
    end
  end)
  if not ok then out.describe_error = tostring(err) end
  session:Dispose()
  return out
end
local function snap(params)
  local started = os.clock()
  local ok, data = pcall(function() return Control:CaptureToBufferSync(params) end)
  local out = { capture_ms = (os.clock() - started) * 1000 }
  if not ok or data == nil then out.error = tostring(data) return out end
  out.bytes = buffer.len(data)
  local session = LibMP.Session.OpenFromBuffer(data)
  out.session = describe(session)
  return out
end
-- Luau iteration rate inside Studio, for sizing in-plugin analysis.
local function iterationRate(session, budgetEvents)
  local minId, maxId = session:GetFrameIdMin(), session:GetFrameIdMax()
  local iterator = session:CreateLogIterator()
  iterator:Configure({ SkipGpuThreads = true, SkipEvents = true, SkipPausedFrames = true, SkipFrameBoundaries = true })
  local state = iterator:GetState()
  iterator:RewindTo(minId, maxId)
  local events, started, slices = 0, os.clock(), os.clock()
  while events < budgetEvents and iterator:Step() do
    events += 1
    if state:IsEnter() then end
    state:TimerId() state:ThreadId() state:Timestamp() state:FrameId()
    if events % 2048 == 0 and os.clock() - slices > 0.008 then task.wait() slices = os.clock() end
  end
  local elapsed = os.clock() - started
  iterator:Dispose()
  return { events = events, elapsed_s = elapsed }
end
local function streamStatus()
  if not V1 then return nil end
  local ok, status = pcall(V1.GetStreamStatus)
  return if ok then status else tostring(status)
end
`;

const EXPERIMENTS = {
  api: `
return {
  versions = { library = LibMP.Versions.Library, data_format = LibMP.Versions.DataFormat },
  backend = { accessible = Control:IsBackendAccessible(), ready = Control:IsBackendReady(), compatible = Control:IsBackendVersionCompatible() },
  has_mem_target = Control.SetMemTargetMB ~= nil,
  has_v1 = V1 ~= nil,
  stream_status = streamStatus(),
}`,
  // Live snapshot retention after 5 s of recording, idle and under load.
  retention: (pairCount) => `
local stop = startLoad(${pairCount})
Control:SetFrameLimit(256)
Control:EnableCapture(true)
task.wait(5)
local out = { raw = snap(), compressed = snap({ ContainerFormat = LibMP.Enums.ContainerFormat.Compressed }) }
Control:EnableCapture(false)
stop()
return out`,
  // Does a higher memory target keep more frames?
  mem_target: `
local stop = startLoad(${LOAD_PAIRS})
Control:SetFrameLimit(256)
local out = {}
for _, mb in { 16, 64, 256 } do
  local ok, result = pcall(function() return Control:SetMemTargetMB(mb) end)
  out["set_" .. mb] = if ok then result else tostring(result)
  Control:EnableCapture(true)
  task.wait(5)
  out["mb_" .. mb] = snap()
  Control:EnableCapture(false)
end
stop()
return out`,
  // Streams record past the live window; check frames, continuity, and size.
  memory_stream: (captureOn) => `
local stop = startLoad(${LOAD_PAIRS})
local out = { capture_on = ${captureOn ? 'true' : 'false'} }
${captureOn ? 'Control:EnableCapture(true)' : ''}
out.status_before = streamStatus()
local okStart, started = pcall(V1.StartMemoryStream, 1)
out.start = if okStart then started else tostring(started)
task.wait(0.2)
out.status_0_2s = streamStatus()
task.wait(6)
out.status_6s = streamStatus()
local okStop, stopped = pcall(V1.StopStream)
out.stop = if okStop then stopped else tostring(stopped)
local waitStarted = os.clock()
local frames = 0
repeat
  task.wait()
  frames += 1
  local status = streamStatus()
until (type(status) == "table" and status.Active == false) or os.clock() - waitStarted > 5
out.finalize_frames = frames
out.finalize_ms = (os.clock() - waitStarted) * 1000
out.status_after = streamStatus()
task.wait()
local slotSession = LibMP.Session.OpenFromSlot(1)
out.slot = describe(slotSession)
local saveStarted = os.clock()
local okSave, saved = pcall(function() return Control:SaveSlotToBuffer(1) end)
out.save_ms = (os.clock() - saveStarted) * 1000
if okSave and saved then
  out.slot_bytes = buffer.len(saved)
  local fromBuffer = LibMP.Session.OpenFromBuffer(saved)
  out.from_buffer = describe(fromBuffer)
  local rateSession = LibMP.Session.OpenFromBuffer(saved)
  if rateSession and rateSession:IsValid() then
    local okRate, rate = pcall(iterationRate, rateSession, 300000)
    out.luau_iteration = if okRate then rate else tostring(rate)
    rateSession:Dispose()
  end
else
  out.save_error = tostring(saved)
end
out.reset = Control:ResetSlot(1)
${captureOn ? 'Control:EnableCapture(false)' : ''}
stop()
return out`,
  // Studio file stream into a slot; reports the slot contents.
  file_stream: `
local stop = startLoad(${LOAD_PAIRS})
local out = {}
local okStart, started = pcall(V1.StartFileStream, "rsmcpverify", 2)
out.start = if okStart then started else tostring(started)
task.wait(3)
out.status_3s = streamStatus()
out.stop = V1.StopStream()
local waitStarted = os.clock()
repeat task.wait() local status = streamStatus() until (type(status) == "table" and status.Active == false) or os.clock() - waitStarted > 5
out.finalize_ms = (os.clock() - waitStarted) * 1000
task.wait()
out.slot = describe(LibMP.Session.OpenFromSlot(2))
local okSave, saved = pcall(function() return Control:SaveSlotToBuffer(2) end)
out.slot_bytes = if okSave and saved then buffer.len(saved) else tostring(saved)
out.reset = Control:ResetSlot(2)
stop()
return out`,
  // How current is a stream when it is stopped? Each Heartbeat runs a scope
  // numbered by Heartbeat count, so the newest numbered scope in the recording
  // shows how many frames before StopStream the stream ends.
  stream_tail: (pairCount, settleFrames) => `
local stop = startLoad(${pairCount})
local out = { settle_frames = ${settleFrames} }
Control:EnableCapture(true)
V1.StartMemoryStream(1)
task.wait(0.3)
local marks = 0
local connection = RunService.Heartbeat:Connect(function()
  marks += 1
  debug.profilebegin("RSMCP_TAIL_" .. marks)
  debug.profileend()
end)
task.wait(1)
out.mark_at_stop_call = marks
out.abs_at_stop_call = streamStatus().AbsoluteFrameId
for _ = 1, ${settleFrames} do task.wait() end
out.mark_at_stop = marks
out.status_at_stop = streamStatus()
V1.StopStream()
local waitStarted = os.clock()
repeat task.wait() local status = streamStatus() until (type(status) == "table" and status.Active == false) or os.clock() - waitStarted > 5
out.mark_at_inactive = marks
connection:Disconnect()
task.wait()
local session = LibMP.Session.OpenFromSlot(1)
local maxMark, newestAbs, frames = 0, 0, 0
if session and session:IsValid() and session:GetTrackCount() > 0 and session:SelectTrack(0) then
  local segments = session:FetchSegments(0)
  for index, segment in segments do
    session:SelectSegment(index - 1)
    local last = session:FetchFrameDesc(segment.FrameIdEnd)
    if last then newestAbs = math.max(newestAbs, last.FrameAbsoluteId) end
    frames += segment.FrameIdEnd - segment.FrameIdBegin + 1
    local iterator = session:CreateLogIterator()
    iterator:Configure({ SkipGpuThreads = true, SkipEvents = true, SkipFrameBoundaries = true })
    local state = iterator:GetState()
    iterator:RewindTo(segment.FrameIdBegin, segment.FrameIdEnd)
    local names = {}
    while iterator:Step() do
      if state:IsEnter() then
        local timerId = state:TimerId()
        local name = names[timerId]
        if name == nil then
          name = session:FetchTimerDesc(timerId).TimerName or ""
          names[timerId] = name
        end
        local mark = tonumber(string.match(name, "RSMCP_TAIL_(%d+)"))
        if mark and mark > maxMark then maxMark = mark end
      end
    end
    iterator:Dispose()
  end
end
if session then session:Dispose() end
out.max_mark_in_stream = maxMark
out.stream_newest_abs = newestAbs
out.stream_frames = frames
Control:ResetSlot(1)
Control:EnableCapture(false)
stop()
return out`,
};

async function run(client, target, code, timeoutMs = 90_000) {
  try {
    return await runLibMP(client, target, HELPERS + code, timeoutMs);
  } catch (error) {
    return { failed: String(error?.message ?? error).slice(0, 2000) };
  }
}

await runTest('MicroProfiler recording verification', async ({ track }) => {
  const client = track(new McpClient('micro-profiler-recording-verification'));
  const report = {};
  const artifactDirectory = path.join(process.cwd(), 'tmp', 'micro-profiler-recording-verify');
  mkdirSync(artifactDirectory, { recursive: true });
  let started = false;
  try {
    await client.start();
    await client.initialize();
    await stageLibMP(client);
    started = true;
    await startPlaytestAndWait(client, { timeoutSec: 60 });
    for (const target of ['server', 'client-1']) {
      const peer = {};
      report[target] = peer;
      // MP_VERIFY_ONLY=stream_tail runs just the stream-tail experiments.
      if (process.env.MP_VERIFY_ONLY !== 'stream_tail') {
        peer.api = await run(client, target, EXPERIMENTS.api);
        peer.retention_idle = await run(client, target, EXPERIMENTS.retention(0));
        peer.retention_load = await run(client, target, EXPERIMENTS.retention(LOAD_PAIRS));
        peer.memory_stream_capture_paused = await run(client, target, EXPERIMENTS.memory_stream(false));
        peer.memory_stream_capture_on = await run(client, target, EXPERIMENTS.memory_stream(true));
        peer.file_stream = await run(client, target, EXPERIMENTS.file_stream);
        peer.mem_target = await run(client, target, EXPERIMENTS.mem_target);
        peer.retention_load_after_mem_target = await run(client, target, EXPERIMENTS.retention(LOAD_PAIRS));
      }
      peer.stream_tail_idle = await run(client, target, EXPERIMENTS.stream_tail(0, 0));
      peer.stream_tail_load = await run(client, target, EXPERIMENTS.stream_tail(LOAD_PAIRS, 0));
      peer.stream_tail_load_settled = await run(client, target, EXPERIMENTS.stream_tail(LOAD_PAIRS, 6));
      console.log(`MP_RECORDING_VERIFY_${target} ${JSON.stringify(peer)}`);
    }
  } finally {
    console.log(`MP_RECORDING_VERIFY ${JSON.stringify(report)}`);
    writeFileSync(path.join(artifactDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (started) {
      await client.callTool('solo_playtest', { action: 'stop' }, 30_000).catch(() => undefined);
    }
    await removeLibMP(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));

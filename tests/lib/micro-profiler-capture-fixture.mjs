import { readFileSync } from 'node:fs';

const handlerSource = readFileSync(new URL('../../studio-plugin/out/modules/handlers/MicroProfilerHandlers.luau', import.meta.url), 'utf8');

// Exercise the compiled production handler, not a copy of its capture sequence,
// against a fake MicroProfiler engine that follows what was measured in Studio
// (issue #137):
// - Studio peers start paused with no frames. Enabling capture starts recording;
//   on a fresh peer enabling only the profiler does too.
// - Reads while recording return fresh data; paused reads return the snapshot
//   cached by the last read made while recording.
//   (https://github.com/Roblox/libmp/blob/main/docs/SKILL.md)
// - Frame absolute IDs keep counting; SetFrameLimit narrows the retained view.
// - Frame IDs run on without gaps; a memory budget can drop the oldest frames
//   well below the frame limit (about 70 frames on a loaded server peer).
// - The first frame can arrive several frames after EnableCapture, and the
//   first frames can carry no scope events yet (frames 1-5 on a fresh peer).
// - Ticks are not nanoseconds: GlobalDesc.TickToMsCpu converts CPU ticks and
//   TickToMsGpu converts GPU-thread ticks (4.70 GHz and 1 GHz measured live).
// Simulated time drives task.wait and os.clock, so no scenario busy-waits.
export const microProfilerCaptureFixtureCode = `
local TICK_TO_MS_CPU = 2.127717e-7
local TICK_TO_MS_GPU = 1e-6
local FRAME_MS, CPU_SCOPE_MS, GPU_SCOPE_MS = 4, 1, 0.5
local CAPTURE_MS = 200
local CAPTURE_FRAMES = CAPTURE_MS / FRAME_MS

local function ticks(ms, tickToMs) return math.floor(ms / tickToMs + 0.5) end

local failures = {}
local function scenario(name, options, request, check)
  local ok, err = pcall(function()
  local now = 0
  local engine = { capturing = false, frameLimit = 77, frames = {}, nextAbsolute = 500, cache = {}, opened = 0, disposed = 0, reads = 0, exportReads = 0, durationWaited = false, pausedAt = 0, lag = 0, warmup = 0 }
  local snapshots = {}

  local addPausedFrame
  local function addFrames(count, history)
    if not engine.capturing or (options.rendersFrames == false and not history) then return end
    for _ = 1, count do
      if engine.lag > 0 then
        engine.lag -= 1
        continue
      end
      local absolute = engine.nextAbsolute
      engine.nextAbsolute += 1
      local startCpu = 7e10 + absolute * ticks(FRAME_MS, TICK_TO_MS_CPU)
      local startGpu = 1.7e15 + absolute * ticks(FRAME_MS, TICK_TO_MS_GPU)
      if engine.pendingPaused and #engine.frames > 0 and engine.frames[#engine.frames].afterResume then
        engine.pendingPaused = false
        addPausedFrame()
      end
      local eventless = engine.warmup > 0
      if eventless then engine.warmup -= 1 end
      table.insert(engine.frames, {
        absolute = absolute, eventless = eventless, afterResume = engine.pendingPaused,
        startCpu = startCpu, endCpu = startCpu + ticks(FRAME_MS, TICK_TO_MS_CPU),
        startGpu = startGpu, endGpu = startGpu + ticks(FRAME_MS, TICK_TO_MS_GPU),
      })
    end
  end
  local function visibleFrames()
    local all, out = engine.frames, {}
    local held = math.min(engine.frameLimit, options.memoryFrames or math.huge)
    for index = math.max(1, #all - held + 1), #all do
      table.insert(out, { id = index, frame = all[index] })
    end
    return out
  end

  -- Resuming after a pause records one IsPaused frame spanning the pause, and
  -- absolute IDs skip the frames rendered meanwhile (observed live).
  function addPausedFrame()
    local absolute = engine.nextAbsolute
    engine.nextAbsolute += 60
    local pausedMs = (now - engine.pausedAt) * 1000 + 1000
    local startCpu = 7e10 + absolute * ticks(FRAME_MS, TICK_TO_MS_CPU)
    local startGpu = 1.7e15 + absolute * ticks(FRAME_MS, TICK_TO_MS_GPU)
    table.insert(engine.frames, {
      absolute = absolute, paused = true,
      startCpu = startCpu, endCpu = startCpu + ticks(pausedMs, TICK_TO_MS_CPU),
      startGpu = startGpu, endGpu = startGpu + ticks(pausedMs, TICK_TO_MS_GPU),
    })
  end
  local function resume()
    if #engine.frames == 0 then return end
    -- Option: the paused frame lands after the first new frame (not observed, but
    -- not ruled out across playtests), so it falls inside the analysis window.
    if options.pausedFrameLate then
      engine.pendingPaused = true
    else
      addPausedFrame()
    end
  end

  -- Recording starts late and its first frames can carry no events.
  local function startRecording()
    resume()
    engine.lag = options.startLagFrames or 0
    engine.warmup = options.warmupFrames or 0
    engine.capturing = true
  end

  -- Earlier history: frames retained from a capture before this call.
  engine.capturing = true
  addFrames(options.history or 0, true)
  engine.cache = visibleFrames()
  engine.capturing = options.recording == true
  engine.fresh = not engine.capturing and #engine.frames == 0

  local function openSnapshot(data)
    engine.opened += 1
    local view = snapshots[buffer.readu32(data, 0)]
    local byId = {}
    for _, entry in view do byId[entry.id] = entry.frame end
    local minId = if #view > 0 then view[1].id else 0
    local maxId = if #view > 0 then view[#view].id else 0
    -- Like LibMP, any later Get/Fetch call on the session invalidates a
    -- GetFrameDesc view; a stale view reads zeros (observed live).
    local epoch = 0
    local function touch() epoch += 1 end
    local function frameView(id)
      touch()
      local frame = byId[id]
      if frame == nil then return nil end
      local created = epoch
      local function read(value) return if epoch == created then value else 0 end
      return {
        FrameId = function() return read(id) end,
        FrameAbsoluteId = function() return read(frame.absolute) end,
        TickStartCpu = function() return read(frame.startCpu) end,
        TickEndCpu = function() return read(frame.endCpu) end,
        IsIncomplete = function() return false end,
        IsPaused = function() return epoch == created and frame.paused == true end,
      }
    end
    return {
      IsValid = function() return true end,
      GetDataFormatVersion = function() return 65536 end,
      GetObjSize = function() return 4 end,
      FetchTimerIds = function() touch() return {1, 2} end,
      FetchThreadIds = function() touch() return {1, 2} end,
      FetchTimerDesc = function(_, id) touch() return {TimerId = id, TimerName = if id == 1 then 'CpuWork' else 'GpuWork', GroupId = id} end,
      FetchThreadDesc = function(_, id) touch() return {ThreadId = id, ThreadName = if id == 1 then 'Main' else 'GPU', IsGpu = id == 2} end,
      FetchGroupDesc = function(_, id) touch() return {GroupId = id, GroupName = if id == 1 then 'Fixture' else 'GPU', IsGpu = id == 2} end,
      FindGroupIds = function() return {} end,
      FetchGlobalDesc = function()
        touch()
        if options.noClock then return {TickToMsCpu = 0, TickToMsGpu = 0} end
        return {TickToMsCpu = TICK_TO_MS_CPU, TickToMsGpu = TICK_TO_MS_GPU}
      end,
      GetFrameIdMin = function() touch() return minId end,
      GetFrameIdMax = function() touch() return maxId end,
      GetFrameDesc = function(_, id) return frameView(id) end,
      CreateLogIterator = function()
        local config, events, index, current = {}, nil, 0, nil
        local state = {
          FrameId = function() return current.frame end,
          ThreadId = function() return current.thread end,
          TimerId = function() return current.timer end,
          Timestamp = function() return current.ts end,
          IsEnter = function() return current.enter end,
          IsExit = function() return not current.enter end,
          IsGpuThread = function() return current.thread == 2 end,
        }
        local function build()
          events = {}
          for id = math.max(minId, config.StartFrameId or minId), math.min(maxId, config.EndFrameId or maxId) do
            local frame = byId[id]
            if frame.paused and config.SkipPausedFrames then continue end
            if frame.eventless then continue end
            local cpu = frame.startCpu + 1000
            table.insert(events, {frame = id, thread = 1, timer = 1, enter = true, ts = cpu})
            table.insert(events, {frame = id, thread = 1, timer = 1, enter = false, ts = cpu + ticks(CPU_SCOPE_MS, TICK_TO_MS_CPU)})
            -- Optional busy frames: many short scopes on a second timer.
            for scope = 2, options.scopesPerFrame or 1 do
              local at = cpu + ticks(CPU_SCOPE_MS, TICK_TO_MS_CPU) + scope * 100
              table.insert(events, {frame = id, thread = 1, timer = 3, enter = true, ts = at})
              table.insert(events, {frame = id, thread = 1, timer = 3, enter = false, ts = at + 50})
            end
            if not config.SkipGpuThreads then
              local gpu = frame.startGpu + 10
              table.insert(events, {frame = id, thread = 2, timer = 2, enter = true, ts = gpu})
              table.insert(events, {frame = id, thread = 2, timer = 2, enter = false, ts = gpu + ticks(GPU_SCOPE_MS, TICK_TO_MS_GPU)})
            end
          end
        end
        return {
          Configure = function(_, value) config = value end,
          Step = function()
            if events == nil then build() end
            index += 1
            current = events[index]
            return current ~= nil
          end,
          GetState = function() return state end,
          Dispose = function() end,
        }
      end,
      Dispose = function() engine.disposed += 1 end,
    }
  end

  local LibMP = {
    Versions = {Library = 65536, DataFormat = 65536},
    Control = {
      IsBackendAccessible = function() return true end,
      IsBackendReady = function() return true end,
      IsBackendVersionCompatible = function() return true end,
      EnableProfiler = function(_, enabled)
        if enabled and engine.fresh then startRecording() end
        engine.fresh = false
        return true
      end,
      SetFrameLimit = function(_, value)
        assert(value > 0 and value <= 256, 'native rolling frame limit is at most 256')
        engine.frameLimit = value
        return true
      end,
      EnableCapture = function(_, enabled)
        engine.fresh = false
        if enabled and not engine.capturing then startRecording() end
        if not enabled and engine.capturing then engine.pausedAt = now end
        engine.capturing = enabled
        return true
      end,
      CaptureToBufferSync = function()
        engine.reads += 1
        if engine.durationWaited then
          engine.exportReads += 1
          if options.exportFails then error('fixture export failed') end
        end
        if engine.capturing then engine.cache = visibleFrames() end
        table.insert(snapshots, engine.cache)
        local data = buffer.create(4)
        buffer.writeu32(data, 0, #snapshots)
        return data
      end,
    },
    Session = {OpenFromBuffer = openSnapshot},
  }
  local libModule = {IsA = function(_, class) return class == 'ModuleScript' end}
  local include = {RuntimeLib = {}, FindFirstChild = function(_, childName) return if childName == 'LibMP' then libModule else nil end}
  local root = {include = include, FindFirstChild = function(_, childName) return if childName == 'include' then include else nil end}
  local script = {Parent = {Parent = {Parent = root}}}
  local require = function(module)
    if module == libModule then return LibMP end
    assert(module == include.RuntimeLib)
    return {import = function() return {RunService = {IsRunning = function() return true end}} end}
  end
  local task = {wait = function(seconds)
    local elapsed = if seconds and seconds > 0 then seconds else FRAME_MS / 1000
    now += elapsed
    if seconds and seconds >= CAPTURE_MS / 1000 then engine.durationWaited = true end
    addFrames(math.max(1, math.floor(elapsed * 1000 / FRAME_MS + 0.5)))
  end}
  local os = {clock = function() return now end}
  local handler = (function()
${handlerSource}
  end)()
  local result = handler.captureMicroProfiler(request)
  local function fail(message) error(name .. ': ' .. message, 0) end
  check(result, engine, fail)
  if engine.opened ~= engine.disposed then fail('every opened session is disposed') end
  if engine.exportReads > 1 then fail('the export is not retried') end
  -- Each read copies the whole snapshot, so reads stay bounded: a few for a normal
  -- capture, more only when the first-frame wait runs to its timeout.
  local waitTimesOut = options.rendersFrames == false or (options.startLagFrames or 0) > 100
  local maxReads = if waitTimesOut then 30 else 20
  if engine.reads > maxReads then fail('snapshot reads stay bounded, got ' .. engine.reads) end
  end)
  if not ok then table.insert(failures, tostring(err)) end
end

local function row(result, timerName)
  for _, timer in result.top_timers do
    if timer.name == timerName then return timer end
  end
  return nil
end

-- A paused peer's capture also holds the frame whose arrival started the timer.
local function expectedFrames(result)
  return CAPTURE_FRAMES + (if (result.capture_state or {}).was_recording then 0 else 1)
end

local function checkCapture(result, fail)
  if not result.ok then fail('capture succeeds: ' .. tostring(result.error) .. ' ' .. tostring(result.message)) end
  local frames = expectedFrames(result)
  if result.frame_summary.frames ~= frames then
    fail('only frames recorded during the capture are analyzed, got ' .. tostring(result.frame_summary.frames))
  end
  if result.frame_summary.avg_us ~= FRAME_MS * 1000 then
    fail('frame times use TickToMsCpu, got avg_us ' .. tostring(result.frame_summary.avg_us))
  end
  local cpu = row(result, 'CpuWork')
  if not cpu or cpu.inclusive_us ~= frames * CPU_SCOPE_MS * 1000 then
    fail('CPU scope times use TickToMsCpu, got ' .. tostring(cpu and cpu.inclusive_us))
  end
  local window = result.analysis_window
  if window.coverage_pct < 99 or window.coverage_pct > 103 or window.frames_evicted ~= 0 or result.data_quality.history_truncated ~= false or result.data_quality.partial then
    fail('a fully retained capture reports full coverage, got ' .. tostring(window.coverage_pct) .. '% with ' .. tostring(window.frames_evicted) .. ' evicted')
  end
  if math.abs(cpu.count_per_s - 1000 / FRAME_MS) > 0.01 then fail('count_per_s uses real seconds, got ' .. tostring(cpu.count_per_s)) end
  if result.schema_version ~= 2 then fail('schema_version is 2') end
  if not result.clock or result.clock.tick_to_ms_cpu ~= TICK_TO_MS_CPU then fail('the snapshot clock is reported') end
end

local captureRequest = {duration_ms = CAPTURE_MS, frame_window = 2000, include_idle = true, include_gpu = true}

scenario('default peer', {}, captureRequest, function(result, engine, fail)
  checkCapture(result, fail)
  local gpu = row(result, 'GpuWork')
  if not gpu or gpu.inclusive_us ~= expectedFrames(result) * GPU_SCOPE_MS * 1000 then
    fail('GPU-thread times use TickToMsGpu, got ' .. tostring(gpu and gpu.inclusive_us))
  end
  if engine.capturing then fail('a paused peer is paused again after the capture') end
  if (result.capture_state or {}).was_recording ~= false then fail('the result reports that the peer was paused') end
  if engine.frameLimit ~= 256 then fail('the frame limit is never narrowed') end
end)

scenario('paused peer with history from an earlier capture', {history = 10}, captureRequest, function(result, engine, fail)
  checkCapture(result, fail)
  if engine.capturing then fail('the peer is paused again') end
end)

scenario('recording peer', {recording = true, history = 10}, captureRequest, function(result, engine, fail)
  checkCapture(result, fail)
  if not engine.capturing then fail('a recording peer keeps recording after the capture') end
  if (result.capture_state or {}).was_recording ~= true then fail('the result reports that the peer was recording') end
end)

scenario('small frame window', {}, {duration_ms = CAPTURE_MS, frame_window = 4}, function(result, engine, fail)
  if not result.ok then fail(tostring(result.error)) end
  if result.frame_summary.frames ~= 4 then fail('frame_window trims the analysis to the newest frames') end
  if engine.frameLimit ~= 256 then fail('a small frame_window does not narrow the peer history') end
end)

local function checkTruncated(result, fail, evicted)
  if not result.ok then fail('capture succeeds: ' .. tostring(result.error)) end
  local quality, window = result.data_quality, result.analysis_window
  if quality.history_truncated ~= true or not table.find(quality.partial_reasons, 'capture_history_truncated') then
    fail('a capture that lost frames to the memory budget is flagged partial')
  end
  if window.frames_evicted ~= evicted then fail('frames_evicted counts the dropped frames, got ' .. tostring(window.frames_evicted)) end
  if result.frame_summary.frames ~= 30 then fail('the retained frames are still analyzed') end
  if evicted ~= expectedFrames(result) - 30 then fail('the fixture expects ' .. evicted .. ' dropped frames') end
  if window.coverage_pct ~= 60 then fail('coverage_pct reports the covered share, got ' .. tostring(window.coverage_pct)) end
  local note = quality.notes and quality.notes[#quality.notes] or ''
  if not string.find(note, 'shorter duration_ms', 1, true) then fail('a note explains the truncation: ' .. note) end
end

scenario('first frame arrives late', {startLagFrames = 8}, captureRequest, function(result, engine, fail)
  checkCapture(result, fail)
  if result.analysis_window.first_frame_wait_ms < 8 * FRAME_MS then fail('the capture waits for its first frame before timing') end
end)

scenario('first frames carry no scope events', {warmupFrames = 5}, captureRequest, function(result, engine, fail)
  checkCapture(result, fail)
  if result.analysis_window.first_frame_wait_ms < 5 * FRAME_MS then fail('timing starts at the first frame with scope events') end
end)

scenario('analysis stops at max_events', {scopesPerFrame = 200}, {duration_ms = CAPTURE_MS, max_events = 10000}, function(result, engine, fail)
  if not result.ok then fail(tostring(result.error)) end
  local quality = result.data_quality
  if not table.find(quality.partial_reasons, 'event_limit_hit') then fail('the event limit is reported') end
  if table.find(quality.partial_reasons, 'capture_coverage_below_requested') then fail('an event-limit shortfall is not double-reported') end
  local note = quality.notes and quality.notes[#quality.notes] or ''
  if result.analysis_window.coverage_pct >= 90 or not string.find(note, 'max_events', 1, true) then
    fail('the note says the event limit shortened the analysis: ' .. tostring(result.analysis_window.coverage_pct) .. '% ' .. note)
  end
end)

scenario('first frame arrives after the wait times out', {startLagFrames = 170}, captureRequest, function(result, engine, fail)
  if not result.ok then fail(tostring(result.error)) end
  local quality = result.data_quality
  if quality.history_truncated ~= false then fail('a late start is not reported as dropped frames') end
  if not table.find(quality.partial_reasons, 'capture_coverage_below_requested') or result.analysis_window.coverage_pct >= 90 then
    fail('a capture that covers less than it ran is flagged, got ' .. tostring(result.analysis_window.coverage_pct) .. '%')
  end
end)

scenario('paused frame inside the window', {history = 10, pausedFrameLate = true}, captureRequest, function(result, engine, fail)
  checkCapture(result, fail)
  if result.frame_summary.paused_frames ~= 1 then fail('the paused frame is in the window but not timed') end
end)

scenario('memory budget drops part of the capture', {memoryFrames = 30}, captureRequest, function(result, engine, fail)
  checkTruncated(result, fail, CAPTURE_FRAMES + 1 - 30)
end)

scenario('memory budget drops part of a recording peer capture', {recording = true, history = 10, memoryFrames = 30}, captureRequest, function(result, engine, fail)
  checkTruncated(result, fail, CAPTURE_FRAMES - 30)
  if not engine.capturing then fail('a recording peer keeps recording') end
end)

scenario('memory budget drops part of a resumed capture', {history = 10, memoryFrames = 30}, captureRequest, function(result, engine, fail)
  checkTruncated(result, fail, CAPTURE_FRAMES + 1 - 30)
end)

scenario('memory budget drops only the paused frame', {history = 10, memoryFrames = CAPTURE_FRAMES + 1}, captureRequest, function(result, engine, fail)
  checkCapture(result, fail)
end)

-- 1.2 s at 4 ms frames is 300 frames: more than the default frame_window (240).
local longRequest = {duration_ms = CAPTURE_MS * 6}

scenario('default frame_window cuts a long capture short', {}, longRequest, function(result, engine, fail)
  if not result.ok then fail(tostring(result.error)) end
  local quality = result.data_quality
  local note = quality.notes and quality.notes[#quality.notes] or ''
  if not table.find(quality.partial_reasons, 'capture_coverage_below_requested') or not string.find(note, 'frame_window', 1, true) then
    fail('a default frame_window that shortens the analysis is flagged and explained: ' .. note)
  end
end)

scenario('requested frame_window shortens a long capture', {}, {duration_ms = CAPTURE_MS * 6, frame_window = 240}, function(result, engine, fail)
  if not result.ok then fail(tostring(result.error)) end
  if result.data_quality.partial then fail('a frame_window the caller chose is not a shortfall') end
end)

scenario('dropped frames outside frame_window', {memoryFrames = 30}, {duration_ms = CAPTURE_MS, frame_window = 4}, function(result, engine, fail)
  if not result.ok then fail(tostring(result.error)) end
  if result.data_quality.history_truncated ~= false then fail('frames frame_window did not ask for do not make the analysis partial') end
  if result.analysis_window.frames_evicted ~= CAPTURE_FRAMES + 1 - 30 then fail('frames_evicted is still reported') end
end)

scenario('export failure on a paused peer', {exportFails = true}, captureRequest, function(result, engine, fail)
  if result.error ~= 'micro_profiler_snapshot_failed' then fail('export failure reaches the caller: ' .. tostring(result.error)) end
  if not string.find(result.message, 'fixture export failed', 1, true) then fail('export failure detail is preserved') end
  if engine.capturing then fail('capture is paused again even when the export fails') end
end)

scenario('export failure on a recording peer', {recording = true, exportFails = true}, captureRequest, function(result, engine, fail)
  if result.error ~= 'micro_profiler_snapshot_failed' then fail('export failure reaches the caller') end
  if not engine.capturing then fail('a recording peer keeps recording when the export fails') end
end)

scenario('no frames rendered', {rendersFrames = false}, captureRequest, function(result, engine, fail)
  if result.error ~= 'micro_profiler_no_frames' then fail('a capture without rendered frames is an error, not an empty success: ' .. tostring(result.error)) end
  if not string.find(result.message, 'rendered no frames', 1, true) then fail('the error explains that Studio rendered nothing') end
  if engine.capturing then fail('capture is paused again when no frames were rendered') end
end)

scenario('no frames rendered, only stale history', {rendersFrames = false, history = 5}, captureRequest, function(result, engine, fail)
  if result.error ~= 'micro_profiler_no_frames' then fail('stale frames from an earlier capture are not analyzed: ' .. tostring(result.error)) end
end)

scenario('snapshot without a clock', {noClock = true}, captureRequest, function(result, engine, fail)
  if result.error ~= 'micro_profiler_clock_unavailable' then fail('times are not guessed without a clock: ' .. tostring(result.error)) end
  if engine.capturing then fail('capture is paused again') end
end)

if #failures > 0 then error(table.concat(failures, '\\n'), 0) end
return 'MICRO_PROFILER_CAPTURE_FIXTURE_OK'
`;

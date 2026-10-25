import { readFileSync } from 'node:fs';

const handlerSource = readFileSync(new URL('../../studio-plugin/out/modules/handlers/MicroProfilerHandlers.luau', import.meta.url), 'utf8');

// Exercise the compiled production handler, not a copy of its recording
// sequence, against a fake MicroProfiler engine that follows what was measured
// in Studio (issue #137 and tests/micro-profiler-recording-verification.mjs):
// - Studio peers start paused with no frames. Enabling capture starts recording;
//   on a fresh peer enabling only the profiler does too.
// - Reads while recording return fresh data; paused reads return the snapshot
//   cached by the last read made while recording.
// - Frame absolute IDs keep counting. The first frame can arrive several frames
//   after EnableCapture, and the first frames can carry no scope events.
// - A LibMP memory stream records only while capture is on. It starts with the
//   frames the live history still holds and writes each frame 7 frames after it
//   is rendered. It stops on the next frame flip after StopStream, dropping the
//   frames it has not written yet, or by itself at its size cap; its slot is
//   readable after. An inactive stream's status reads all zeros.
// The host analyzes the capture, so these scenarios check recording, the
// engine state left behind, and the transfer of the capture bytes.
// Simulated time drives task.wait and os.clock, so no scenario busy-waits.
export const microProfilerCaptureFixtureCode = `
local FRAME_MS = 4
local CAPTURE_MS = 200
local STREAM_LAG_FRAMES = 7
local EncodingService = game:GetService("EncodingService")

local failures = {}
local function scenario(name, options, run)
  local ok, err = pcall(function()
  local now = 0
  local engine = {
    capturing = false, frameLimit = 77, frames = {}, nextAbsolute = 500, cache = {}, lag = 0, warmup = 0,
    fresh = true, slots = {}, resets = {}, snapshots = 0, streamStarts = 0,
  }
  local spawned, delayed = {}, {}

  local function finalizeStream()
    local stream = engine.stream
    if stream == nil or stream.finalized then return end
    if stream.active and not stream.stopRequested then return end
    stream.active = false
    stream.finalized = true
    if not options.streamUnreadable then
      engine.slots[stream.slot] = buffer.fromstring(string.format('STREAM:%d-%d:%d', stream.frames[1] or 0, stream.frames[#stream.frames] or 0, #stream.frames))
    end
  end
  local function addFrames(count)
    finalizeStream()
    if not engine.capturing or options.rendersFrames == false then return end
    for _ = 1, count do
      if engine.lag > 0 then
        engine.lag -= 1
        continue
      end
      local absolute = engine.nextAbsolute
      engine.nextAbsolute += 1
      local eventless = engine.warmup > 0
      if eventless then engine.warmup -= 1 end
      table.insert(engine.frames, { absolute = absolute, eventless = eventless })
      local stream = engine.stream
      if stream and stream.active and not stream.stopRequested then
        table.insert(stream.pending, absolute)
        if #stream.pending > STREAM_LAG_FRAMES then
          table.insert(stream.frames, table.remove(stream.pending, 1))
        end
        if options.streamCapFrames and #stream.frames >= options.streamCapFrames then
          stream.active = false
          stream.capped = true
          finalizeStream()
        end
      end
    end
  end
  local function visibleFrames()
    local out = {}
    for index = math.max(1, #engine.frames - engine.frameLimit + 1), #engine.frames do
      table.insert(out, { id = index, frame = engine.frames[index] })
    end
    return out
  end
  local function startRecording()
    engine.lag = options.startLagFrames or 0
    engine.warmup = options.warmupFrames or 0
    engine.capturing = true
  end

  -- Earlier history: frames retained from a capture before this call.
  engine.capturing = true
  addFrames(options.history or 0)
  engine.cache = visibleFrames()
  engine.capturing = options.recording == true
  engine.fresh = not engine.capturing and #engine.frames == 0

  local views = {}
  local function openSnapshot(data)
    local view = views[buffer.readu32(data, 0)]
    if view == nil then return nil end
    local byId = {}
    for _, entry in view do byId[entry.id] = entry.frame end
    local maxId = if #view > 0 then view[#view].id else 0
    return {
      GetFrameIdMax = function() return maxId end,
      GetFrameDesc = function(_, id)
        local frame = byId[id]
        return frame and { FrameAbsoluteId = function() return frame.absolute end } or nil
      end,
      CreateLogIterator = function()
        local config = {}
        return {
          Configure = function(_, value) config = value end,
          Step = function()
            local frame = byId[config.StartFrameId or maxId]
            return frame ~= nil and not frame.eventless
          end,
          Dispose = function() end,
        }
      end,
      Dispose = function() end,
    }
  end

  local V1 = {
    StartMemoryStream = function(slot)
      engine.streamStarts += 1
      if options.streamStartFails then return false end
      local frames = {}
      for _, entry in visibleFrames() do table.insert(frames, entry.frame.absolute) end
      engine.stream = { slot = slot, active = not options.streamNeverRuns, frames = frames, pending = {} }
      return true
    end,
    StopStream = function()
      if engine.stream == nil or not engine.stream.active then return false end
      engine.stream.stopRequested = true
      return true
    end,
    GetStreamStatus = function()
      local stream = engine.stream
      if options.otherStreamActive then
        return { Active = true, StreamFrameId = 1, AbsoluteFrameId = 1, MarkerMask = 0, RecordedSizeKb = 1, MaxSizeKb = 0, ElapsedMs = 0 }
      end
      if stream == nil or not stream.active then
        return { Active = false, StreamFrameId = 0, AbsoluteFrameId = 0, MarkerMask = 0, RecordedSizeKb = 0, MaxSizeKb = 0, ElapsedMs = 0 }
      end
      local cap = (options.streamCapFrames or 100000) * 10
      return { Active = stream.active, StreamFrameId = #stream.frames, AbsoluteFrameId = engine.nextAbsolute - 1, MarkerMask = 0,
        RecordedSizeKb = math.min(#stream.frames * 10, cap), MaxSizeKb = cap, ElapsedMs = 0 }
    end,
  }

  local LibMP = {
    Versions = { Library = 65537, DataFormat = 65537 },
    Experimental = if options.noStreamApi then nil else { V1 = V1 },
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
        engine.capturing = enabled
        return true
      end,
      CaptureToBufferSync = function()
        if engine.capturing then engine.cache = visibleFrames() end
        if options.snapshotFails and engine.exporting then error('fixture export failed') end
        -- An empty live slot exports as an empty buffer.
        if options.emptySnapshot and engine.exporting then return buffer.create(0) end
        table.insert(views, engine.cache)
        engine.snapshots += 1
        local data = buffer.create(4)
        buffer.writeu32(data, 0, #views)
        return data
      end,
      SaveSlotToBuffer = function(_, slot) return engine.slots[slot] end,
      ResetSlot = function(_, slot)
        engine.slots[slot] = nil
        table.insert(engine.resets, slot)
        return true
      end,
    },
    Session = { OpenFromBuffer = openSnapshot },
  }
  local libModule = { IsA = function(_, class) return class == 'ModuleScript' end }
  local include = { RuntimeLib = {}, FindFirstChild = function(_, childName) return if childName == 'LibMP' then libModule else nil end }
  local root = { include = include, FindFirstChild = function(_, childName) return if childName == 'include' then include else nil end }
  local script = { Parent = { Parent = { Parent = root } } }
  local require = function(module)
    if module == libModule then return LibMP end
    assert(module == include.RuntimeLib)
    return { import = function() return { RunService = { IsRunning = function() return true end } } end }
  end
  local task = {
    wait = function(seconds)
      local elapsed = if seconds and seconds > 0 then seconds else FRAME_MS / 1000
      now += elapsed
      -- Another request arriving while this one yields.
      local hook = engine.duringWait
      if hook then
        engine.duringWait = nil
        hook()
      end
      -- The export after a timed capture is the read that may fail.
      if seconds and seconds >= CAPTURE_MS / 1000 then engine.exporting = true end
      addFrames(math.max(1, math.floor(elapsed * 1000 / FRAME_MS + 0.5)))
    end,
    -- The watchdog runs only when a scenario drives it.
    spawn = function(fn)
      table.insert(spawned, fn)
      return fn
    end,
    delay = function(seconds, fn) table.insert(delayed, { at = now + seconds, fn = fn }) end,
    cancel = function() end,
  }
  local os = { clock = function() return now end }
  local handler = (function()
${handlerSource}
  end)()

  local function readAll(result)
    local transfer = result.transfer
    if transfer == nil then return nil end
    local parts, offset = {}, 0
    while offset < transfer.total_bytes do
      local length = math.min(3, transfer.total_bytes - offset)
      local chunk = handler.readTransfer({ transfer_id = transfer.transfer_id, offset = offset, length = length })
      if not chunk.ok then error('chunk read failed: ' .. tostring(chunk.error)) end
      table.insert(parts, buffer.tostring(EncodingService:Base64Decode(buffer.fromstring(chunk.data))))
      offset += length
    end
    return table.concat(parts)
  end
  local function runWatchdog()
    local fn = table.remove(spawned)
    if fn == nil then error('no watchdog was started') end
    fn()
  end
  local function expireRetention()
    now += 601
    for _, entry in delayed do
      if now >= entry.at then entry.fn() end
    end
  end

  local function fail(message) error(name .. ': ' .. message, 0) end
  local function advance(frames)
    for _ = 1, frames do task.wait() end
  end
  run({ handler = handler, engine = engine, fail = fail, readAll = readAll, runWatchdog = runWatchdog, expireRetention = expireRetention, advance = advance })
  end)
  if not ok then table.insert(failures, tostring(err)) end
end

local captureRequest = { duration_ms = CAPTURE_MS }

local function checkStream(t, result, wasRecording)
  if not result.ok then t.fail('capture succeeds: ' .. tostring(result.error) .. ' ' .. tostring(result.message)) end
  local recording = result.recording
  if recording.method ~= 'stream' then t.fail('the capture is a recorded stream, got ' .. tostring(recording.method)) end
  if (result.capture_state or {}).was_recording ~= wasRecording then t.fail('the result reports the prior capture state') end
  local text = t.readAll(result)
  local first, last, count = string.match(text or '', '^STREAM:(%d+)-(%d+):(%d+)$')
  if first == nil then t.fail('the transfer returns the stream slot bytes, got ' .. tostring(text)) end
  -- The stream also holds the live history at its start; the host analyzes
  -- frames from start_absolute_frame to stop_absolute_frame.
  local frames = (recording.stop_absolute_frame or 0) - recording.start_absolute_frame
  if math.abs(frames - CAPTURE_MS / FRAME_MS) > 2 then
    t.fail('the window spans the requested time, got frames ' .. recording.start_absolute_frame .. '-' .. tostring(recording.stop_absolute_frame))
  end
  if tonumber(last) < recording.stop_absolute_frame or recording.stream.tail_written ~= true then
    t.fail('the stream is stopped only after it has written the stop frame ' .. recording.stop_absolute_frame .. ', it ends at ' .. last)
  end
  if math.abs(recording.capture_wall_ms - CAPTURE_MS) > FRAME_MS * 3 then t.fail('capture_wall_ms is the recorded time, got ' .. tostring(recording.capture_wall_ms)) end
  if t.engine.slots[4] ~= nil or not table.find(t.engine.resets, 4) then t.fail('the stream slot is cleared after it is copied') end
  if t.engine.stream.active then t.fail('the stream is stopped') end
  if t.engine.frameLimit ~= 256 then t.fail('the frame limit is never narrowed') end
  if t.handler.readTransfer({ transfer_id = result.transfer.transfer_id, offset = 0, length = 1 }).error ~= 'micro_profiler_transfer_expired' then
    t.fail('the last chunk releases the transfer')
  end
end

scenario('default peer', {}, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  checkStream(t, result, false)
  if t.engine.capturing then t.fail('a paused peer is paused again after the capture') end
end)

scenario('recording peer with history', { recording = true, history = 10 }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  checkStream(t, result, true)
  if not t.engine.capturing then t.fail('a recording peer keeps recording after the capture') end
end)

scenario('first frames carry no scope events', { warmupFrames = 5, startLagFrames = 3 }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  checkStream(t, result, false)
  local firstWithEvents = 500 + 5
  if result.recording.start_absolute_frame ~= firstWithEvents then
    t.fail('the window starts at the first frame with events, got ' .. tostring(result.recording.start_absolute_frame))
  end
  if result.recording.first_frame_wait_ms < 8 * FRAME_MS then t.fail('timing starts after the wait for that frame') end
end)

scenario('no stream API', { noStreamApi = true }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if not result.ok or result.recording.method ~= 'snapshot' then t.fail('the capture falls back to the live history') end
  if not string.find(table.concat(result.recording.notes or {}, ' '), 'live history', 1, true) then t.fail('a note explains the fallback') end
  local text = t.readAll(result)
  if text == nil or #text ~= 4 then t.fail('the live snapshot is transferred') end
  if t.engine.capturing then t.fail('the peer is paused again') end
end)

scenario('another stream is recording', { otherStreamActive = true }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if not result.ok or result.recording.method ~= 'snapshot' then t.fail('an active stream is left alone') end
  if t.engine.streamStarts ~= 0 then t.fail('no second stream is started') end
end)

scenario('stream does not start', { streamStartFails = true }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if not result.ok or result.recording.method ~= 'snapshot' then t.fail('a failed stream start falls back to the live history') end
end)

scenario('stream is accepted but never runs', { streamNeverRuns = true }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if not result.ok or result.recording.method ~= 'snapshot' then t.fail('a stream that never runs falls back to the live history') end
  if result.recording.stream ~= nil then t.fail('no stream size limit is reported for a stream that never ran') end
end)

scenario('stream is unreadable', { streamUnreadable = true }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if not result.ok or result.recording.method ~= 'snapshot' then t.fail('an unreadable stream falls back to the live history') end
  if not string.find(table.concat(result.recording.notes or {}, ' '), 'did not produce a readable recording', 1, true) then t.fail('a note explains the unreadable stream') end
  if t.engine.capturing then t.fail('the peer is paused again') end
end)

scenario('live snapshot is empty', { noStreamApi = true, emptySnapshot = true }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if result.error ~= 'micro_profiler_no_frames' or result.transfer ~= nil then t.fail('an empty export is an error, not an empty success: ' .. tostring(result.error)) end
  if t.engine.capturing then t.fail('capture is paused again') end
end)

scenario('first frame without events never arrives', { noStreamApi = true, warmupFrames = 1000 }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if not result.ok then t.fail('capture succeeds: ' .. tostring(result.error)) end
  -- Absolute IDs keep counting while paused, so the window starts at the first
  -- frame this capture recorded, not after the pre-capture boundary.
  if result.recording.start_absolute_frame ~= 500 or result.recording.start_frame_estimated ~= nil then
    t.fail('the window starts at the first recorded frame, got ' .. tostring(result.recording.start_absolute_frame))
  end
end)

scenario('no frames rendered', { noStreamApi = true, rendersFrames = false }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if result.recording == nil or result.recording.start_frame_estimated ~= true then t.fail('a start without frames is marked estimated') end
  if t.engine.capturing then t.fail('capture is paused again') end
end)

scenario('live snapshot export fails', { noStreamApi = true, snapshotFails = true }, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  if result.error ~= 'micro_profiler_snapshot_failed' or not string.find(tostring(result.message), 'fixture export failed', 1, true) then
    t.fail('export failure reaches the caller: ' .. tostring(result.error))
  end
  if t.engine.capturing then t.fail('capture is paused again even when the export fails') end
end)

scenario('start and stop', {}, function(t)
  local started = t.handler.captureMicroProfiler({ action = 'start' })
  if not started.ok or started.recording.method ~= 'stream' or started.transfer ~= nil then t.fail('start opens a stream and returns at once') end
  if not t.engine.capturing then t.fail('capture stays on while the recording is open') end
  if t.handler.captureMicroProfiler({ action = 'start' }).error ~= 'micro_profiler_recording_active' then t.fail('a second start is refused') end
  if t.handler.captureMicroProfiler(captureRequest).error ~= 'micro_profiler_recording_active' then t.fail('a timed capture is refused while recording') end
  -- Work happens through other tool calls.
  t.advance(CAPTURE_MS / FRAME_MS)
  local stopped = t.handler.captureMicroProfiler({ action = 'stop' })
  checkStream(t, stopped, false)
  if t.engine.capturing then t.fail('stop restores the paused peer') end
  if t.handler.captureMicroProfiler({ action = 'stop' }).error ~= 'micro_profiler_no_recording' then t.fail('stop without a recording is an error') end
end)

scenario('the peer stays busy while a stop finishes', {}, function(t)
  t.handler.captureMicroProfiler({ action = 'start' })
  t.advance(10)
  local concurrent = {}
  t.engine.duringWait = function()
    concurrent.start = t.handler.captureMicroProfiler({ action = 'start' })
    concurrent.stop = t.handler.captureMicroProfiler({ action = 'stop' })
  end
  local stopped = t.handler.captureMicroProfiler({ action = 'stop' })
  if not stopped.ok then t.fail('the first stop returns the recording: ' .. tostring(stopped.error)) end
  if concurrent.start == nil or concurrent.start.error ~= 'micro_profiler_recording_active' then
    t.fail('a start during the stop is refused, got ' .. tostring(concurrent.start and (concurrent.start.error or 'ok')))
  end
  if concurrent.stop == nil or concurrent.stop.error ~= 'micro_profiler_no_recording' then t.fail('a second stop does not finish the recording again') end
  if t.engine.capturing then t.fail('capture is paused once the stop finishes') end
  if not t.handler.captureMicroProfiler({ action = 'start' }).ok then t.fail('the peer is free after the stop returns') end
end)

scenario('recording reaches its time limit', {}, function(t)
  t.handler.captureMicroProfiler({ action = 'start' })
  t.runWatchdog()
  if t.engine.capturing or t.engine.stream.active then t.fail('the time limit stops the stream and restores capture') end
  local stopped = t.handler.captureMicroProfiler({ action = 'stop' })
  if not stopped.ok or stopped.recording.stopped_by ~= 'max_duration' then t.fail('stop returns the auto-stopped recording, got ' .. tostring(stopped.recording and stopped.recording.stopped_by)) end
  if t.readAll(stopped) == nil then t.fail('the auto-stopped recording is transferred') end
end)

scenario('stream reaches its size cap', { streamCapFrames = 30 }, function(t)
  t.handler.captureMicroProfiler({ action = 'start' })
  t.runWatchdog()
  local stopped = t.handler.captureMicroProfiler({ action = 'stop' })
  if not stopped.ok or stopped.recording.stopped_by ~= 'size_limit' or stopped.recording.stream.size_limit_reached ~= true then
    t.fail('a capped stream is reported, got ' .. tostring(stopped.recording and stopped.recording.stopped_by))
  end
end)

scenario('an unclaimed auto-stopped recording is discarded', {}, function(t)
  t.handler.captureMicroProfiler({ action = 'start' })
  t.runWatchdog()
  t.expireRetention()
  if t.handler.captureMicroProfiler({ action = 'stop' }).error ~= 'micro_profiler_no_recording' then t.fail('retention ends the recording') end
  if not t.handler.captureMicroProfiler({ action = 'start' }).ok then t.fail('a new recording can start after retention') end
end)

scenario('transfer ranges are checked', {}, function(t)
  local result = t.handler.captureMicroProfiler(captureRequest)
  local id = result.transfer.transfer_id
  if t.handler.readTransfer({ transfer_id = id, offset = 1, length = 1 }).ok ~= true then t.fail('any in-range chunk can be read') end
  if t.handler.readTransfer({ transfer_id = id, offset = 0, length = result.transfer.total_bytes + 1 }).error ~= 'invalid_transfer_range' then
    t.fail('an out-of-range read is refused')
  end
  t.handler.releaseTransfer({ transfer_id = id })
  if t.handler.readTransfer({ transfer_id = id, offset = 0, length = 1 }).error ~= 'micro_profiler_transfer_expired' then t.fail('release frees the transfer') end
end)

if #failures > 0 then error(table.concat(failures, '\\n'), 0) end
return 'MICRO_PROFILER_CAPTURE_FIXTURE_OK'
`;

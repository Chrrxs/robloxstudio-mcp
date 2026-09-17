import { readFileSync } from 'node:fs';

const handlerSource = readFileSync(new URL('../../studio-plugin/out/modules/handlers/MicroProfilerHandlers.luau', import.meta.url), 'utf8');

// Exercise the compiled production handler, not a copy of its capture sequence.
// LibMP documents that active reads synchronize data while paused reads retain
// the last synchronized cache: https://github.com/Roblox/libmp/blob/main/docs/SKILL.md
export const microProfilerCaptureFixtureCode = `
local function scenario(cachedGeneration, frameLimit, exportFails)
  local generation = cachedGeneration
  local capturing = false
  local snapshots = 0
  local disposed = 0
  local function openSnapshot(data)
    local captured = buffer.readu32(data, 0)
    local frame = {
      FrameId = function() return captured end,
      TickStartCpu = function() return 1000000 end,
      TickEndCpu = function() return 3000000 end,
      IsIncomplete = function() return false end,
      IsPaused = function() return false end,
    }
    return {
      IsValid = function() return true end,
      GetDataFormatVersion = function() return 65536 end,
      GetObjSize = function() return 4 end,
      FetchTimerIds = function() return {1} end,
      FetchThreadIds = function() return {1} end,
      FetchTimerDesc = function() return {TimerId = 1, TimerName = 'Fresh' .. captured, GroupId = 1} end,
      FetchThreadDesc = function() return {ThreadId = 1, ThreadName = 'Fixture'} end,
      FetchGroupDesc = function() return {GroupId = 1, GroupName = 'Fixture'} end,
      GetFrameIdMin = function() return captured end,
      GetFrameIdMax = function() return captured end,
      GetFrameDesc = function() return captured > 0 and frame or nil end,
      CreateLogIterator = function()
        local index = 0
        return {
          Configure = function() end,
          Step = function() index += 1 return captured > 0 and index <= 2 end,
          GetState = function() return {
            FrameId = function() return captured end,
            ThreadId = function() return 1 end,
            TimerId = function() return 1 end,
            Timestamp = function() return index * 1000000 end,
            IsEnter = function() return index == 1 end,
            IsExit = function() return index == 2 end,
          } end,
          Dispose = function() end,
        }
      end,
      Dispose = function() disposed += 1 end,
    }
  end
  local LibMP = {
    Versions = {Library = 65536, DataFormat = 65536},
    Control = {
      IsBackendAccessible = function() return true end,
      IsBackendReady = function() return true end,
      IsBackendVersionCompatible = function() return true end,
      EnableProfiler = function() return true end,
      SetFrameLimit = function(_, value)
        assert(value > 0 and value <= 256, 'native rolling frame limit is at most 256')
        frameLimit = value
        return true
      end,
      EnableCapture = function(_, enabled) capturing = enabled return true end,
      CaptureToBufferSync = function()
        snapshots += 1
        if exportFails then error('fixture export failed') end
        if capturing then cachedGeneration = generation end
        local data = buffer.create(4)
        buffer.writeu32(data, 0, cachedGeneration)
        return data
      end,
    },
    Session = {OpenFromBuffer = openSnapshot},
  }
  local libModule = {IsA = function(_, class) return class == 'ModuleScript' end}
  local include = {RuntimeLib = {}, FindFirstChild = function(_, name) return name == 'LibMP' and libModule or nil end}
  local root = {include = include, FindFirstChild = function(_, name) return name == 'include' and include or nil end}
  local script = {Parent = {Parent = {Parent = root}}}
  local require = function(module)
    if module == libModule then return LibMP end
    assert(module == include.RuntimeLib)
    return {import = function() return {RunService = {IsRunning = function() return true end}} end}
  end
  local task = {wait = function(seconds)
    if seconds and capturing and frameLimit > 0 then generation += 1 end
  end}
  local handler = (function()
${handlerSource}
  end)()
  if exportFails then
    local result = handler.captureMicroProfiler({duration_ms = 100})
    assert(result.error == 'micro_profiler_snapshot_failed', 'export failure reaches the caller')
    assert(string.find(result.message, 'fixture export failed', 1, true), 'export failure detail is preserved')
    assert(not capturing, 'capture is paused even when snapshot export fails')
    assert(snapshots == 1, 'failed exports are not retried')
    return
  end
  for _ = 1, 2 do
    local result = handler.captureMicroProfiler({duration_ms = 100, frame_window = 2000, include_idle = true, include_gpu = true})
    assert(result.ok, tostring(result.error))
    assert(result.counts.events_sampled == 2, 'active snapshot must contain this capture, not the empty paused cache')
    assert(result.top_timers[1].name == 'Fresh' .. generation, 'capture must refresh stale cached events')
    assert(result.top_timers[1].inclusive_us == 1000, 'fresh snapshot timer duration survives handler analysis')
    assert(not capturing, 'capture is paused after the snapshot has been taken')
  end
  assert(snapshots == 2, 'capture does not retry snapshots')
  assert(disposed == 2, 'snapshot sessions are released')
end
scenario(0, 256)
scenario(7, 256)
scenario(0, 0)
scenario(0, 256, true)
return 'MICRO_PROFILER_CACHE_REGRESSION_OK'
`;

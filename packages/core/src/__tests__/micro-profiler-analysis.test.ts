import { analyzeMicroProfilerCapture, analyzeMicroProfilerSession } from '../micro-profiler/analysis.js';
import type {
  LibMPFrameDesc,
  LibMPLogIterator,
  LibMPLogIteratorConfig,
  LibMPLogIteratorState,
  LibMPSegmentDesc,
  LibMPSession,
} from '../micro-profiler/libmp-vendor.js';

// One tick is 0.25 us here (a 4 GHz timer), so a wrong unit is obvious.
const TICK_TO_MS = 0.00025;
const TICKS_PER_MS = 1 / TICK_TO_MS;

interface FakeFrame {
  id: number;
  absolute: number;
  startMs: number;
  endMs: number;
  paused?: boolean;
}

interface FakeEvent {
  frame: number;
  thread: number;
  timer: number;
  ms: number;
  enter: boolean;
}

interface FakeSpec {
  frames: FakeFrame[];
  events: FakeEvent[];
  segments?: { begin: number; end: number }[];
}

const TIMERS: Record<number, { name: string; group: number }> = {
  1: { name: 'Heartbeat', group: 1 },
  2: { name: 'PetsFrame', group: 2 },
  3: { name: 'Layout', group: 3 },
  4: { name: 'Sleep', group: 4 },
  5: { name: 'Physics Step', group: 5 },
};
const GROUPS: Record<number, string> = { 1: 'Jobs', 2: 'Script', 3: 'UI', 4: 'Runtime', 5: 'Physics' };
const THREADS: Record<number, string> = { 1: ' RBX Main', 2: 'RBX Worker A' };

function ticks(ms: number): bigint {
  return BigInt(Math.round(ms * TICKS_PER_MS));
}

function makeState(current: { event?: FakeEvent; absolute: number }): LibMPLogIteratorState {
  return {
    frameId: () => current.event?.frame ?? 0,
    frameAbsoluteId: () => current.absolute,
    threadId: () => current.event?.thread ?? 0,
    timerId: () => current.event?.timer ?? 0,
    timestamp: () => ticks(current.event?.ms ?? 0),
    isGpuThread: () => false,
    isEnter: () => current.event?.enter === true,
    isExit: () => current.event !== undefined && !current.event.enter,
  };
}

class FakeSession implements LibMPSession {
  private segmentIndex = 0;
  disposed = false;

  constructor(private readonly spec: FakeSpec) {}

  private frame(id: number): FakeFrame | undefined {
    return this.spec.frames.find((frame) => frame.id === id);
  }

  IsValid() { return true; }
  Dispose() { this.disposed = true; }
  GetDataFormatVersion() { return 65537; }
  GetTrackCount() { return this.spec.segments ? 1 : 0; }
  FetchSegments(): LibMPSegmentDesc[] {
    return (this.spec.segments ?? []).map((segment) => ({
      timestampStart: 0n,
      timestampStop: 0n,
      frameIdBegin: segment.begin,
      frameIdEnd: segment.end,
      frameAbsoluteIdBegin: this.frame(segment.begin)?.absolute ?? 0,
      markers: 0,
    }));
  }
  SelectTrack() { return this.spec.segments !== undefined; }
  SelectSegment(index: number) {
    this.segmentIndex = index;
    return true;
  }
  FetchGlobalDesc() { return { tickToMsCpu: TICK_TO_MS, tickToMsGpu: 0.000001 }; }
  GetFrameIdMin() { return this.spec.segments?.[this.segmentIndex].begin ?? this.spec.frames[0].id; }
  GetFrameIdMax() { return this.spec.segments?.[this.segmentIndex].end ?? this.spec.frames[this.spec.frames.length - 1].id; }
  FetchFrameDesc(id: number): LibMPFrameDesc | null {
    const frame = this.frame(id);
    if (!frame) return null;
    return {
      frameId: frame.id,
      frameAbsoluteId: frame.absolute,
      tickStartCpu: ticks(frame.startMs),
      tickEndCpu: ticks(frame.endMs),
      isPaused: frame.paused === true,
      isIncomplete: false,
    };
  }
  FetchTimerIds() { return Object.keys(TIMERS).map(Number); }
  FetchThreadIds() { return Object.keys(THREADS).map(Number); }
  FetchTimerDesc(id: number) {
    const timer = TIMERS[id];
    return timer ? { timerId: id, timerName: timer.name, groupId: timer.group } : null;
  }
  FetchGroupDesc(id: number) { return GROUPS[id] ? { groupId: id, groupName: GROUPS[id] } : null; }
  FetchThreadDesc(id: number) { return THREADS[id] ? { threadId: id, threadName: THREADS[id] } : null; }
  FindGroupIds(mask: string) {
    return Object.entries(GROUPS).filter(([, name]) => name === mask).map(([id]) => Number(id));
  }
  CreateLogIterator(): LibMPLogIterator {
    let config: LibMPLogIteratorConfig = {};
    let queue: FakeEvent[] = [];
    const current: { event?: FakeEvent; absolute: number } = { absolute: 0 };
    const state = makeState(current);
    return {
      Configure: (values) => {
        config = values;
        return true;
      },
      // Frame by frame, then thread by thread within a frame, like LibMP.
      RewindTo: (min, max) => {
        queue = this.spec.events
          .filter((event) => event.frame >= min && event.frame <= max)
          .filter((event) => !(config.SkipPausedFrames && this.frame(event.frame)?.paused))
          .filter((event) => !config.GroupIds || config.GroupIds.includes(TIMERS[event.timer].group))
          .sort((a, b) => a.frame - b.frame || a.thread - b.thread || a.ms - b.ms);
      },
      Step: () => {
        current.event = queue.shift();
        current.absolute = current.event ? this.frame(current.event.frame)?.absolute ?? 0 : 0;
        return current.event !== undefined;
      },
      GetState: () => state,
      Dispose: () => undefined,
    };
  }
}

function scope(frame: number, thread: number, timer: number, startMs: number, endMs: number): FakeEvent[] {
  return [
    { frame, thread, timer, ms: startMs, enter: true },
    { frame, thread, timer, ms: endMs, enter: false },
  ];
}

// Frames 1-2 predate the capture (absolute 10-11), frame 3 is the paused frame
// a resume adds, frame 4 is warm-up without events, frames 5-8 hold work.
function captureSpec(): FakeSpec {
  const frames: FakeFrame[] = [
    { id: 1, absolute: 10, startMs: 0, endMs: 16 },
    { id: 2, absolute: 11, startMs: 16, endMs: 32 },
    { id: 3, absolute: 40, startMs: 32, endMs: 1000, paused: true },
    { id: 4, absolute: 41, startMs: 1000, endMs: 1016 },
    { id: 5, absolute: 42, startMs: 1016, endMs: 1032 },
    { id: 6, absolute: 43, startMs: 1032, endMs: 1080 },
    { id: 7, absolute: 44, startMs: 1080, endMs: 1096 },
    { id: 8, absolute: 45, startMs: 1096, endMs: 1112 },
  ];
  const events: FakeEvent[] = [
    // Old history that must not be analyzed.
    ...scope(1, 1, 5, 1, 9),
    ...scope(2, 1, 5, 17, 25),
  ];
  for (const frame of frames.slice(4)) {
    const heavy = frame.id === 6;
    const end = frame.startMs + (heavy ? 40 : 5);
    events.push({ frame: frame.id, thread: 1, timer: 1, ms: frame.startMs + 0.5, enter: true });
    events.push(...scope(frame.id, 1, 2, frame.startMs + 1, end - 1));
    if (heavy) events.push(...scope(frame.id, 1, 3, frame.startMs + 2, frame.startMs + 37));
    events.push({ frame: frame.id, thread: 1, timer: 1, ms: end, enter: false });
    // The worker sleeps through each frame.
    events.push(...scope(frame.id, 2, 4, frame.startMs, frame.endMs - 0.5));
  }
  return { frames, events };
}

describe('MicroProfiler capture analysis', () => {
  test('converts ticks with the capture clock and analyzes only the capture window', () => {
    const result = analyzeMicroProfilerSession(new FakeSession(captureSpec()), {
      window: { startAbsoluteFrame: 41, captureWallMs: 96, requestedDurationMs: 100 },
      includeIdle: true,
    });
    expect(result.ok).toBe(true);
    const window = result.analysis_window as Record<string, number>;
    expect(window).toMatchObject({
      analyzed_frame_min: 5,
      analyzed_frame_max: 8,
      analyzed_frame_count: 4,
      // The two old frames and the paused frame the resume added.
      frames_before_capture: 3,
      frames_without_events_trimmed: 1,
      frames_dropped: 0,
      analysis_duration_us: 96_000,
      coverage_pct: 100,
    });
    const timers = result.top_timers as Record<string, unknown>[];
    const heartbeat = timers.find((row) => row.name === 'Heartbeat');
    // 3 x 4.5 ms + 39.5 ms, all in 0.25 us ticks.
    expect(heartbeat).toMatchObject({ count: 4, inclusive_us: 53_000, group: 'Jobs' });
    expect(timers.find((row) => row.name === 'Physics Step')).toBeUndefined();
    const layout = timers.find((row) => row.name === 'Layout');
    expect(layout).toMatchObject({ inclusive_us: 35_000, exclusive_us: 35_000, max_frame_id: 6 });
    const pets = timers.find((row) => row.name === 'PetsFrame');
    expect(pets).toMatchObject({ inclusive_us: 47_000, exclusive_us: 12_000 });
    expect((result.data_quality as Record<string, unknown>).partial).toBe(false);
  });

  test('breaks the slowest frame down by busy thread, timer, and hot path', () => {
    const result = analyzeMicroProfilerSession(new FakeSession(captureSpec()), {
      window: { startAbsoluteFrame: 41 },
      spikeFrames: 1,
    });
    const [spike] = result.spike_frames as Record<string, unknown>[];
    expect(spike).toMatchObject({ frame_id: 6, frame_absolute_id: 43, duration_us: 48_000, offset_ms: 16 });
    // The sleeping worker is idle, not the bottleneck.
    expect(spike.threads).toEqual([{ thread: 'RBX Main', busy_us: 39_500, busy_pct_of_frame: 82.29 }]);
    expect((spike.top_timers_by_exclusive as Record<string, unknown>[])[0]).toMatchObject({ name: 'Layout', exclusive_us: 35_000 });
    const [path] = spike.hot_paths as { thread: string; path: Record<string, unknown>[] }[];
    expect(path.thread).toBe('RBX Main');
    expect(path.path.map((step) => step.name)).toEqual(['Heartbeat', 'PetsFrame', 'Layout']);
  });

  test('stops at the frame rendered when the capture was stopped', () => {
    const result = analyzeMicroProfilerSession(new FakeSession(captureSpec()), {
      window: { startAbsoluteFrame: 41, endAbsoluteFrame: 44 },
    });
    expect(result.analysis_window).toMatchObject({ analyzed_frame_max: 7, frames_after_capture: 1, frames_missing_at_end: 0 });
    expect((result.data_quality as Record<string, unknown>).partial).toBe(false);
  });

  test('reports a recording that ends before the stop request', () => {
    const result = analyzeMicroProfilerSession(new FakeSession(captureSpec()), {
      window: { startAbsoluteFrame: 41, endAbsoluteFrame: 50 },
    });
    expect((result.analysis_window as Record<string, unknown>).frames_missing_at_end).toBe(5);
    expect((result.data_quality as Record<string, unknown>).partial_reasons).toContain('capture_end_missing');
  });

  test('reports frames dropped before the capture was read', () => {
    const result = analyzeMicroProfilerSession(new FakeSession(captureSpec()), {
      window: { startAbsoluteFrame: 30 },
    });
    expect((result.analysis_window as Record<string, unknown>).frames_dropped).toBe(11);
    expect((result.data_quality as Record<string, unknown>).partial_reasons).toContain('capture_history_truncated');
  });

  test('does not count frames as dropped when the start frame is only estimated', () => {
    const result = analyzeMicroProfilerSession(new FakeSession(captureSpec()), {
      window: { startAbsoluteFrame: 30, startFrameEstimated: true },
    });
    expect((result.analysis_window as Record<string, unknown>).frames_dropped).toBe(0);
    expect((result.data_quality as Record<string, unknown>).partial_reasons).not.toContain('capture_history_truncated');
  });

  test('keeps scope stacks across stream segments', () => {
    const spec: FakeSpec = {
      frames: [
        { id: 1, absolute: 100, startMs: 0, endMs: 16 },
        { id: 2, absolute: 101, startMs: 16, endMs: 32 },
        { id: 3, absolute: 102, startMs: 32, endMs: 48 },
      ],
      segments: [{ begin: 1, end: 2 }, { begin: 3, end: 3 }],
      events: [
        ...scope(1, 1, 2, 1, 2),
        { frame: 2, thread: 1, timer: 3, ms: 20, enter: true },
        { frame: 3, thread: 1, timer: 3, ms: 40, enter: false },
      ],
    };
    const result = analyzeMicroProfilerSession(new FakeSession(spec), {});
    const layout = (result.top_timers as Record<string, unknown>[]).find((row) => row.name === 'Layout');
    expect(layout).toMatchObject({ inclusive_us: 20_000, count: 1 });
    expect((result.analysis_window as Record<string, unknown>).segments).toBe(2);
    expect((result.data_quality as Record<string, unknown>).unmatched_exits).toBe(0);
  });

  test('narrows to a frame range without calling it partial', () => {
    const result = analyzeMicroProfilerSession(new FakeSession(captureSpec()), {
      window: { startAbsoluteFrame: 41, captureWallMs: 96 },
      startFrame: 6,
      endFrame: 6,
    });
    expect(result.analysis_window).toMatchObject({ analyzed_frame_min: 6, analyzed_frame_max: 6, start_frame: 6, end_frame: 6 });
    expect((result.data_quality as Record<string, unknown>).partial).toBe(false);
  });

  test('fails clearly when the capture window holds no frames', () => {
    const fromStudio = analyzeMicroProfilerSession(new FakeSession(captureSpec()), { window: { startAbsoluteFrame: 1000 } });
    expect(fromStudio.error).toBe('micro_profiler_no_frames');
    expect(String(fromStudio.message)).toContain('rendered no frames');
    const fromFile = analyzeMicroProfilerSession(new FakeSession(captureSpec()), { startFrame: 50 });
    expect(String(fromFile.message)).toContain('frames 1-8');
    // A frame range that excludes the capture is not a rendering problem.
    const outOfRange = analyzeMicroProfilerSession(new FakeSession(captureSpec()), { window: { startAbsoluteFrame: 41 }, startFrame: 50 });
    expect(String(outOfRange.message)).toContain('selected range');
  });

  test('rejects bytes that are not a capture', async () => {
    const result = await analyzeMicroProfilerCapture(new Uint8Array([1, 2, 3, 4]));
    expect(result.error).toBe('micro_profiler_decode_failed');
  });
});

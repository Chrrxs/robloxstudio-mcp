// Analyzes a MicroProfiler capture (a LibMP container: a streamed recording, a
// live snapshot, or a Studio "Dump in binary format" .gprx file) on the MCP
// host. The Studio plugin only records and transfers the capture; decoding runs
// here, where LibMP iterates events far faster than inside Studio and does not
// add work to the frames being profiled.
import LibMP from './libmp-vendor.js';
import type {
  LibMPFrameDesc,
  LibMPInstance,
  LibMPLogIteratorConfig,
  LibMPSession,
} from './libmp-vendor.js';

// 3: analysis moved to the MCP host. Whole recordings are analyzed (no event or
// frame-window limits), multi-segment streams are supported, and each result
// names the slowest frames with what ran inside them (spike_frames).
export const MICRO_PROFILER_SCHEMA_VERSION = 3;

const DEFAULT_MAX_TIMERS = 20;
const DEFAULT_MAX_GROUPS = 20;
const DEFAULT_MAX_TIMERS_PER_GROUP = 5;
const DEFAULT_MAX_RELATED_TIMERS = 3;
const DEFAULT_SPIKE_FRAMES = 3;
const MAX_SPIKE_FRAMES = 10;
const SPIKE_TOP_TIMERS = 8;
const SPIKE_TOP_THREADS = 4;
const SPIKE_HOT_PATH_THREADS = 2;
const SPIKE_HOT_PATH_DEPTH = 16;
// Frames before a spike frame replayed so scopes it inherits have their enters.
const SPIKE_WARMUP_FRAMES = 2;
const TOP_FRAMES = 10;
// Spans above this are corrupt.
const MAX_SPAN_US = 1e9;
// Median frame times near 66.7 ms match Studio's unfocused 15 fps throttle.
const UNFOCUSED_FRAME_US_MIN = 63_000;
const UNFOCUSED_FRAME_US_MAX = 70_000;
// A process that draws fewer than this share of its frames is throttled.
const THROTTLED_PRESENT_RATIO = 0.75;
const MIN_FRAMES_FOR_THROTTLE = 10;

const FOCUS_GROUP_MASKS: Record<string, string[]> = {
  all: [],
  script: ['Script', 'LuaBridge'],
  physics: ['Physics'],
  render: ['Render'],
  network: ['Network', 'RbxTransport', 'Replicator'],
  jobs: ['Jobs'],
};

export const MICRO_PROFILER_FOCUS_VALUES = Object.keys(FOCUS_GROUP_MASKS);

export interface MicroProfilerCaptureWindow {
  // First absolute frame recorded for this capture. Older frames in the
  // container (a stream starts with the engine's retained history) are skipped.
  startAbsoluteFrame?: number;
  // The plugin saw no frame of the capture before it timed out, so
  // startAbsoluteFrame is only a lower bound and cannot show dropped frames.
  startFrameEstimated?: boolean;
  // Frame being rendered when the capture was stopped. Later frames (written
  // while the stream caught up before stopping) are skipped.
  endAbsoluteFrame?: number;
  requestedDurationMs?: number;
  // Wall time the capture recorded, measured in Studio.
  captureWallMs?: number;
}

export interface MicroProfilerAnalysisOptions {
  focus?: string;
  filter?: string;
  maxTimers?: number;
  maxGroups?: number;
  maxTimersPerGroup?: number;
  maxRelatedTimers?: number;
  minTotalUs?: number;
  includeIdle?: boolean;
  includeGpu?: boolean;
  spikeFrames?: number;
  // Inclusive frame ID bounds, for focusing on part of a capture.
  startFrame?: number;
  endFrame?: number;
  window?: MicroProfilerCaptureWindow;
  targetRole?: string;
  includeComparisonIndex?: boolean;
}

type Row = Record<string, unknown>;

interface FrameInfo {
  id: number;
  absolute: number;
  startTick: bigint;
  endTick: bigint;
  paused: boolean;
  incomplete: boolean;
  range: number;
}

interface FrameRange {
  segment: number | undefined;
  begin: number;
  end: number;
}

interface TimerInfo {
  timer_id: number;
  name: string;
  group_id: number | undefined;
  group: string | undefined;
  is_user_timer: boolean;
}

interface ThreadInfo {
  thread_id: number;
  name: string;
  is_gpu: boolean;
}

interface StackEntry {
  timerId: number;
  enterTick: bigint;
  childUs: number;
  frameId: number;
}

interface TimerAggregate {
  id: number;
  inclusive_us: number;
  exclusive_us: number;
  count: number;
  max_us: number;
}

interface GroupAggregate {
  group: string;
  inclusive_us: number;
  exclusive_us: number;
  count: number;
}

interface EdgeAggregate {
  parent_timer_id: number;
  child_timer_id: number;
  inclusive_us: number;
  count: number;
  max_us: number;
}

let libmpInstance: Promise<LibMPInstance> | undefined;

function loadLibMP(): Promise<LibMPInstance> {
  libmpInstance ??= LibMP.create();
  return libmpInstance;
}

export async function libmpVersions(): Promise<{ Library: number; DataFormat: number }> {
  return (await loadLibMP()).Versions;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function roundUs(us: number): number {
  return Math.floor(us + 0.5);
}

function round2(value: number): number {
  return Math.floor(value * 100 + 0.5) / 100;
}

function perSecond(value: number, durationMs: number): number {
  return durationMs > 0 ? round2(value / (durationMs / 1000)) : value;
}

function percent(part: number, whole: number): number {
  return whole > 0 ? round2((part / whole) * 100) : 0;
}

function ratio(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return round2(numerator / denominator);
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(Math.max(Math.ceil(sortedValues.length * fraction), 1), sortedValues.length) - 1;
  return sortedValues[index];
}

function pickFields(row: Row, fields: string[]): Row {
  const out: Row = {};
  for (const field of fields) {
    if (row[field] !== undefined) out[field] = row[field];
  }
  return out;
}

function addFrameUs(map: Map<number, number>, frameId: number, us: number): void {
  if (frameId <= 0) return;
  map.set(frameId, (map.get(frameId) ?? 0) + us);
}

function byDescending<T extends Row>(field: string): (a: T, b: T) => number {
  return (a, b) => (b[field] as number) - (a[field] as number);
}

function summarizeFrameImpact(frameUsById: Map<number, number> | undefined, analyzedFrames: number): Row {
  if (frameUsById === undefined || frameUsById.size === 0) {
    return {
      active_frame_count: 0,
      active_frame_pct: 0,
      inclusive_us_per_frame: 0,
      p95_active_frame_inclusive_us: 0,
      max_frame_inclusive_us: 0,
    };
  }
  const values: number[] = [];
  let totalUs = 0;
  let maxUs = 0;
  let maxFrameId = 0;
  for (const [frameId, exactUs] of frameUsById) {
    const us = roundUs(exactUs);
    values.push(us);
    totalUs += us;
    if (us > maxUs) {
      maxUs = us;
      maxFrameId = frameId;
    }
  }
  values.sort((a, b) => a - b);
  return {
    active_frame_count: values.length,
    active_frame_pct: percent(values.length, analyzedFrames),
    inclusive_us_per_frame: analyzedFrames > 0 ? round2(totalUs / analyzedFrames) : totalUs,
    avg_active_frame_inclusive_us: round2(totalUs / values.length),
    p95_active_frame_inclusive_us: percentile(values, 0.95),
    max_frame_inclusive_us: maxUs,
    max_frame_id: maxFrameId,
  };
}

function isIdleTimer(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'idle' || lower.includes('sleep');
}

function recommendedToolsForGroups(groups: Row[], targetRole: string | undefined): Row[] {
  const tools: Row[] = [];
  const seen = new Set<string>();
  const target = targetRole ?? 'server';
  for (const row of groups) {
    const group = row.group;
    if (typeof group !== 'string' || seen.has(group)) continue;
    seen.add(group);
    if (group === 'Script' || group === 'LuaBridge') {
      tools.push({
        tool: 'capture_script_profiler',
        arguments: { target, duration_ms: 1000 },
        reason: 'Script/LuaBridge timers are present.',
      });
    } else if (group === 'Physics') {
      tools.push({ tool: 'get_scene_analysis', reason: 'Physics timers are present; inspect scene complexity.' });
    } else if (group === 'Render') {
      tools.push({ tool: 'capture_screenshot', reason: 'Render timers are present; inspect visible scene/UI state.' });
    } else if (group === 'Network' || group === 'RbxTransport' || group === 'Replicator') {
      tools.push({ tool: 'get_runtime_logs', reason: 'Network/replication timers are present; correlate with gameplay events.' });
    } else if (group === 'Jobs') {
      tools.push({
        tool: 'capture_micro_profiler',
        arguments: { action: 'analyze', focus: 'jobs' },
        reason: 'Jobs timers are present; re-analyze the saved capture narrowed to job lanes.',
      });
    }
    if (tools.length >= 3) break;
  }
  return tools;
}

class SessionNames {
  private readonly groups = new Map<number, string>();
  private readonly timers = new Map<number, TimerInfo>();
  private readonly threads = new Map<number, ThreadInfo>();

  constructor(private readonly session: LibMPSession) {}

  group(groupId: number | undefined): string | undefined {
    if (groupId === undefined) return undefined;
    const cached = this.groups.get(groupId);
    if (cached !== undefined) return cached;
    const desc = this.session.FetchGroupDesc(groupId);
    const name = desc && typeof desc.groupName === 'string' && desc.groupName !== '' ? desc.groupName : String(groupId);
    this.groups.set(groupId, name);
    return name;
  }

  timer(timerId: number): TimerInfo {
    const cached = this.timers.get(timerId);
    if (cached !== undefined) return cached;
    const desc = this.session.FetchTimerDesc(timerId);
    const groupId = desc && typeof desc.groupId === 'number' ? desc.groupId : undefined;
    const info: TimerInfo = {
      timer_id: timerId,
      name: desc && typeof desc.timerName === 'string' && desc.timerName !== '' ? desc.timerName : String(timerId),
      group_id: groupId,
      group: this.group(groupId),
      is_user_timer: desc?.isUserTimer === true,
    };
    this.timers.set(timerId, info);
    return info;
  }

  thread(threadId: number): ThreadInfo {
    const cached = this.threads.get(threadId);
    if (cached !== undefined) return cached;
    const desc = this.session.FetchThreadDesc(threadId);
    const info: ThreadInfo = {
      thread_id: threadId,
      name: desc && typeof desc.threadName === 'string' && desc.threadName.trim() !== '' ? desc.threadName.trim() : String(threadId),
      is_gpu: desc?.isGpu === true,
    };
    this.threads.set(threadId, info);
    return info;
  }
}

function frameRanges(session: LibMPSession): FrameRange[] {
  if (session.GetTrackCount() > 0 && session.SelectTrack(0)) {
    const ranges: FrameRange[] = [];
    session.FetchSegments(0).forEach((segment, index) => {
      if (segment.frameIdEnd >= segment.frameIdBegin && segment.frameIdBegin > 0) {
        ranges.push({ segment: index, begin: segment.frameIdBegin, end: segment.frameIdEnd });
      }
    });
    if (ranges.length > 0) return ranges;
  }
  const max = session.GetFrameIdMax();
  if (max <= 0) return [];
  return [{ segment: undefined, begin: Math.max(1, session.GetFrameIdMin()), end: max }];
}

function selectRange(session: LibMPSession, range: FrameRange): void {
  if (range.segment !== undefined) session.SelectSegment(range.segment);
}

// Render/Present runs once for each frame Studio draws to its window. The
// MicroProfiler frame follows the task scheduler, which keeps its rate while
// Studio draws less often, so counting frames with a Present shows how often
// Studio actually drew. Undefined when the capture has no Present timer.
function countPresentedFrames(session: LibMPSession, ranges: FrameRange[], frames: FrameInfo[], names: SessionNames): number | undefined {
  const presentIds = new Set<number>();
  for (const timerId of session.FetchTimerIds() ?? []) {
    const info = names.timer(timerId);
    if (info.name === 'Present' && info.group === 'Render') presentIds.add(timerId);
  }
  if (presentIds.size === 0 || frames.length === 0) return undefined;
  const frameIds = new Set(frames.map((frame) => frame.id));
  const presented = new Set<number>();
  const iterator = session.CreateLogIterator();
  try {
    const config: LibMPLogIteratorConfig = {
      SkipGpuThreads: true,
      SkipEvents: true,
      SkipPausedFrames: true,
      SkipFrameBoundaries: true,
    };
    const renderGroups = session.FindGroupIds('Render', false) ?? [];
    if (renderGroups.length > 0) config.GroupIds = renderGroups;
    iterator.Configure(config);
    const state = iterator.GetState();
    const first = frames[0];
    const last = frames[frames.length - 1];
    for (let rangeIndex = first.range; rangeIndex <= last.range; rangeIndex++) {
      const range = ranges[rangeIndex];
      const begin = rangeIndex === first.range ? Math.max(range.begin, first.id) : range.begin;
      const end = rangeIndex === last.range ? last.id : range.end;
      if (end < begin) continue;
      selectRange(session, range);
      iterator.RewindTo(begin, end);
      while (iterator.Step()) {
        if (state.isEnter() && presentIds.has(state.timerId()) && frameIds.has(state.frameId())) presented.add(state.frameId());
      }
    }
  } finally {
    iterator.Dispose();
  }
  return presented.size;
}

function readFrames(session: LibMPSession, ranges: FrameRange[]): FrameInfo[] {
  const frames: FrameInfo[] = [];
  ranges.forEach((range, rangeIndex) => {
    selectRange(session, range);
    for (let frameId = range.begin; frameId <= range.end; frameId++) {
      const desc: LibMPFrameDesc | null = session.FetchFrameDesc(frameId);
      if (!desc) continue;
      frames.push({
        id: frameId,
        absolute: desc.frameAbsoluteId,
        startTick: BigInt(desc.tickStartCpu),
        endTick: BigInt(desc.tickEndCpu),
        paused: desc.isPaused === true,
        incomplete: desc.isIncomplete === true,
        range: rangeIndex,
      });
    }
  });
  return frames;
}

function frameDurationUs(frame: FrameInfo, usPerTickCpu: number): number {
  return Number(frame.endTick - frame.startTick) * usPerTickCpu;
}

interface SpikeNode {
  timerId: number;
  enterTick: bigint;
  endTick: bigint;
  open: boolean;
  children: SpikeNode[];
  // Filled once the frame's tree is complete.
  inclusiveUs: number;
  busyUs: number;
}

interface SpikeStackEntry {
  node: SpikeNode;
  inFrame: boolean;
}

// Splits one frame's CPU work: per-thread busy time, the hottest timers by
// exclusive time, and the heaviest call path on the busiest threads. Scopes
// that cross the frame's edges count only the part inside the frame.
function breakdownFrame(
  session: LibMPSession,
  frame: FrameInfo,
  ranges: FrameRange[],
  frameOffsetMs: number,
  usPerTickCpu: number,
  names: SessionNames,
): Row {
  const range = ranges[frame.range];
  selectRange(session, range);
  const iterator = session.CreateLogIterator();
  const roots = new Map<number, SpikeNode[]>();
  const stacks = new Map<number, SpikeStackEntry[]>();
  try {
    iterator.Configure({ SkipGpuThreads: true, SkipEvents: true, SkipPausedFrames: true, SkipFrameBoundaries: true });
    const state = iterator.GetState();
    iterator.RewindTo(Math.max(range.begin, frame.id - SPIKE_WARMUP_FRAMES), frame.id);
    const attach = (threadId: number, stack: SpikeStackEntry[], node: SpikeNode) => {
      const parent = stack[stack.length - 1];
      if (parent !== undefined) {
        parent.node.children.push(node);
      } else {
        let threadRoots = roots.get(threadId);
        if (threadRoots === undefined) {
          threadRoots = [];
          roots.set(threadId, threadRoots);
        }
        threadRoots.push(node);
      }
    };
    while (iterator.Step()) {
      const frameId = state.frameId();
      if (frameId > frame.id) break;
      const threadId = state.threadId();
      let stack = stacks.get(threadId);
      if (stack === undefined) {
        stack = [];
        stacks.set(threadId, stack);
      }
      if (state.isEnter()) {
        stack.push({
          node: { timerId: state.timerId(), enterTick: state.timestamp(), endTick: 0n, open: false, children: [], inclusiveUs: 0, busyUs: 0 },
          inFrame: frameId === frame.id,
        });
      } else if (state.isExit()) {
        const timerId = state.timerId();
        let entry: SpikeStackEntry | undefined;
        while (stack.length > 0) {
          const candidate = stack.pop()!;
          if (candidate.node.timerId === timerId) {
            entry = candidate;
            break;
          }
        }
        if (entry === undefined || frameId !== frame.id) continue;
        const exitTick = state.timestamp();
        if (exitTick <= frame.startTick) continue;
        entry.node.endTick = exitTick;
        attach(threadId, stack, entry.node);
      }
    }
    // Scopes still running at the end of the frame fill the rest of it.
    for (const [threadId, stack] of stacks) {
      while (stack.length > 0) {
        const entry = stack.pop()!;
        entry.node.endTick = frame.endTick;
        entry.node.open = true;
        attach(threadId, stack, entry.node);
      }
    }
  } finally {
    iterator.Dispose();
  }

  const clippedUs = (node: SpikeNode): number => {
    const start = node.enterTick > frame.startTick ? node.enterTick : frame.startTick;
    const end = node.endTick < frame.endTick ? node.endTick : frame.endTick;
    return end > start ? Number(end - start) * usPerTickCpu : 0;
  };
  // Busy time leaves out idle scopes (Sleep) and everything under them, so a
  // worker waiting through a long frame does not read as the bottleneck.
  const timerTotals = new Map<number, { inclusive: number; exclusive: number; count: number }>();
  const visit = (node: SpikeNode): void => {
    const inclusive = clippedUs(node);
    let childUs = 0;
    let childBusyUs = 0;
    for (const child of node.children) {
      visit(child);
      childUs += child.inclusiveUs;
      childBusyUs += child.busyUs;
    }
    const idle = isIdleTimer(names.timer(node.timerId).name);
    const exclusive = Math.max(0, inclusive - childUs);
    node.inclusiveUs = inclusive;
    node.busyUs = idle ? 0 : exclusive + childBusyUs;
    const totals = timerTotals.get(node.timerId) ?? { inclusive: 0, exclusive: 0, count: 0 };
    totals.inclusive += inclusive;
    totals.exclusive += exclusive;
    totals.count += 1;
    timerTotals.set(node.timerId, totals);
  };
  const threadRows: { threadId: number; busyUs: number; roots: SpikeNode[] }[] = [];
  for (const [threadId, threadRoots] of roots) {
    let busyUs = 0;
    for (const root of threadRoots) {
      visit(root);
      busyUs += root.busyUs;
    }
    if (busyUs > 0) threadRows.push({ threadId, busyUs, roots: threadRoots });
  }
  threadRows.sort((a, b) => b.busyUs - a.busyUs);
  const durationUs = frameDurationUs(frame, usPerTickCpu);

  const describeNode = (node: SpikeNode): Row => {
    const info = names.timer(node.timerId);
    let childUs = 0;
    for (const child of node.children) childUs += child.inclusiveUs;
    const row: Row = {
      name: info.name,
      group: info.group ?? '<unknown>',
      inclusive_us: roundUs(node.inclusiveUs),
      exclusive_us: roundUs(Math.max(0, node.inclusiveUs - childUs)),
    };
    if (node.open) row.continues_past_frame = true;
    if (node.enterTick < frame.startTick) row.started_before_frame = true;
    return row;
  };
  // Follows the busiest scope at each level down to a leaf.
  const hotPath = (threadRoots: SpikeNode[]): Row[] => {
    const path: Row[] = [];
    let candidates = threadRoots;
    while (candidates.length > 0 && path.length < SPIKE_HOT_PATH_DEPTH) {
      let best = candidates[0];
      for (const candidate of candidates) {
        if (candidate.busyUs > best.busyUs) best = candidate;
      }
      if (best.busyUs <= 0) break;
      path.push(describeNode(best));
      candidates = best.children;
    }
    return path;
  };

  const topTimers = [...timerTotals.entries()]
    .map(([timerId, totals]) => {
      const info = names.timer(timerId);
      return {
        name: info.name,
        group: info.group ?? '<unknown>',
        exclusive_us: roundUs(totals.exclusive),
        inclusive_us: roundUs(totals.inclusive),
        count: totals.count,
      };
    })
    .filter((row) => row.exclusive_us > 0 && !isIdleTimer(row.name))
    .sort((a, b) => b.exclusive_us - a.exclusive_us)
    .slice(0, SPIKE_TOP_TIMERS);

  return {
    frame_id: frame.id,
    frame_absolute_id: frame.absolute,
    offset_ms: round2(frameOffsetMs),
    duration_us: roundUs(durationUs),
    threads: threadRows.slice(0, SPIKE_TOP_THREADS).map((row) => ({
      thread: names.thread(row.threadId).name,
      busy_us: roundUs(row.busyUs),
      busy_pct_of_frame: percent(row.busyUs, durationUs),
    })),
    top_timers_by_exclusive: topTimers,
    hot_paths: threadRows.slice(0, SPIKE_HOT_PATH_THREADS).map((row) => ({
      thread: names.thread(row.threadId).name,
      path: hotPath(row.roots),
    })),
  };
}

export async function analyzeMicroProfilerCapture(
  bytes: Uint8Array,
  options: MicroProfilerAnalysisOptions = {},
): Promise<Row> {
  const libmp = await loadLibMP();
  const session = libmp.Session.OpenFromBuffer(bytes);
  if (!session) {
    return {
      error: 'micro_profiler_decode_failed',
      message: 'LibMP could not open the capture. It is not a MicroProfiler capture, or it is damaged or truncated.',
      bytes: bytes.byteLength,
    };
  }
  try {
    if (!session.IsValid()) {
      return {
        error: 'micro_profiler_decode_failed',
        message: 'LibMP reports the capture invalid. It is not a MicroProfiler capture, or it is damaged or truncated.',
        bytes: bytes.byteLength,
      };
    }
    const result = analyzeMicroProfilerSession(session, options);
    result.libmp = { library_version: libmp.Versions.Library, data_format_version: session.GetDataFormatVersion() };
    return result;
  } finally {
    session.Dispose();
  }
}

export function analyzeMicroProfilerSession(session: LibMPSession, options: MicroProfilerAnalysisOptions = {}): Row {
  const focus = options.focus !== undefined && FOCUS_GROUP_MASKS[options.focus] !== undefined ? options.focus : 'all';
  const filter = typeof options.filter === 'string' && options.filter !== '' ? options.filter.toLowerCase() : undefined;
  const maxTimers = clampInteger(options.maxTimers, DEFAULT_MAX_TIMERS, 1, 100);
  const maxGroups = clampInteger(options.maxGroups, DEFAULT_MAX_GROUPS, 1, 100);
  const maxTimersPerGroup = clampInteger(options.maxTimersPerGroup, DEFAULT_MAX_TIMERS_PER_GROUP, 0, 20);
  const maxRelatedTimers = clampInteger(options.maxRelatedTimers, DEFAULT_MAX_RELATED_TIMERS, 0, 10);
  // A filtered query asks about a few timers; whole-frame breakdowns are opt-in there.
  const spikeFrameCount = clampInteger(options.spikeFrames, filter !== undefined ? 0 : DEFAULT_SPIKE_FRAMES, 0, MAX_SPIKE_FRAMES);
  const minTotalUs = options.minTotalUs !== undefined && Number.isFinite(options.minTotalUs) ? Math.max(0, options.minTotalUs) : 0;
  const includeIdle = options.includeIdle === true;
  const includeGpu = options.includeGpu === true;
  const window = options.window ?? {};

  const clock = session.FetchGlobalDesc();
  const tickToMsCpu = clock?.tickToMsCpu;
  const tickToMsGpu = clock?.tickToMsGpu;
  const validTick = (value: unknown): value is number => typeof value === 'number' && value > 0 && Number.isFinite(value);
  if (!validTick(tickToMsCpu) || (includeGpu && !validTick(tickToMsGpu))) {
    return {
      error: 'micro_profiler_clock_unavailable',
      message: 'The MicroProfiler capture did not report a valid tick length, so its times cannot be converted.',
      tick_to_ms_cpu: tickToMsCpu,
      tick_to_ms_gpu: tickToMsGpu,
    };
  }
  const usPerTickCpu = tickToMsCpu * 1000;
  const usPerTickGpu = validTick(tickToMsGpu) ? tickToMsGpu * 1000 : usPerTickCpu;

  const ranges = frameRanges(session);
  const allFrames = readFrames(session, ranges);
  let framesBeforeCapture = 0;
  let framesAfterCapture = 0;
  let framesOutsideRange = 0;
  let pausedFrames = 0;
  const candidates: FrameInfo[] = [];
  for (const frame of allFrames) {
    if (window.startAbsoluteFrame !== undefined && frame.absolute < window.startAbsoluteFrame) {
      framesBeforeCapture += 1;
      continue;
    }
    if (window.endAbsoluteFrame !== undefined && frame.absolute > window.endAbsoluteFrame) {
      framesAfterCapture += 1;
      continue;
    }
    if ((options.startFrame !== undefined && frame.id < options.startFrame) || (options.endFrame !== undefined && frame.id > options.endFrame)) {
      framesOutsideRange += 1;
      continue;
    }
    // Resuming capture records one frame spanning the whole pause; it holds no work.
    if (frame.paused) {
      pausedFrames += 1;
      continue;
    }
    candidates.push(frame);
  }
  const captureFrameMin = allFrames.length > 0 ? allFrames[0].id : 0;
  const captureFrameMax = allFrames.length > 0 ? allFrames[allFrames.length - 1].id : 0;
  if (candidates.length === 0) {
    const fromStudio = window.startAbsoluteFrame !== undefined && framesOutsideRange === 0;
    return {
      error: 'micro_profiler_no_frames',
      message: fromStudio
        ? 'Studio rendered no frames during the capture, so MicroProfiler recorded no data. Studio draws frames only while its window can be displayed, which stops when the display turns off (for example after the power-saving timeout) or Studio is minimized. Wake the display or restore Studio, then retry.'
        : `The capture has no frames in the selected range (it holds frames ${captureFrameMin}-${captureFrameMax}).`,
      capture_frame_min: captureFrameMin,
      capture_frame_max: captureFrameMax,
      frames_before_capture: framesBeforeCapture,
      frames_after_capture: framesAfterCapture,
      frames_outside_range: framesOutsideRange,
      paused_frames: pausedFrames,
    };
  }
  const candidateIds = new Set(candidates.map((frame) => frame.id));
  const names = new SessionNames(session);

  const focusGroupIds: number[] = [];
  for (const mask of FOCUS_GROUP_MASKS[focus]) {
    for (const id of session.FindGroupIds(mask, false) ?? []) {
      if (!focusGroupIds.includes(id)) focusGroupIds.push(id);
    }
  }

  // One pass over every event of the candidate frames, carrying scope stacks
  // across frame and segment boundaries. Iteration starts one frame early so
  // scopes open at the first frame have their enters.
  const stacks = new Map<number, StackEntry[]>();
  const threadUsPerTick = new Map<number, number>();
  const aggregates = new Map<number, TimerAggregate>();
  const timerThreadAggregates = new Map<number, Map<number, TimerAggregate>>();
  const timerFrameAggregates = new Map<number, Map<number, number>>();
  const edgeAggregates = new Map<string, EdgeAggregate>();
  const framesWithEvents = new Set<number>();
  let events = 0;
  let enterEvents = 0;
  let exitEvents = 0;
  let unmatchedExits = 0;
  let droppedSpans = 0;

  const addTimerAggregate = (map: Map<number, TimerAggregate>, id: number, inclusiveUs: number, exclusiveUs: number) => {
    let aggregate = map.get(id);
    if (aggregate === undefined) {
      aggregate = { id, inclusive_us: 0, exclusive_us: 0, count: 0, max_us: 0 };
      map.set(id, aggregate);
    }
    aggregate.inclusive_us += inclusiveUs;
    aggregate.exclusive_us += exclusiveUs;
    aggregate.count += 1;
    if (inclusiveUs > aggregate.max_us) aggregate.max_us = inclusiveUs;
  };

  const firstCandidate = candidates[0];
  const lastCandidate = candidates[candidates.length - 1];
  const iterator = session.CreateLogIterator();
  try {
    const config: LibMPLogIteratorConfig = {
      SkipGpuThreads: !includeGpu,
      SkipEvents: true,
      SkipPausedFrames: true,
      SkipFrameBoundaries: true,
    };
    if (focusGroupIds.length > 0) config.GroupIds = focusGroupIds;
    iterator.Configure(config);
    const state = iterator.GetState();
    let previousEnd: number | undefined;
    for (let rangeIndex = firstCandidate.range; rangeIndex <= lastCandidate.range; rangeIndex++) {
      const range = ranges[rangeIndex];
      const begin = rangeIndex === firstCandidate.range ? Math.max(range.begin, firstCandidate.id - 1) : range.begin;
      const end = rangeIndex === lastCandidate.range ? lastCandidate.id : range.end;
      if (end < begin) continue;
      // A gap between ranges breaks scope continuity.
      if (previousEnd !== undefined && begin !== previousEnd + 1) stacks.clear();
      previousEnd = end;
      selectRange(session, range);
      iterator.RewindTo(begin, end);
      while (iterator.Step()) {
        const frameId = state.frameId();
        const threadId = state.threadId();
        const timerId = state.timerId();
        const timestamp = state.timestamp();
        const counted = candidateIds.has(frameId);
        let usPerTick = threadUsPerTick.get(threadId);
        if (usPerTick === undefined) {
          usPerTick = state.isGpuThread() ? usPerTickGpu : usPerTickCpu;
          threadUsPerTick.set(threadId, usPerTick);
        }
        let stack = stacks.get(threadId);
        if (stack === undefined) {
          stack = [];
          stacks.set(threadId, stack);
        }
        if (counted) {
          events += 1;
          framesWithEvents.add(frameId);
        }
        if (state.isEnter()) {
          if (counted) enterEvents += 1;
          stack.push({ timerId, enterTick: timestamp, childUs: 0, frameId });
        } else if (state.isExit()) {
          if (counted) exitEvents += 1;
          let entry: StackEntry | undefined;
          while (stack.length > 0) {
            const candidate = stack.pop()!;
            if (candidate.timerId === timerId) {
              entry = candidate;
              break;
            }
          }
          if (entry === undefined) {
            if (counted) unmatchedExits += 1;
            continue;
          }
          const inclusiveUs = Number(timestamp - entry.enterTick) * usPerTick;
          if (inclusiveUs < 0 || inclusiveUs > MAX_SPAN_US) {
            if (counted) droppedSpans += 1;
            continue;
          }
          const parent = stack[stack.length - 1];
          if (parent !== undefined) parent.childUs += inclusiveUs;
          if (!counted) continue;
          const exclusiveUs = Math.max(0, inclusiveUs - entry.childUs);
          if (parent !== undefined) {
            const edgeKey = `${parent.timerId}:${timerId}`;
            let edge = edgeAggregates.get(edgeKey);
            if (edge === undefined) {
              edge = { parent_timer_id: parent.timerId, child_timer_id: timerId, inclusive_us: 0, count: 0, max_us: 0 };
              edgeAggregates.set(edgeKey, edge);
            }
            edge.inclusive_us += inclusiveUs;
            edge.count += 1;
            if (inclusiveUs > edge.max_us) edge.max_us = inclusiveUs;
          }
          addTimerAggregate(aggregates, timerId, inclusiveUs, exclusiveUs);
          let frameMap = timerFrameAggregates.get(timerId);
          if (frameMap === undefined) {
            frameMap = new Map();
            timerFrameAggregates.set(timerId, frameMap);
          }
          addFrameUs(frameMap, candidateIds.has(entry.frameId) ? entry.frameId : frameId, inclusiveUs);
          let threadMap = timerThreadAggregates.get(timerId);
          if (threadMap === undefined) {
            threadMap = new Map();
            timerThreadAggregates.set(timerId, threadMap);
          }
          addTimerAggregate(threadMap, threadId, inclusiveUs, exclusiveUs);
        }
      }
    }
  } finally {
    iterator.Dispose();
  }

  // The first frames after capture starts can carry no scope events yet, so
  // the analyzed window runs from the first to the last frame with events.
  let analyzed = candidates;
  if (framesWithEvents.size > 0) {
    let first = 0;
    while (first < candidates.length && !framesWithEvents.has(candidates[first].id)) first += 1;
    let last = candidates.length - 1;
    while (last > first && !framesWithEvents.has(candidates[last].id)) last -= 1;
    analyzed = candidates.slice(first, last + 1);
  }
  const framesWithoutEventsTrimmed = candidates.length - analyzed.length;

  // Frame summary: frame durations from the CPU frame boundaries.
  const durations: number[] = [];
  const frameRows: Row[] = [];
  let incompleteFrames = 0;
  const windowStartTick = analyzed[0].startTick;
  const frameOffsetMs = (frame: FrameInfo) => (Number(frame.startTick - windowStartTick) * usPerTickCpu) / 1000;
  const timedFrames: { frame: FrameInfo; durationUs: number }[] = [];
  for (const frame of analyzed) {
    if (frame.incomplete) incompleteFrames += 1;
    const exactUs = frameDurationUs(frame, usPerTickCpu);
    if (exactUs <= 0 || exactUs > MAX_SPAN_US) continue;
    const durationUs = roundUs(exactUs);
    durations.push(durationUs);
    timedFrames.push({ frame, durationUs });
  }
  timedFrames.sort((a, b) => b.durationUs - a.durationUs);
  for (const { frame, durationUs } of timedFrames.slice(0, TOP_FRAMES)) {
    const row: Row = {
      frame_id: frame.id,
      frame_absolute_id: frame.absolute,
      offset_ms: round2(frameOffsetMs(frame)),
      duration_us: durationUs,
    };
    if (frame.incomplete) row.incomplete = true;
    frameRows.push(row);
  }
  durations.sort((a, b) => a - b);
  const totalFrameUs = durations.reduce((sum, value) => sum + value, 0);
  const frameCount = durations.length;
  const frameSummary: Row = {
    frames: frameCount,
    total_duration_us: totalFrameUs,
    avg_us: frameCount > 0 ? round2(totalFrameUs / frameCount) : 0,
    p50_us: percentile(durations, 0.5),
    p95_us: percentile(durations, 0.95),
    p99_us: percentile(durations, 0.99),
    max_us: frameCount > 0 ? durations[frameCount - 1] : 0,
    frames_over_16_7ms: durations.filter((value) => value > 16_700).length,
    frames_over_33_3ms: durations.filter((value) => value > 33_300).length,
    incomplete_frames: incompleteFrames,
    paused_frames: pausedFrames,
    top_frames: frameRows,
  };
  const analysisFrameCount = frameCount > 0 ? frameCount : analyzed.length;
  const analysisDurationUs = totalFrameUs > 0 ? totalFrameUs : (window.requestedDurationMs ?? 0) * 1000;
  const analysisDurationMs = analysisDurationUs / 1000;
  const analysisSeconds = analysisDurationMs / 1000;
  frameSummary.frames_per_second = analysisSeconds > 0 ? round2(frameCount / analysisSeconds) : 0;
  const presentedFrames = countPresentedFrames(session, ranges, analyzed, names);
  if (presentedFrames !== undefined) {
    frameSummary.presented_frames = presentedFrames;
    frameSummary.presented_fps = analysisSeconds > 0 ? round2(presentedFrames / analysisSeconds) : 0;
  }

  // Timer, group, thread, and call-edge rows.
  const rows: Row[] = [];
  const rowsByTimerId = new Map<number, Row>();
  const groupAggregates = new Map<string, GroupAggregate>();
  const groupTimerRows = new Map<string, Row[]>();
  const groupFrameAggregates = new Map<string, Map<number, number>>();
  const threadAggregates = new Map<number, TimerAggregate>();
  const threadTimerRows = new Map<number, Row[]>();
  let omittedIdle = 0;
  let omittedBelowThreshold = 0;
  let omittedByFilter = 0;

  for (const [timerId, aggregate] of aggregates) {
    const info = names.timer(timerId);
    const totalUs = roundUs(aggregate.inclusive_us);
    if (!includeIdle && isIdleTimer(info.name)) {
      omittedIdle += 1;
      continue;
    }
    if (totalUs < minTotalUs) {
      omittedBelowThreshold += 1;
      continue;
    }
    if (filter !== undefined && !`${info.name} ${info.group ?? ''}`.toLowerCase().includes(filter)) {
      omittedByFilter += 1;
      continue;
    }
    const group = info.group ?? '<unknown>';
    const exclusiveUs = roundUs(aggregate.exclusive_us);
    const avgUs = aggregate.count > 0 ? round2(totalUs / aggregate.count) : 0;
    const maxUs = roundUs(aggregate.max_us);
    let groupAggregate = groupAggregates.get(group);
    if (groupAggregate === undefined) {
      groupAggregate = { group, inclusive_us: 0, exclusive_us: 0, count: 0 };
      groupAggregates.set(group, groupAggregate);
    }
    groupAggregate.inclusive_us += aggregate.inclusive_us;
    groupAggregate.exclusive_us += aggregate.exclusive_us;
    groupAggregate.count += aggregate.count;

    const row: Row = {
      timer_id: timerId,
      name: info.name,
      group,
      inclusive_us: totalUs,
      inclusive_us_per_s: perSecond(totalUs, analysisDurationMs),
      exclusive_us: exclusiveUs,
      exclusive_pct: percent(exclusiveUs, totalUs),
      count: aggregate.count,
      count_per_s: perSecond(aggregate.count, analysisDurationMs),
      count_per_frame: analysisFrameCount > 0 ? round2(aggregate.count / analysisFrameCount) : aggregate.count,
      avg_invocation_us: avgUs,
      max_invocation_us: maxUs,
      pct_of_analyzed_wall: percent(totalUs, analysisDurationUs),
    };
    const maxToAvg = ratio(maxUs, avgUs);
    if (maxToAvg !== undefined) row.max_to_avg = maxToAvg;
    Object.assign(row, summarizeFrameImpact(timerFrameAggregates.get(timerId), analysisFrameCount));
    if (info.is_user_timer) row.is_user_timer = true;
    rows.push(row);
    rowsByTimerId.set(timerId, row);
    let timerRows = groupTimerRows.get(group);
    if (timerRows === undefined) {
      timerRows = [];
      groupTimerRows.set(group, timerRows);
    }
    timerRows.push(row);
    const timerFrames = timerFrameAggregates.get(timerId);
    if (timerFrames !== undefined) {
      let groupFrames = groupFrameAggregates.get(group);
      if (groupFrames === undefined) {
        groupFrames = new Map();
        groupFrameAggregates.set(group, groupFrames);
      }
      for (const [frameId, us] of timerFrames) addFrameUs(groupFrames, frameId, us);
    }

    const perThread = timerThreadAggregates.get(timerId);
    if (perThread !== undefined) {
      const timerThreadRows: Row[] = [];
      for (const [threadId, threadAggregate] of perThread) {
        let threadTotal = threadAggregates.get(threadId);
        if (threadTotal === undefined) {
          threadTotal = { id: threadId, inclusive_us: 0, exclusive_us: 0, count: 0, max_us: 0 };
          threadAggregates.set(threadId, threadTotal);
        }
        threadTotal.inclusive_us += threadAggregate.inclusive_us;
        threadTotal.exclusive_us += threadAggregate.exclusive_us;
        threadTotal.count += threadAggregate.count;
        if (threadAggregate.max_us > threadTotal.max_us) threadTotal.max_us = threadAggregate.max_us;

        let threadRows = threadTimerRows.get(threadId);
        if (threadRows === undefined) {
          threadRows = [];
          threadTimerRows.set(threadId, threadRows);
        }
        const threadInfo = names.thread(threadId);
        const threadTotalUs = roundUs(threadAggregate.inclusive_us);
        const threadExclusiveUs = roundUs(threadAggregate.exclusive_us);
        const threadAvgUs = threadAggregate.count > 0 ? round2(threadTotalUs / threadAggregate.count) : 0;
        const threadTimerRow: Row = {
          thread_id: threadId,
          thread_name: threadInfo.name,
          is_gpu: threadInfo.is_gpu || undefined,
          timer_id: timerId,
          name: info.name,
          group,
          inclusive_us: threadTotalUs,
          inclusive_us_per_s: perSecond(threadTotalUs, analysisDurationMs),
          exclusive_us: threadExclusiveUs,
          count: threadAggregate.count,
          count_per_s: perSecond(threadAggregate.count, analysisDurationMs),
          avg_invocation_us: threadAvgUs,
          max_invocation_us: roundUs(threadAggregate.max_us),
        };
        const threadMaxToAvg = ratio(threadTimerRow.max_invocation_us as number, threadAvgUs);
        if (threadMaxToAvg !== undefined) threadTimerRow.max_to_avg = threadMaxToAvg;
        threadRows.push(threadTimerRow);
        timerThreadRows.push({
          thread_id: threadId,
          thread_name: threadInfo.name,
          is_gpu: threadInfo.is_gpu || undefined,
          inclusive_us: threadTotalUs,
          exclusive_us: threadExclusiveUs,
          count: threadAggregate.count,
        });
      }
      timerThreadRows.sort(byDescending('inclusive_us'));
      if (maxRelatedTimers > 0 && timerThreadRows.length > 0) row.top_threads = timerThreadRows.slice(0, maxRelatedTimers);
    }
  }
  rows.sort(byDescending('inclusive_us'));

  const edgeRows: Row[] = [];
  const parentRelationsByChild = new Map<number, Row[]>();
  const childRelationsByParent = new Map<number, Row[]>();
  for (const edge of edgeAggregates.values()) {
    const parentRow = rowsByTimerId.get(edge.parent_timer_id);
    const childRow = rowsByTimerId.get(edge.child_timer_id);
    if (parentRow === undefined || childRow === undefined) continue;
    const inclusiveUs = roundUs(edge.inclusive_us);
    const maxUs = roundUs(edge.max_us);
    const avgUs = edge.count > 0 ? round2(inclusiveUs / edge.count) : 0;
    const edgeRow: Row = {
      parent: { timer_id: edge.parent_timer_id, name: parentRow.name, group: parentRow.group },
      child: { timer_id: edge.child_timer_id, name: childRow.name, group: childRow.group },
      inclusive_us: inclusiveUs,
      inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
      count: edge.count,
      count_per_s: perSecond(edge.count, analysisDurationMs),
      avg_invocation_us: avgUs,
      max_invocation_us: maxUs,
    };
    const maxToAvg = ratio(maxUs, avgUs);
    if (maxToAvg !== undefined) edgeRow.max_to_avg = maxToAvg;
    edgeRows.push(edgeRow);

    const parents = parentRelationsByChild.get(edge.child_timer_id) ?? [];
    parents.push({
      timer_id: edge.parent_timer_id,
      name: parentRow.name,
      group: parentRow.group,
      inclusive_us: inclusiveUs,
      count: edge.count,
      pct_of_timer_inclusive: percent(inclusiveUs, childRow.inclusive_us as number),
    });
    parentRelationsByChild.set(edge.child_timer_id, parents);
    const children = childRelationsByParent.get(edge.parent_timer_id) ?? [];
    children.push({
      timer_id: edge.child_timer_id,
      name: childRow.name,
      group: childRow.group,
      inclusive_us: inclusiveUs,
      count: edge.count,
      pct_of_timer_inclusive: percent(inclusiveUs, parentRow.inclusive_us as number),
    });
    childRelationsByParent.set(edge.parent_timer_id, children);
  }
  edgeRows.sort(byDescending('inclusive_us'));
  if (maxRelatedTimers > 0) {
    for (const row of rows) {
      const timerId = row.timer_id as number;
      const parents = parentRelationsByChild.get(timerId);
      const children = childRelationsByParent.get(timerId);
      if (parents !== undefined && parents.length > 0) row.top_parents = parents.sort(byDescending('inclusive_us')).slice(0, maxRelatedTimers);
      if (children !== undefined && children.length > 0) row.top_children = children.sort(byDescending('inclusive_us')).slice(0, maxRelatedTimers);
    }
  }

  const ranked = (source: Row[], limit: number): Row[] => source.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
  const topTimers = ranked(rows, maxTimers);
  // The exclusive rankings reuse rows already listed in full above, so they
  // carry only what ranks them.
  const topTimersByExclusive = ranked([...rows].sort(byDescending('exclusive_us')), maxTimers).map((row) => pickFields(row, [
    'rank', 'timer_id', 'name', 'group', 'exclusive_us', 'exclusive_pct', 'inclusive_us', 'count', 'avg_invocation_us',
    'max_invocation_us', 'max_frame_inclusive_us', 'max_frame_id',
  ]));
  const topEdges = ranked(edgeRows, maxTimers);

  const threadRows: Row[] = [];
  for (const [threadId, aggregate] of threadAggregates) {
    const info = names.thread(threadId);
    const inclusiveUs = roundUs(aggregate.inclusive_us);
    const exclusiveUs = roundUs(aggregate.exclusive_us);
    const row: Row = {
      thread_id: threadId,
      thread_name: info.name,
      is_gpu: info.is_gpu || undefined,
      inclusive_us: inclusiveUs,
      inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
      exclusive_us: exclusiveUs,
      exclusive_pct: percent(exclusiveUs, inclusiveUs),
      count: aggregate.count,
      count_per_s: perSecond(aggregate.count, analysisDurationMs),
      max_invocation_us: roundUs(aggregate.max_us),
      pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
    };
    const timerRows = (threadTimerRows.get(threadId) ?? []).sort(byDescending('inclusive_us'));
    if (maxTimersPerGroup > 0 && timerRows.length > 0) {
      row.top_timers = timerRows.slice(0, maxTimersPerGroup).map((timerRow) => pickFields(timerRow, [
        'timer_id', 'name', 'group', 'inclusive_us', 'exclusive_us', 'count', 'max_invocation_us',
      ]));
    }
    threadRows.push(row);
  }
  threadRows.sort(byDescending('inclusive_us'));
  const topThreads = ranked(threadRows, maxGroups);

  const groupRows: Row[] = [];
  for (const aggregate of groupAggregates.values()) {
    const timerRows = (groupTimerRows.get(aggregate.group) ?? []).sort(byDescending('inclusive_us'));
    const inclusiveUs = roundUs(aggregate.inclusive_us);
    const exclusiveUs = roundUs(aggregate.exclusive_us);
    const groupRow: Row = {
      group: aggregate.group,
      inclusive_us: inclusiveUs,
      inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
      exclusive_us: exclusiveUs,
      exclusive_pct: percent(exclusiveUs, inclusiveUs),
      count: aggregate.count,
      count_per_s: perSecond(aggregate.count, analysisDurationMs),
      count_per_frame: analysisFrameCount > 0 ? round2(aggregate.count / analysisFrameCount) : aggregate.count,
      timer_count: timerRows.length,
      pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
      ...summarizeFrameImpact(groupFrameAggregates.get(aggregate.group), analysisFrameCount),
    };
    if (maxTimersPerGroup > 0 && timerRows.length > 0) {
      groupRow.top_timers = timerRows.slice(0, maxTimersPerGroup).map((timerRow) => pickFields(timerRow, [
        'timer_id', 'name', 'inclusive_us', 'inclusive_us_per_s', 'exclusive_us', 'count', 'max_invocation_us', 'max_frame_inclusive_us',
      ]));
    }
    groupRows.push(groupRow);
  }
  groupRows.sort(byDescending('inclusive_us'));
  const topGroups = ranked(groupRows, maxGroups);
  const topGroupsByExclusive = ranked([...groupRows].sort(byDescending('exclusive_us')), maxGroups).map((row) => pickFields(row, [
    'rank', 'group', 'exclusive_us', 'exclusive_pct', 'inclusive_us', 'count', 'timer_count',
  ]));

  const spikeFrames = timedFrames.slice(0, spikeFrameCount).map(({ frame }) =>
    breakdownFrame(session, frame, ranges, frameOffsetMs(frame), usPerTickCpu, names));

  let openStackEntriesAtEnd = 0;
  for (const stack of stacks.values()) openStackEntriesAtEnd += stack.length;
  const omitted: Record<string, number> = {};
  if (omittedIdle > 0) omitted.idle = omittedIdle;
  if (omittedBelowThreshold > 0) omitted.below_min_total_us = omittedBelowThreshold;
  if (omittedByFilter > 0) omitted.filtered_out = omittedByFilter;

  const captureWallMs = window.captureWallMs;
  const partialReasons: string[] = [];
  const notes: string[] = [];
  if (focus !== 'all') {
    notes.push('focus filters events before stack aggregation; exclusive_us is exclusive within emitted focused events, not the full capture.');
  }
  const avgFrameUs = frameCount > 0 ? totalFrameUs / frameCount : 0;
  const rangeLimited = options.startFrame !== undefined || options.endFrame !== undefined;
  // Frames recorded for the capture that the container no longer holds: Studio's
  // live history drops its oldest frames once its memory target fills.
  const framesDropped = window.startAbsoluteFrame !== undefined && !window.startFrameEstimated && !rangeLimited
    ? Math.max(0, candidates[0].absolute - window.startAbsoluteFrame)
    : 0;
  // A stream stopped before it wrote the frames up to the stop request.
  const framesMissingAtEnd = window.endAbsoluteFrame !== undefined && !rangeLimited
    ? Math.max(0, window.endAbsoluteFrame - candidates[candidates.length - 1].absolute)
    : 0;
  if (framesMissingAtEnd > 1) {
    partialReasons.push('capture_end_missing');
    notes.push(`The recording ends ${framesMissingAtEnd} frames before the capture was stopped, so its last ${framesMissingAtEnd} frames are not analyzed.`);
  }
  if (framesDropped > 0) {
    partialReasons.push('capture_history_truncated');
    notes.push(`Studio's MicroProfiler history dropped the first ${framesDropped} frames of this capture before it was read, so the analysis covers ${roundUs(analysisDurationMs)} ms of the capture.`);
  }
  const coverageShort = captureWallMs !== undefined && !rangeLimited && framesDropped === 0 && framesMissingAtEnd <= 1
    && captureWallMs - analysisDurationMs > Math.max(captureWallMs * 0.1, (2 * avgFrameUs) / 1000);
  if (coverageShort) {
    partialReasons.push('capture_coverage_below_requested');
    notes.push(`The analyzed frames cover ${roundUs(analysisDurationMs)} ms of the ${roundUs(captureWallMs)} ms capture. Times and rates are correct for that span.`);
  }
  // Studio draws about 15 frames per second when its window is not focused, so
  // frame times there say little about the game. The whole process can slow to
  // that rate, or keep simulating at about 60 Hz while drawing every few frames.
  const medianFrameUs = percentile(durations, 0.5);
  let renderThrottled = false;
  if (frameCount >= 5 && medianFrameUs >= UNFOCUSED_FRAME_US_MIN && medianFrameUs <= UNFOCUSED_FRAME_US_MAX) {
    renderThrottled = true;
    notes.push(`The median frame took ${round2(medianFrameUs / 1000)} ms, about 15 frames per second: the rate Studio draws at when its window is not focused. If the game should run faster, bring Studio to the front and capture again.`);
  } else if (presentedFrames !== undefined && presentedFrames > 0 && frameCount >= MIN_FRAMES_FOR_THROTTLE
    && presentedFrames < frameCount * THROTTLED_PRESENT_RATIO) {
    renderThrottled = true;
    notes.push(`Studio drew ${frameSummary.presented_fps} frames per second while this Studio process ran ${frameSummary.frames_per_second}: it draws less often than it simulates, as it does while its window is in the background (about 15 fps). Rendering and per-frame costs reflect that reduced rate, not the game at full speed; bring Studio to the front and capture again.`);
  }

  let comparisonIndex: Row | undefined;
  if (options.includeComparisonIndex === true) {
    comparisonIndex = {
      timers: rows.map((row) => pickFields(row, [
        'timer_id', 'name', 'group', 'inclusive_us', 'inclusive_us_per_s', 'exclusive_us', 'count', 'count_per_s',
        'active_frame_count', 'inclusive_us_per_frame', 'max_frame_inclusive_us', 'max_frame_id',
      ])),
      groups: groupRows.map((row) => pickFields(row, [
        'group', 'inclusive_us', 'inclusive_us_per_s', 'exclusive_us', 'count', 'timer_count',
        'active_frame_count', 'inclusive_us_per_frame', 'max_frame_inclusive_us', 'max_frame_id',
      ])),
      threads: threadRows.map((row) => pickFields(row, [
        'thread_id', 'thread_name', 'is_gpu', 'inclusive_us', 'inclusive_us_per_s', 'exclusive_us', 'count',
      ])),
      call_edges: edgeRows.map((row) => pickFields(row, [
        'parent', 'child', 'inclusive_us', 'inclusive_us_per_s', 'count', 'max_invocation_us',
      ])),
    };
  }

  const analysisWindow: Row = {
    analysis_duration_us: analysisDurationUs,
    analyzed_frame_min: analyzed[0].id,
    analyzed_frame_max: analyzed[analyzed.length - 1].id,
    analyzed_frame_count: analysisFrameCount,
    analyzed_absolute_frame_min: analyzed[0].absolute,
    analyzed_absolute_frame_max: analyzed[analyzed.length - 1].absolute,
    capture_frame_min: captureFrameMin,
    capture_frame_max: captureFrameMax,
    segments: ranges.length,
    frames_before_capture: framesBeforeCapture,
    frames_after_capture: framesAfterCapture,
    frames_outside_range: framesOutsideRange,
    frames_without_events_trimmed: framesWithoutEventsTrimmed,
    frames_dropped: framesDropped,
    frames_missing_at_end: framesMissingAtEnd,
  };
  if (window.requestedDurationMs !== undefined) analysisWindow.requested_duration_ms = window.requestedDurationMs;
  if (captureWallMs !== undefined) {
    analysisWindow.capture_wall_ms = round2(captureWallMs);
    analysisWindow.coverage_pct = percent(analysisDurationMs, captureWallMs);
  }
  if (options.startFrame !== undefined) analysisWindow.start_frame = options.startFrame;
  if (options.endFrame !== undefined) analysisWindow.end_frame = options.endFrame;

  const result: Row = {
    schema_version: MICRO_PROFILER_SCHEMA_VERSION,
    ok: true,
    scope: 'micro_profiler',
    time_unit: 'microseconds',
    time_basis: "MicroProfiler ticks converted with the capture's clock (GlobalDesc TickToMsCpu; TickToMsGpu for the GPU thread). inclusive_us is cumulative nested timer time and can overlap across nested timers/threads; do not sum rows as total frame time.",
    clock: { tick_to_ms_cpu: tickToMsCpu, tick_to_ms_gpu: tickToMsGpu },
    analysis_window: analysisWindow,
    applied: {
      focus,
      filter: options.filter || undefined,
      include_idle: includeIdle,
      include_gpu: includeGpu,
      min_total_us: minTotalUs,
      max_groups: maxGroups,
      max_timers: maxTimers,
      max_timers_per_group: maxTimersPerGroup,
      max_related_timers: maxRelatedTimers,
      spike_frames: spikeFrameCount,
      sort: 'inclusive_us_desc',
    },
    counts: {
      timers: session.FetchTimerIds()?.length ?? 0,
      threads: session.FetchThreadIds()?.length ?? 0,
      events,
      enter_events: enterEvents,
      exit_events: exitEvents,
      unmatched_exits: unmatchedExits,
      dropped_spans: droppedSpans,
      open_stack_entries_at_end: openStackEntriesAtEnd,
    },
    frame_summary: frameSummary,
    spike_frames: spikeFrames,
    top_groups: topGroups,
    top_groups_by_exclusive: topGroupsByExclusive,
    top_threads: topThreads,
    top_call_edges: topEdges,
    top_timers: topTimers,
    top_timers_by_exclusive: topTimersByExclusive,
    data_quality: {
      unmatched_exits: unmatchedExits,
      dropped_spans: droppedSpans,
      open_stack_entries_at_end: openStackEntriesAtEnd,
      render_throttled: renderThrottled,
      partial: partialReasons.length > 0,
      partial_reasons: partialReasons,
      notes: notes.length > 0 ? notes : undefined,
    },
    recommended_tools: recommendedToolsForGroups(topGroups, options.targetRole),
  };
  if (Object.keys(omitted).length > 0) result.omitted = omitted;
  if (comparisonIndex !== undefined) result.comparison_index = comparisonIndex;
  return result;
}

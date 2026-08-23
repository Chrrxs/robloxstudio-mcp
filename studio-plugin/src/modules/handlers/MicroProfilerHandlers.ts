import { RunService } from "@rbxts/services";

interface LibMPControl {
	EnableProfiler(this: LibMPControl, enable: boolean): boolean;
	EnableCapture(this: LibMPControl, enable: boolean): boolean;
	CaptureToBufferSync(this: LibMPControl): buffer;
	IsBackendAccessible(this: LibMPControl): boolean;
	IsBackendReady(this: LibMPControl): boolean;
	IsBackendVersionCompatible(this: LibMPControl): boolean;
}

interface LibMPLike {
	Control: LibMPControl;
	Session: {
		OpenFromBuffer(this: void, data: buffer): LibMPSession | undefined;
	};
	Versions?: Record<string, unknown>;
	GetMemUsed?: () => number;
}

interface LibMPSession {
	IsValid(this: LibMPSession): boolean;
	SyncWithDataSource(this: LibMPSession): boolean;
	GetDataFormatVersion(this: LibMPSession): number;
	GetObjSize(this: LibMPSession): number;
	FetchTimerIds(this: LibMPSession): number[];
	FetchThreadIds(this: LibMPSession): number[];
	FetchThreadDesc(this: LibMPSession, threadId: number): ThreadDesc | undefined;
	GetFrameIdMin(this: LibMPSession): number;
	GetFrameIdMax(this: LibMPSession): number;
	GetFrameDesc(this: LibMPSession, frameId: number): FrameDesc | undefined;
	FetchTimerDesc(this: LibMPSession, timerId: number): TimerDesc | undefined;
	FetchGroupDesc(this: LibMPSession, groupId: number): GroupDesc | undefined;
	FindGroupIds(this: LibMPSession, nameMask: string, caseSensitive?: boolean): number[];
	FindTimerIds(this: LibMPSession, nameMask: string, caseSensitive?: boolean): number[];
	CreateLogIterator(this: LibMPSession): LogIterator;
	Dispose(this: LibMPSession): void;
}

interface TimerDesc {
	TimerId?: number;
	TimerName?: string;
	GroupId?: number;
	IsUserTimer?: boolean;
}

interface GroupDesc {
	GroupId?: number;
	GroupName?: string;
	IsGpu?: boolean;
}

interface ThreadDesc {
	ThreadId?: number;
	ThreadName?: string;
	BufferSize?: number;
	IsGpu?: boolean;
}

interface FrameDesc {
	FrameId(this: FrameDesc): number;
	TickStartCpu(this: FrameDesc): number;
	TickEndCpu(this: FrameDesc): number;
	IsIncomplete(this: FrameDesc): boolean;
	IsPaused(this: FrameDesc): boolean;
}

interface LogIterator {
	Configure(this: LogIterator, config: Record<string, unknown>): void;
	Step(this: LogIterator): boolean;
	GetState(this: LogIterator): LogIteratorState | undefined;
	Dispose(this: LogIterator): void;
}

interface LogIteratorState {
	FrameId(this: LogIteratorState): number;
	ThreadId(this: LogIteratorState): number;
	TimerId(this: LogIteratorState): number;
	Timestamp(this: LogIteratorState): number;
	IsEnter(this: LogIteratorState): boolean;
	IsExit(this: LogIteratorState): boolean;
}

interface StackEntry {
	timerId: number;
	timestampRaw: number;
	childRaw: number;
	frameId: number;
}

interface TimerInfo {
	timer_id: number;
	name: string;
	group_id?: number;
	group?: string;
	is_user_timer?: boolean;
}

interface TimerAggregate {
	timer_id: number;
	inclusive_raw: number;
	exclusive_raw: number;
	count: number;
	max_raw: number;
}

interface GroupAggregate {
	group: string;
	inclusive_raw: number;
	exclusive_raw: number;
	count: number;
}

interface EdgeAggregate {
	parent_timer_id: number;
	child_timer_id: number;
	inclusive_raw: number;
	count: number;
	max_raw: number;
}

const DEFAULT_DURATION_MS = 1000;
const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 5000;
const DEFAULT_MAX_TIMERS = 20;
const DEFAULT_MAX_GROUPS = 20;
const DEFAULT_MAX_TIMERS_PER_GROUP = 5;
const DEFAULT_MAX_RELATED_TIMERS = 3;
const DEFAULT_MAX_EVENTS = 250000;
const MAX_EVENTS = 1000000;
const COOPERATIVE_CLOCK_CHECK_INTERVAL = 128;
const MAX_COOPERATIVE_SLICE_SECONDS = 0.008;
const DEFAULT_FRAME_WINDOW = 240;
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD_BYTE = string.byte("=")[0];

const B64: number[] = [];
for (let i = 0; i < 64; i++) {
	B64[i] = string.byte(BASE64_CHARS, i + 1)[0];
}

const FOCUS_GROUP_MASKS: Record<string, string[]> = {
	all: [],
	script: ["Script", "LuaBridge"],
	physics: ["Physics"],
	render: ["Render"],
	network: ["Network", "RbxTransport", "Replicator"],
	jobs: ["Jobs"],
};

let cachedLibMP: LibMPLike | undefined;

type CooperativeCheckpoint = () => void;

// Sampling the clock avoids a timing call for every event while still bounding
// each VM resumption. Sorting uses the same checkpoint so no full sort is atomic.

function createCooperativeCheckpoint(): CooperativeCheckpoint {
	let operationsSinceClockCheck = 0;
	let sliceStartedAt = os.clock();

	return () => {
		operationsSinceClockCheck += 1;
		if (operationsSinceClockCheck < COOPERATIVE_CLOCK_CHECK_INTERVAL) return;

		operationsSinceClockCheck = 0;
		if (os.clock() - sliceStartedAt < MAX_COOPERATIVE_SLICE_SECONDS) return;

		task.wait();
		sliceStartedAt = os.clock();
	};
}

function cooperativeSort<T>(
	values: T[],
	comesBefore: (left: T, right: T) => boolean,
	checkpoint: CooperativeCheckpoint,
): void {
	const count = values.size();
	if (count < 2) return;

	function siftDown(start: number, lastIndex: number): void {
		let root = start;
		while (root * 2 + 1 <= lastIndex) {
			checkpoint();
			let candidate = root;
			const left = root * 2 + 1;
			if (comesBefore(values[candidate], values[left])) candidate = left;
			const right = left + 1;
			if (right <= lastIndex && comesBefore(values[candidate], values[right])) candidate = right;
			if (candidate === root) return;

			const value = values[root];
			values[root] = values[candidate];
			values[candidate] = value;
			root = candidate;
		}
	}

	for (let start = math.floor((count - 2) / 2); start >= 0; start--) {
		siftDown(start, count - 1);
		checkpoint();
	}
	for (let lastIndex = count - 1; lastIndex > 0; lastIndex--) {
		const value = values[0];
		values[0] = values[lastIndex];
		values[lastIndex] = value;
		checkpoint();
		siftDown(0, lastIndex - 1);
	}
}

function normalizeDurationMs(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_DURATION_MS;
	return math.clamp(math.floor(value), MIN_DURATION_MS, MAX_DURATION_MS);
}

function normalizeMaxTimers(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_TIMERS;
	return math.clamp(math.floor(value), 1, 100);
}

function normalizeMaxGroups(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_GROUPS;
	return math.clamp(math.floor(value), 1, 100);
}

function normalizeMaxTimersPerGroup(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_TIMERS_PER_GROUP;
	return math.clamp(math.floor(value), 0, 20);
}

function normalizeMaxRelatedTimers(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_RELATED_TIMERS;
	return math.clamp(math.floor(value), 0, 10);
}

function normalizeMaxEvents(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_MAX_EVENTS;
	return math.clamp(math.floor(value), 10000, MAX_EVENTS);
}

function normalizeFrameWindow(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_FRAME_WINDOW;
	return math.clamp(math.floor(value), 1, 2000);
}

function normalizeMinTotalUs(value: unknown): number {
	if (!typeIs(value, "number")) return 0;
	return math.max(0, value);
}

function normalizeFocus(value: unknown): string {
	if (!typeIs(value, "string") || FOCUS_GROUP_MASKS[value] === undefined) return "all";
	return value;
}

function stringContains(haystack: string, needle: string): boolean {
	return string.find(string.lower(haystack), string.lower(needle), 1, true)[0] !== undefined;
}

function rawToUs(raw: number): number {
	return math.floor(raw / 1000 + 0.5);
}

function round2(value: number): number {
	return math.floor(value * 100 + 0.5) / 100;
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
	if (sortedValues.size() === 0) return 0;
	const index = math.clamp(math.ceil(sortedValues.size() * fraction), 1, sortedValues.size()) - 1;
	return sortedValues[index];
}

function copyRecord(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of pairs(row)) {
		out[key as string] = value;
	}
	return out;
}

function pickFields(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		const value = row[field];
		if (value !== undefined) out[field] = value;
	}
	return out;
}

function addFrameRaw(map: Map<number, number>, frameId: number, raw: number): void {
	if (frameId <= 0) return;
	map.set(frameId, (map.get(frameId) ?? 0) + raw);
}

function summarizeFrameImpact(
	frameRawById: Map<number, number> | undefined,
	analyzedFrames: number,
	checkpoint: CooperativeCheckpoint,
): Record<string, unknown> {
	if (frameRawById === undefined || frameRawById.size() === 0) {
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
	for (const [frameId, raw] of frameRawById) {
		checkpoint();
		const us = rawToUs(raw);
		values.push(us);
		totalUs += us;
		if (us > maxUs) {
			maxUs = us;
			maxFrameId = frameId;
		}
	}
	cooperativeSort(values, (a, b) => a < b, checkpoint);

	return {
		active_frame_count: values.size(),
		active_frame_pct: percent(values.size(), analyzedFrames),
		inclusive_us_per_frame: analyzedFrames > 0 ? round2(totalUs / analyzedFrames) : totalUs,
		avg_active_frame_inclusive_us: values.size() > 0 ? round2(totalUs / values.size()) : 0,
		p95_active_frame_inclusive_us: percentile(values, 0.95),
		max_frame_inclusive_us: maxUs,
		max_frame_id: maxFrameId,
	};
}

function encodeBase64(buf: buffer, checkpoint: CooperativeCheckpoint): string {
	const len = buffer.len(buf);
	const fullTriples = math.floor(len / 3);
	const remaining = len - fullTriples * 3;
	const outLen = (fullTriples + (remaining > 0 ? 1 : 0)) * 4;
	const out = buffer.create(outLen);

	let si = 0;
	let di = 0;

	for (let t = 0; t < fullTriples; t++) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		const b2 = buffer.readu8(buf, si + 2);

		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.bor(bit32.lshift(bit32.band(b1, 15), 2), bit32.rshift(b2, 6))]);
		buffer.writeu8(out, di + 3, B64[bit32.band(b2, 63)]);

		si += 3;
		di += 4;
		checkpoint();
	}

	if (remaining === 2) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.lshift(bit32.band(b1, 15), 2)]);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	} else if (remaining === 1) {
		const b0 = buffer.readu8(buf, si);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.lshift(bit32.band(b0, 3), 4)]);
		buffer.writeu8(out, di + 2, PAD_BYTE);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	}

	return buffer.tostring(out);
}

function requireLibMP(): LibMPLike | Record<string, unknown> {
	if (cachedLibMP !== undefined) return cachedLibMP;
	const includeFolder = script.Parent!.Parent!.Parent!.FindFirstChild("include");
	const libModule = includeFolder && includeFolder.FindFirstChild("LibMP");
	if (!libModule || !libModule.IsA("ModuleScript")) {
		return {
			error: "libmp_missing",
			message: "The MCP plugin bundle does not contain include/LibMP.",
		};
	}
	const [ok, libOrErr] = pcall(() => require(libModule) as LibMPLike);
	if (!ok) {
		return {
			error: "libmp_require_failed",
			message: tostring(libOrErr),
		};
	}
	cachedLibMP = libOrErr as LibMPLike;
	return cachedLibMP;
}

function safeCall<T>(fn: () => T): LuaTuple<[boolean, T | string]> {
	const [ok, value] = pcall(fn);
	if (ok) return $tuple(true, value as T);
	return $tuple(false, tostring(value));
}

function isIdleTimer(info: TimerInfo): boolean {
	const name = string.lower(info.name);
	if (name === "sleep" || name === "idle") return true;
	if (string.find(name, "sleep", 1, true)[0] !== undefined) return true;
	return false;
}

function recommendedToolsForGroups(groups: Record<string, unknown>[], targetRole: string): Record<string, unknown>[] {
	const tools: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	for (const row of groups) {
		const group = row.group;
		if (!typeIs(group, "string") || seen.has(group)) continue;
		seen.add(group);
		if (group === "Script" || group === "LuaBridge") {
			tools.push({
				tool: "capture_script_profiler",
				arguments: { target: targetRole, duration_ms: 1000 },
				reason: "Script/LuaBridge timers are present.",
			});
		} else if (group === "Physics") {
			tools.push({ tool: "get_scene_analysis", reason: "Physics timers are present; inspect scene complexity." });
		} else if (group === "Render") {
			tools.push({ tool: "capture_screenshot", reason: "Render timers are present; inspect visible scene/UI state." });
		} else if (group === "Network" || group === "RbxTransport" || group === "Replicator") {
			tools.push({ tool: "get_runtime_logs", reason: "Network/replication timers are present; correlate with gameplay events." });
		} else if (group === "Jobs") {
			tools.push({ tool: "capture_micro_profiler", arguments: { target: targetRole, focus: "jobs" }, reason: "Jobs timers are present; narrow to job lanes if needed." });
		}
		if (tools.size() >= 3) break;
	}
	return tools;
}

function collectFrameSummary(
	session: LibMPSession,
	startFrame: number,
	frameMax: number,
	checkpoint: CooperativeCheckpoint,
): Record<string, unknown> {
	const frameRows: Record<string, unknown>[] = [];
	const durations: number[] = [];
	let incompleteFrames = 0;
	let pausedFrames = 0;

	for (let frameId = startFrame; frameId <= frameMax; frameId++) {
		checkpoint();
		const [ok, descOrErr] = safeCall(() => session.GetFrameDesc(frameId));
		if (!ok || !descOrErr) continue;
		const desc = descOrErr as FrameDesc;
		const tickStart = desc.TickStartCpu();
		const tickEnd = desc.TickEndCpu();
		const durationRaw = tickEnd - tickStart;
		const isIncomplete = desc.IsIncomplete();
		const isPaused = desc.IsPaused();
		if (isIncomplete) incompleteFrames += 1;
		if (isPaused) pausedFrames += 1;
		if (durationRaw <= 0 || durationRaw > 1000000000000) continue;
		const durationUs = rawToUs(durationRaw);
		durations.push(durationUs);
		const row: Record<string, unknown> = {
			frame_id: frameId,
			duration_us: durationUs,
		};
		if (isIncomplete) row.incomplete = true;
		if (isPaused) row.paused = true;
		frameRows.push(row);
	}

	cooperativeSort(durations, (a, b) => a < b, checkpoint);
	cooperativeSort(frameRows, (a, b) => (a.duration_us as number) > (b.duration_us as number), checkpoint);

	let totalUs = 0;
	for (const duration of durations) {
		totalUs += duration;
		checkpoint();
	}

	const topFrames: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(10, frameRows.size()); i++) {
		topFrames.push(frameRows[i]);
	}

	const count = durations.size();
	return {
		frames: count,
		total_duration_us: totalUs,
		avg_us: count > 0 ? round2(totalUs / count) : 0,
		p50_us: percentile(durations, 0.5),
		p95_us: percentile(durations, 0.95),
		max_us: count > 0 ? durations[count - 1] : 0,
		incomplete_frames: incompleteFrames,
		paused_frames: pausedFrames,
		top_frames: topFrames,
	};
}

function captureMicroProfiler(requestData: Record<string, unknown>): unknown {
	if (!RunService.IsRunning()) {
		return {
			error: "runtime_target_required",
			message: "MicroProfiler capture requires a running playtest target such as target=\"server\" or target=\"client-1\".",
		};
	}

	const libOrError = requireLibMP();
	if ((libOrError as { Control?: unknown }).Control === undefined) return libOrError;
	const LibMP = libOrError as LibMPLike;

	const durationMs = normalizeDurationMs(requestData.duration_ms);
	const maxTimers = normalizeMaxTimers(requestData.max_timers);
	const maxGroups = normalizeMaxGroups(requestData.max_groups);
	const maxTimersPerGroup = normalizeMaxTimersPerGroup(requestData.max_timers_per_group);
	const maxRelatedTimers = normalizeMaxRelatedTimers(requestData.max_related_timers);
	const maxEvents = normalizeMaxEvents(requestData.max_events);
	const frameWindow = normalizeFrameWindow(requestData.frame_window);
	const minTotalUs = normalizeMinTotalUs(requestData.min_total_us);
	const focus = normalizeFocus(requestData.focus);
	const filter = typeIs(requestData.filter, "string") && requestData.filter !== "" ? requestData.filter as string : undefined;
	const includeIdle = requestData.include_idle === true;
	const includeGpu = requestData.include_gpu === true;
	const includeRawBuffer = requestData.__mcp_include_raw_buffer === true;
	const includeComparisonIndex = requestData.__mcp_include_comparison_index === true;
	const targetRole = typeIs(requestData.__mcp_target_role, "string") ? requestData.__mcp_target_role as string : "runtime";

	const backend = {
		accessible: LibMP.Control.IsBackendAccessible(),
		ready: LibMP.Control.IsBackendReady(),
		compatible: LibMP.Control.IsBackendVersionCompatible(),
		versions: LibMP.Versions,
	};
	if (!backend.accessible || !backend.ready || !backend.compatible) {
		return {
			error: "micro_profiler_backend_unavailable",
			message: "MicroProfilerService backend is not accessible, ready, and compatible in this runtime peer.",
			backend,
		};
	}

	const [profilerOk, profilerResult] = safeCall(() => LibMP.Control.EnableProfiler(true));
	if (!profilerOk) {
		return {
			error: "micro_profiler_enable_failed",
			message: tostring(profilerResult),
			backend,
		};
	}

	const [captureStartOk, captureStartResult] = safeCall(() => LibMP.Control.EnableCapture(true));
	if (!captureStartOk) {
		return {
			error: "micro_profiler_capture_start_failed",
			message: tostring(captureStartResult),
			backend,
		};
	}

	task.wait(durationMs / 1000);

	const [captureStopOk, captureStopResult] = safeCall(() => LibMP.Control.EnableCapture(false));
	if (!captureStopOk) {
		return {
			error: "micro_profiler_capture_stop_failed",
			message: tostring(captureStopResult),
			backend,
		};
	}

	const [bufferOk, snapshotOrErr] = safeCall(() => LibMP.Control.CaptureToBufferSync());
	if (!bufferOk) {
		return {
			error: "micro_profiler_snapshot_failed",
			message: tostring(snapshotOrErr),
			backend,
		};
	}
	const snapshot = snapshotOrErr as buffer;

	const [sessionOk, sessionOrErr] = safeCall(() => LibMP.Session.OpenFromBuffer(snapshot));
	if (!sessionOk || !sessionOrErr) {
		return {
			error: "micro_profiler_decode_failed",
			message: tostring(sessionOrErr),
			buffer_bytes: buffer.len(snapshot),
			backend,
		};
	}
	const session = sessionOrErr as LibMPSession;
	if (!session.IsValid()) {
		session.Dispose();
		return {
			error: "micro_profiler_session_invalid",
			buffer_bytes: buffer.len(snapshot),
			backend,
		};
	}

	const timerIds = session.FetchTimerIds() ?? [];
	const threadIds = session.FetchThreadIds() ?? [];
	const frameMin = session.GetFrameIdMin();
	const frameMax = session.GetFrameIdMax();
	const startFrame = math.max(frameMin, frameMax - frameWindow + 1);
	const framesConsidered = frameMax >= startFrame ? frameMax - startFrame + 1 : 0;

	const groupCache = new Map<number, string>();
	const timerCache = new Map<number, TimerInfo>();
	const threadCache = new Map<number, Record<string, unknown>>();

	function getGroupName(groupId: number | undefined): string | undefined {
		if (groupId === undefined) return undefined;
		const cached = groupCache.get(groupId);
		if (cached !== undefined) return cached;
		const [ok, descOrErr] = safeCall(() => session.FetchGroupDesc(groupId));
		const desc = ok ? descOrErr as GroupDesc | undefined : undefined;
		const name = desc && typeIs(desc.GroupName, "string") && desc.GroupName !== "" ? desc.GroupName : tostring(groupId);
		groupCache.set(groupId, name);
		return name;
	}

	function getTimerInfo(timerId: number): TimerInfo {
		const cached = timerCache.get(timerId);
		if (cached !== undefined) return cached;
		const [ok, descOrErr] = safeCall(() => session.FetchTimerDesc(timerId));
		const desc = ok ? descOrErr as TimerDesc | undefined : undefined;
		const groupId = desc && typeIs(desc.GroupId, "number") ? desc.GroupId : undefined;
		const info: TimerInfo = {
			timer_id: timerId,
			name: desc && typeIs(desc.TimerName, "string") && desc.TimerName !== "" ? desc.TimerName : tostring(timerId),
			group_id: groupId,
			group: getGroupName(groupId),
			is_user_timer: desc && desc.IsUserTimer === true ? true : undefined,
		};
		timerCache.set(timerId, info);
		return info;
	}

	function getThreadInfo(threadId: number): Record<string, unknown> {
		const cached = threadCache.get(threadId);
		if (cached !== undefined) return cached;
		const [ok, descOrErr] = safeCall(() => session.FetchThreadDesc(threadId));
		const desc = ok ? descOrErr as ThreadDesc | undefined : undefined;
		const info: Record<string, unknown> = {
			thread_id: threadId,
			name: desc && typeIs(desc.ThreadName, "string") && desc.ThreadName !== "" ? desc.ThreadName : tostring(threadId),
		};
		if (desc && desc.IsGpu === true) info.is_gpu = true;
		if (desc && typeIs(desc.BufferSize, "number")) info.buffer_size = desc.BufferSize;
		threadCache.set(threadId, info);
		return info;
	}

	function addTimerAggregate(map: Map<number, TimerAggregate>, timerId: number, inclusiveRaw: number, exclusiveRaw: number): void {
		let aggregate = map.get(timerId);
		if (aggregate === undefined) {
			aggregate = { timer_id: timerId, inclusive_raw: 0, exclusive_raw: 0, count: 0, max_raw: 0 };
			map.set(timerId, aggregate);
		}
		aggregate.inclusive_raw += inclusiveRaw;
		aggregate.exclusive_raw += exclusiveRaw;
		aggregate.count += 1;
		if (inclusiveRaw > aggregate.max_raw) aggregate.max_raw = inclusiveRaw;
	}

	const focusMasks = FOCUS_GROUP_MASKS[focus] ?? [];
	const focusGroupIds: number[] = [];
	for (const mask of focusMasks) {
		const [ok, idsOrErr] = safeCall(() => session.FindGroupIds(mask, false));
		if (ok && typeIs(idsOrErr, "table")) {
			for (const id of idsOrErr as number[]) {
				if (!focusGroupIds.includes(id)) focusGroupIds.push(id);
			}
		}
	}

	const iteratorConfig: Record<string, unknown> = {
		StartFrameId: startFrame,
		EndFrameId: frameMax,
		SkipGpuThreads: !includeGpu,
		SkipEvents: true,
		SkipPausedFrames: true,
		SkipFrameBoundaries: true,
	};
	if (focusGroupIds.size() > 0) iteratorConfig.GroupIds = focusGroupIds;

	const iterator = session.CreateLogIterator();
	const [configOk, configErr] = safeCall(() => {
		iterator.Configure(iteratorConfig);
		return true;
	});
	if (!configOk) {
		iterator.Dispose();
		session.Dispose();
		return {
			error: "micro_profiler_iterator_config_failed",
			message: tostring(configErr),
			backend,
		};
	}

	const checkpoint = createCooperativeCheckpoint();

	const stacks = new Map<number, StackEntry[]>();
	const aggregates = new Map<number, TimerAggregate>();
	const timerThreadAggregates = new Map<number, Map<number, TimerAggregate>>();
	const timerFrameAggregates = new Map<number, Map<number, number>>();
	const edgeAggregates = new Map<string, EdgeAggregate>();
	const sampledFrames = new Set<number>();
	let eventsSampled = 0;
	let enterEvents = 0;
	let exitEvents = 0;
	let unmatchedExits = 0;
	let droppedSpans = 0;
	let sampledFrameMin: number | undefined;
	let sampledFrameMax: number | undefined;
	let lastProcessedFrameId: number | undefined;
	let lastProcessedTimestampRaw: number | undefined;

	while (eventsSampled < maxEvents) {
		checkpoint();
		if (!iterator.Step()) break;
		eventsSampled += 1;
		const state = iterator.GetState();
		if (!state) continue;
		const frameId = state.FrameId();
		const threadId = state.ThreadId();
		const timerId = state.TimerId();
		const timestampRaw = state.Timestamp();
		lastProcessedFrameId = frameId;
		lastProcessedTimestampRaw = timestampRaw;
		if (frameId > 0) {
			sampledFrames.add(frameId);
			if (sampledFrameMin === undefined || frameId < sampledFrameMin) sampledFrameMin = frameId;
			if (sampledFrameMax === undefined || frameId > sampledFrameMax) sampledFrameMax = frameId;
		}
		let stack = stacks.get(threadId);
		if (stack === undefined) {
			stack = [];
			stacks.set(threadId, stack);
		}

		if (state.IsEnter()) {
			enterEvents += 1;
			stack.push({ timerId, timestampRaw, childRaw: 0, frameId });
		} else if (state.IsExit()) {
			exitEvents += 1;
			let entry: StackEntry | undefined;
			while (stack.size() > 0) {
				checkpoint();
				const candidate = stack.pop();
				if (candidate && candidate.timerId === timerId) {
					entry = candidate;
					break;
				}
			}
			if (entry === undefined) {
				unmatchedExits += 1;
				continue;
			}
			const inclusiveRaw = timestampRaw - entry.timestampRaw;
			if (inclusiveRaw < 0 || inclusiveRaw > 1000000000000) {
				droppedSpans += 1;
				continue;
			}
			const exclusiveRaw = math.max(0, inclusiveRaw - entry.childRaw);
			const parent = stack[stack.size() - 1];
			if (parent !== undefined) {
				parent.childRaw += inclusiveRaw;
				const edgeKey = `${parent.timerId}:${timerId}`;
				let edge = edgeAggregates.get(edgeKey);
				if (edge === undefined) {
					edge = { parent_timer_id: parent.timerId, child_timer_id: timerId, inclusive_raw: 0, count: 0, max_raw: 0 };
					edgeAggregates.set(edgeKey, edge);
				}
				edge.inclusive_raw += inclusiveRaw;
				edge.count += 1;
				if (inclusiveRaw > edge.max_raw) edge.max_raw = inclusiveRaw;
			}

			addTimerAggregate(aggregates, timerId, inclusiveRaw, exclusiveRaw);
			let frameMap = timerFrameAggregates.get(timerId);
			if (frameMap === undefined) {
				frameMap = new Map<number, number>();
				timerFrameAggregates.set(timerId, frameMap);
			}
			addFrameRaw(frameMap, entry.frameId > 0 ? entry.frameId : frameId, inclusiveRaw);
			let threadMap = timerThreadAggregates.get(timerId);
			if (threadMap === undefined) {
				threadMap = new Map<number, TimerAggregate>();
				timerThreadAggregates.set(timerId, threadMap);
			}
			addTimerAggregate(threadMap, threadId, inclusiveRaw, exclusiveRaw);
		}
	}

	const sampledFrameCoveragePct = percent(sampledFrames.size(), framesConsidered);
	const analysisFrameMin = sampledFrameMin ?? startFrame;
	const analysisFrameMax = sampledFrameMax ?? frameMax;
	const frameSummary = collectFrameSummary(session, analysisFrameMin, analysisFrameMax, checkpoint);
	const analysisFrameCount = typeIs(frameSummary.frames, "number") && (frameSummary.frames as number) > 0
		? frameSummary.frames as number
		: sampledFrames.size() > 0
			? sampledFrames.size()
			: framesConsidered;
	const analysisDurationUs = typeIs(frameSummary.total_duration_us, "number") && (frameSummary.total_duration_us as number) > 0
		? frameSummary.total_duration_us as number
		: durationMs * 1000;
	const analysisDurationMs = analysisDurationUs / 1000;

	const rows: Record<string, unknown>[] = [];
	const rowsByTimerId = new Map<number, Record<string, unknown>>();
	const groupAggregates = new Map<string, GroupAggregate>();
	const groupTimerRows = new Map<string, Record<string, unknown>[]>();
	const groupFrameAggregates = new Map<string, Map<number, number>>();
	const threadAggregates = new Map<number, TimerAggregate>();
	const threadTimerRows = new Map<number, Record<string, unknown>[]>();
	let omittedIdle = 0;
	let omittedBelowThreshold = 0;
	let omittedByFilter = 0;

	for (const [timerId, aggregate] of aggregates) {
		checkpoint();
		const info = getTimerInfo(timerId);
		const totalUs = rawToUs(aggregate.inclusive_raw);
		if (!includeIdle && isIdleTimer(info)) {
			omittedIdle += 1;
			continue;
		}
		if (totalUs < minTotalUs) {
			omittedBelowThreshold += 1;
			continue;
		}
		if (filter !== undefined) {
			const searchable = `${info.name} ${info.group ?? ""}`;
			if (!stringContains(searchable, filter)) {
				omittedByFilter += 1;
				continue;
			}
		}

		const group = info.group ?? "<unknown>";
		const inclusiveUs = rawToUs(aggregate.inclusive_raw);
		const exclusiveUs = rawToUs(aggregate.exclusive_raw);
		const avgUs = aggregate.count > 0 ? round2(totalUs / aggregate.count) : 0;
		const maxUs = rawToUs(aggregate.max_raw);
		let groupAgg = groupAggregates.get(group);
		if (groupAgg === undefined) {
			groupAgg = { group, inclusive_raw: 0, exclusive_raw: 0, count: 0 };
			groupAggregates.set(group, groupAgg);
		}
		groupAgg.inclusive_raw += aggregate.inclusive_raw;
		groupAgg.exclusive_raw += aggregate.exclusive_raw;
		groupAgg.count += aggregate.count;

		const row: Record<string, unknown> = {
			timer_id: timerId,
			name: info.name,
			group,
			inclusive_us: inclusiveUs,
			inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
			exclusive_us: exclusiveUs,
			exclusive_pct: percent(exclusiveUs, inclusiveUs),
			count: aggregate.count,
			count_per_s: perSecond(aggregate.count, analysisDurationMs),
			count_per_frame: analysisFrameCount > 0 ? round2(aggregate.count / analysisFrameCount) : aggregate.count,
			avg_invocation_us: avgUs,
			max_invocation_us: maxUs,
			pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
		};
		const maxToAvg = ratio(maxUs, avgUs);
		if (maxToAvg !== undefined) row.max_to_avg = maxToAvg;
		const timerFrameImpact = summarizeFrameImpact(timerFrameAggregates.get(timerId), analysisFrameCount, checkpoint);
		for (const [key, value] of pairs(timerFrameImpact)) {
			row[key as string] = value;
		}
		if (info.is_user_timer === true) row.is_user_timer = true;
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
				groupFrames = new Map<number, number>();
				groupFrameAggregates.set(group, groupFrames);
			}
			for (const [frameId, raw] of timerFrames) {
				addFrameRaw(groupFrames, frameId, raw);
				checkpoint();
			}
		}

		const perThread = timerThreadAggregates.get(timerId);
		if (perThread !== undefined) {
			const timerThreadSummaryRows: Record<string, unknown>[] = [];
			for (const [threadId, threadAggregate] of perThread) {
				checkpoint();
				let threadAggregateRow = threadAggregates.get(threadId);
				if (threadAggregateRow === undefined) {
					threadAggregateRow = { timer_id: threadId, inclusive_raw: 0, exclusive_raw: 0, count: 0, max_raw: 0 };
					threadAggregates.set(threadId, threadAggregateRow);
				}
				threadAggregateRow.inclusive_raw += threadAggregate.inclusive_raw;
				threadAggregateRow.exclusive_raw += threadAggregate.exclusive_raw;
				threadAggregateRow.count += threadAggregate.count;
				if (threadAggregate.max_raw > threadAggregateRow.max_raw) threadAggregateRow.max_raw = threadAggregate.max_raw;

				let threadRows = threadTimerRows.get(threadId);
				if (threadRows === undefined) {
					threadRows = [];
					threadTimerRows.set(threadId, threadRows);
				}
				const threadTotalUs = rawToUs(threadAggregate.inclusive_raw);
				const threadExclusiveUs = rawToUs(threadAggregate.exclusive_raw);
				const threadAvgUs = threadAggregate.count > 0 ? round2(threadTotalUs / threadAggregate.count) : 0;
				const threadInfo = getThreadInfo(threadId);
				const threadTimerRow: Record<string, unknown> = {
					thread_id: threadId,
					thread_name: threadInfo.name,
					is_gpu: threadInfo.is_gpu,
					timer_id: timerId,
					name: info.name,
					group,
					inclusive_us: threadTotalUs,
					inclusive_us_per_s: perSecond(threadTotalUs, analysisDurationMs),
					exclusive_us: threadExclusiveUs,
					count: threadAggregate.count,
					count_per_s: perSecond(threadAggregate.count, analysisDurationMs),
					avg_invocation_us: threadAvgUs,
					max_invocation_us: rawToUs(threadAggregate.max_raw),
				};
				const threadMaxToAvg = ratio(threadTimerRow.max_invocation_us as number, threadAvgUs);
				if (threadMaxToAvg !== undefined) threadTimerRow.max_to_avg = threadMaxToAvg;
				threadRows.push(threadTimerRow);
				timerThreadSummaryRows.push({
					thread_id: threadId,
					thread_name: threadInfo.name,
					is_gpu: threadInfo.is_gpu,
					inclusive_us: threadTotalUs,
					exclusive_us: threadExclusiveUs,
					count: threadAggregate.count,
				});
			}
			cooperativeSort(timerThreadSummaryRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
			if (maxRelatedTimers > 0 && timerThreadSummaryRows.size() > 0) {
				const topTimerThreads: Record<string, unknown>[] = [];
				for (let i = 0; i < math.min(maxRelatedTimers, timerThreadSummaryRows.size()); i++) topTimerThreads.push(timerThreadSummaryRows[i]);
				row.top_threads = topTimerThreads;
			}
		}
	}

	cooperativeSort(rows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);

	const edgeRows: Record<string, unknown>[] = [];
	const parentRelationsByChild = new Map<number, Record<string, unknown>[]>();
	const childRelationsByParent = new Map<number, Record<string, unknown>[]>();
	for (const [, edge] of edgeAggregates) {
		checkpoint();
		const parentRow = rowsByTimerId.get(edge.parent_timer_id);
		const childRow = rowsByTimerId.get(edge.child_timer_id);
		if (parentRow === undefined || childRow === undefined) continue;
		const inclusiveUs = rawToUs(edge.inclusive_raw);
		const maxUs = rawToUs(edge.max_raw);
		const avgUs = edge.count > 0 ? round2(inclusiveUs / edge.count) : 0;
		const edgeRow: Record<string, unknown> = {
			parent: {
				timer_id: edge.parent_timer_id,
				name: parentRow.name,
				group: parentRow.group,
			},
			child: {
				timer_id: edge.child_timer_id,
				name: childRow.name,
				group: childRow.group,
			},
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

		let parentRelations = parentRelationsByChild.get(edge.child_timer_id);
		if (parentRelations === undefined) {
			parentRelations = [];
			parentRelationsByChild.set(edge.child_timer_id, parentRelations);
		}
		parentRelations.push({
			timer_id: edge.parent_timer_id,
			name: parentRow.name,
			group: parentRow.group,
			inclusive_us: inclusiveUs,
			count: edge.count,
			pct_of_timer_inclusive: percent(inclusiveUs, childRow.inclusive_us as number),
		});

		let childRelations = childRelationsByParent.get(edge.parent_timer_id);
		if (childRelations === undefined) {
			childRelations = [];
			childRelationsByParent.set(edge.parent_timer_id, childRelations);
		}
		childRelations.push({
			timer_id: edge.child_timer_id,
			name: childRow.name,
			group: childRow.group,
			inclusive_us: inclusiveUs,
			count: edge.count,
			pct_of_timer_inclusive: percent(inclusiveUs, parentRow.inclusive_us as number),
		});
	}
	cooperativeSort(edgeRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
	if (maxRelatedTimers > 0) {
		for (const [, relationRows] of parentRelationsByChild) {
			checkpoint();
			cooperativeSort(relationRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
		}
		for (const [, relationRows] of childRelationsByParent) {
			checkpoint();
			cooperativeSort(relationRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
		}
		for (const row of rows) {
			checkpoint();
			const timerId = row.timer_id as number;
			const parents = parentRelationsByChild.get(timerId);
			const children = childRelationsByParent.get(timerId);
			if (parents !== undefined && parents.size() > 0) {
				const topParents: Record<string, unknown>[] = [];
				for (let i = 0; i < math.min(maxRelatedTimers, parents.size()); i++) topParents.push(parents[i]);
				row.top_parents = topParents;
			}
			if (children !== undefined && children.size() > 0) {
				const topChildren: Record<string, unknown>[] = [];
				for (let i = 0; i < math.min(maxRelatedTimers, children.size()); i++) topChildren.push(children[i]);
				row.top_children = topChildren;
			}
		}
	}

	const topTimers: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxTimers, rows.size()); i++) {
		const row = copyRecord(rows[i]);
		row.rank = i + 1;
		topTimers.push(row);
	}

	const rowsByExclusive: Record<string, unknown>[] = [];
	for (const row of rows) {
		rowsByExclusive.push(row);
		checkpoint();
	}
	cooperativeSort(rowsByExclusive, (a, b) => (a.exclusive_us as number) > (b.exclusive_us as number), checkpoint);
	const topTimersByExclusive: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxTimers, rowsByExclusive.size()); i++) {
		const row = copyRecord(rowsByExclusive[i]);
		row.rank = i + 1;
		topTimersByExclusive.push(row);
	}

	const topEdges: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxTimers, edgeRows.size()); i++) {
		const row = copyRecord(edgeRows[i]);
		row.rank = i + 1;
		topEdges.push(row);
	}

	const threadRows: Record<string, unknown>[] = [];
	for (const [threadId, aggregate] of threadAggregates) {
		checkpoint();
		const info = getThreadInfo(threadId);
		const inclusiveUs = rawToUs(aggregate.inclusive_raw);
		const exclusiveUs = rawToUs(aggregate.exclusive_raw);
		const row: Record<string, unknown> = {
			thread_id: threadId,
			thread_name: info.name,
			is_gpu: info.is_gpu,
			inclusive_us: inclusiveUs,
			inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
			exclusive_us: exclusiveUs,
			exclusive_pct: percent(exclusiveUs, inclusiveUs),
			count: aggregate.count,
			count_per_s: perSecond(aggregate.count, analysisDurationMs),
			max_invocation_us: rawToUs(aggregate.max_raw),
			pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
		};
		const timerRows = threadTimerRows.get(threadId) ?? [];
		cooperativeSort(timerRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
		const topThreadTimers: Record<string, unknown>[] = [];
		for (let i = 0; i < math.min(maxTimersPerGroup, timerRows.size()); i++) {
			const timerRow = copyRecord(timerRows[i]);
			topThreadTimers.push(timerRow);
		}
		if (topThreadTimers.size() > 0) row.top_timers = topThreadTimers;
		threadRows.push(row);
	}
	cooperativeSort(threadRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
	const topThreads: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxGroups, threadRows.size()); i++) {
		const row = threadRows[i];
		row.rank = i + 1;
		topThreads.push(row);
	}

	const groupRows: Record<string, unknown>[] = [];
	for (const [, aggregate] of groupAggregates) {
		checkpoint();
		const timerRows = groupTimerRows.get(aggregate.group) ?? [];
		cooperativeSort(timerRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
		const topGroupTimers: Record<string, unknown>[] = [];
		for (let i = 0; i < math.min(maxTimersPerGroup, timerRows.size()); i++) {
			const timerRow = timerRows[i];
			topGroupTimers.push({
				timer_id: timerRow.timer_id,
				name: timerRow.name,
				inclusive_us: timerRow.inclusive_us,
				inclusive_us_per_s: timerRow.inclusive_us_per_s,
				exclusive_us: timerRow.exclusive_us,
				count: timerRow.count,
				max_invocation_us: timerRow.max_invocation_us,
				max_frame_inclusive_us: timerRow.max_frame_inclusive_us,
			});
		}
		const inclusiveUs = rawToUs(aggregate.inclusive_raw);
		const exclusiveUs = rawToUs(aggregate.exclusive_raw);
		const groupRow: Record<string, unknown> = {
			group: aggregate.group,
			inclusive_us: inclusiveUs,
			inclusive_us_per_s: perSecond(inclusiveUs, analysisDurationMs),
			exclusive_us: exclusiveUs,
			exclusive_pct: percent(exclusiveUs, inclusiveUs),
			count: aggregate.count,
			count_per_s: perSecond(aggregate.count, analysisDurationMs),
			count_per_frame: analysisFrameCount > 0 ? round2(aggregate.count / analysisFrameCount) : aggregate.count,
			timer_count: timerRows.size(),
			pct_of_analyzed_wall: percent(inclusiveUs, analysisDurationUs),
		};
		const groupFrameImpact = summarizeFrameImpact(groupFrameAggregates.get(aggregate.group), analysisFrameCount, checkpoint);
		for (const [key, value] of pairs(groupFrameImpact)) {
			groupRow[key as string] = value;
		}
		if (topGroupTimers.size() > 0) groupRow.top_timers = topGroupTimers;
		groupRows.push(groupRow);
	}
	cooperativeSort(groupRows, (a, b) => (a.inclusive_us as number) > (b.inclusive_us as number), checkpoint);
	const topGroups: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxGroups, groupRows.size()); i++) {
		const row = copyRecord(groupRows[i]);
		row.rank = i + 1;
		topGroups.push(row);
	}

	const groupRowsByExclusive: Record<string, unknown>[] = [];
	for (const row of groupRows) {
		groupRowsByExclusive.push(row);
		checkpoint();
	}
	cooperativeSort(groupRowsByExclusive, (a, b) => (a.exclusive_us as number) > (b.exclusive_us as number), checkpoint);
	const topGroupsByExclusive: Record<string, unknown>[] = [];
	for (let i = 0; i < math.min(maxGroups, groupRowsByExclusive.size()); i++) {
		const row = copyRecord(groupRowsByExclusive[i]);
		row.rank = i + 1;
		topGroupsByExclusive.push(row);
	}

	const omitted: Record<string, number> = {};
	if (omittedIdle > 0) omitted.idle = omittedIdle;
	if (omittedBelowThreshold > 0) omitted.below_min_total_us = omittedBelowThreshold;
	if (omittedByFilter > 0) omitted.filtered_out = omittedByFilter;

	let openStackEntriesAtEnd = 0;
	for (const [, stack] of stacks) {
		openStackEntriesAtEnd += stack.size();
		checkpoint();
	}
	const iteratorFinished = eventsSampled < maxEvents;
	const partialReasons: string[] = [];
	if (eventsSampled >= maxEvents) partialReasons.push("event_limit_hit");
	if (openStackEntriesAtEnd > 0) partialReasons.push("open_stack_entries_at_end");
	if (sampledFrameCoveragePct < 100) partialReasons.push("selected_frame_event_coverage_below_100");
	let comparisonIndex: Record<string, unknown> | undefined;
	if (includeComparisonIndex) {
		const timerFields = [
			"timer_id",
			"name",
			"group",
			"inclusive_us",
			"inclusive_us_per_s",
			"exclusive_us",
			"count",
			"count_per_s",
			"active_frame_count",
			"inclusive_us_per_frame",
			"max_frame_inclusive_us",
			"max_frame_id",
		];
		const groupFields = [
			"group",
			"inclusive_us",
			"inclusive_us_per_s",
			"exclusive_us",
			"count",
			"timer_count",
			"active_frame_count",
			"inclusive_us_per_frame",
			"max_frame_inclusive_us",
			"max_frame_id",
		];
		const threadFields = [
			"thread_id",
			"thread_name",
			"is_gpu",
			"inclusive_us",
			"inclusive_us_per_s",
			"exclusive_us",
			"count",
		];
		const edgeFields = [
			"parent",
			"child",
			"inclusive_us",
			"inclusive_us_per_s",
			"count",
			"max_invocation_us",
		];
		const timerIndex: Record<string, unknown>[] = [];
		for (const row of rows) {
			timerIndex.push(pickFields(row, timerFields));
			checkpoint();
		}
		const groupIndex: Record<string, unknown>[] = [];
		for (const row of groupRows) {
			groupIndex.push(pickFields(row, groupFields));
			checkpoint();
		}
		const threadIndex: Record<string, unknown>[] = [];
		for (const row of threadRows) {
			threadIndex.push(pickFields(row, threadFields));
			checkpoint();
		}
		const edgeIndex: Record<string, unknown>[] = [];
		for (const row of edgeRows) {
			edgeIndex.push(pickFields(row, edgeFields));
			checkpoint();
		}
		comparisonIndex = {
			timers: timerIndex,
			groups: groupIndex,
			threads: threadIndex,
			call_edges: edgeIndex,
		};
	}

	const result: Record<string, unknown> = {
		schema_version: 1,
		ok: true,
		duration_ms: durationMs,
		target: targetRole,
		scope: "micro_profiler",
		time_unit: "microseconds",
		time_basis: "LibMP MicroProfiler timestamps converted from nanosecond ticks. inclusive_us is cumulative nested timer time and can overlap across nested timers/threads; do not sum rows as total frame time.",
		analysis_window: {
			requested_duration_ms: durationMs,
			analysis_duration_us: analysisDurationUs,
			snapshot_frame_min: frameMin,
			snapshot_frame_max: frameMax,
			selected_frame_min: startFrame,
			selected_frame_max: frameMax,
			selected_frame_count: framesConsidered,
			analyzed_frame_min: analysisFrameMin,
			analyzed_frame_max: analysisFrameMax,
			analyzed_frame_count: analysisFrameCount,
			processed_frame_min: sampledFrameMin,
			processed_frame_max: sampledFrameMax,
			processed_frame_count: sampledFrames.size(),
			selected_frame_event_coverage_pct: sampledFrameCoveragePct,
			frame_window: frameWindow,
		},
		applied: {
			focus,
			filter: filter ?? undefined,
			include_idle: includeIdle,
			include_gpu: includeGpu,
			min_total_us: minTotalUs,
			max_groups: maxGroups,
			max_timers: maxTimers,
			max_timers_per_group: maxTimersPerGroup,
			max_related_timers: maxRelatedTimers,
			max_events: maxEvents,
			frame_window: frameWindow,
			sort: "inclusive_us_desc",
		},
		counts: {
			buffer_bytes: buffer.len(snapshot),
			timers: timerIds.size(),
			threads: threadIds.size(),
			frame_min: frameMin,
			frame_max: frameMax,
			frames_considered: framesConsidered,
			sampled_frame_min: sampledFrameMin,
			sampled_frame_max: sampledFrameMax,
			sampled_frames: sampledFrames.size(),
			events_sampled: eventsSampled,
			enter_events: enterEvents,
			exit_events: exitEvents,
			unmatched_exits: unmatchedExits,
			dropped_spans: droppedSpans,
			open_stack_entries_at_end: openStackEntriesAtEnd,
			iterator_finished: iteratorFinished,
			last_processed_frame_id: lastProcessedFrameId,
			last_processed_timestamp_us: lastProcessedTimestampRaw !== undefined ? rawToUs(lastProcessedTimestampRaw) : undefined,
			event_limit_hit: eventsSampled >= maxEvents,
		},
		frame_summary: frameSummary,
		top_groups: topGroups,
		top_groups_by_exclusive: topGroupsByExclusive,
		top_threads: topThreads,
		top_call_edges: topEdges,
		top_timers: topTimers,
		top_timers_by_exclusive: topTimersByExclusive,
		data_quality: {
			event_limit_hit: eventsSampled >= maxEvents,
			iterator_finished: iteratorFinished,
			unmatched_exits: unmatchedExits,
			dropped_spans: droppedSpans,
			open_stack_entries_at_end: openStackEntriesAtEnd,
			selected_frame_event_coverage_pct: sampledFrameCoveragePct,
			partial: partialReasons.size() > 0,
			partial_reasons: partialReasons,
			notes: focus !== "all"
				? ["focus filters events before stack aggregation; exclusive_us is exclusive within emitted focused events, not the full snapshot."]
				: undefined,
		},
		recommended_tools: recommendedToolsForGroups(topGroups, targetRole),
	};
	if (next(omitted)[0] !== undefined) result.omitted = omitted;
	if (comparisonIndex !== undefined) result.comparison_index = comparisonIndex;
	result.backend = backend;
	if (session.GetDataFormatVersion() !== undefined) result.libmp_data_format_version = session.GetDataFormatVersion();
	if (session.GetObjSize() !== undefined) result.snapshot_object_size_bytes = session.GetObjSize();
	if (includeRawBuffer) result.raw_snapshot_base64 = encodeBase64(snapshot, checkpoint);

	iterator.Dispose();
	session.Dispose();
	return result;
}

export = { captureMicroProfiler };

import { RunService } from "@rbxts/services";

// The plugin records MicroProfiler captures and hands the raw LibMP container to
// the MCP server, which analyzes it. Decoding events in Studio's Luau is about
// 100x slower than on the host and would add work to the frames being profiled.
//
// Recording uses a LibMP memory stream: it keeps every frame of the recording.
// Studio's live MicroProfiler history keeps only what fits its memory target,
// as few as 11-13 frames (about 0.2 s) under a busy UI or scope load. When a
// stream cannot start, the capture falls back to that live history and the
// server reports how much of the window it covers.

const HttpService = game.GetService("HttpService");

type EncodingServiceShape = {
	Base64Encode(this: EncodingServiceShape, input: buffer): buffer;
};

const EncodingService = (game as unknown as {
	GetService(name: string): EncodingServiceShape;
}).GetService("EncodingService");

interface CaptureParams {
	MaxFrameCount?: number;
	ContainerFormat?: number;
}

interface LibMPControl {
	EnableProfiler(this: LibMPControl, enable: boolean): boolean;
	EnableCapture(this: LibMPControl, enable: boolean): boolean;
	SetFrameLimit(this: LibMPControl, frames: number): boolean;
	CaptureToBufferSync(this: LibMPControl, params?: CaptureParams): buffer | undefined;
	SaveSlotToBuffer(this: LibMPControl, slotId: number): buffer | undefined;
	ResetSlot(this: LibMPControl, slotId: number): boolean;
	IsBackendAccessible(this: LibMPControl): boolean;
	IsBackendReady(this: LibMPControl): boolean;
	IsBackendVersionCompatible(this: LibMPControl): boolean;
}

// Status of the stream started through this LibMP copy; all zero when inactive.
interface StreamStatus {
	Active: boolean;
	StreamFrameId: number;
	AbsoluteFrameId: number;
	RecordedSizeKb: number;
	MaxSizeKb: number;
	ElapsedMs: number;
}

interface LibMPExperimentalV1 {
	StartMemoryStream(this: void, targetSlotId: number): boolean;
	StopStream(this: void): boolean;
	GetStreamStatus(this: void): StreamStatus;
}

interface LibMPLike {
	Control: LibMPControl;
	Session: {
		OpenFromBuffer(this: void, data: buffer): LibMPSession | undefined;
	};
	Versions?: { Library?: number; DataFormat?: number };
	Experimental?: { V1?: LibMPExperimentalV1 };
}

interface LibMPSession {
	GetFrameIdMax(this: LibMPSession): number;
	GetFrameDesc(this: LibMPSession, frameId: number): FrameDesc | undefined;
	CreateLogIterator(this: LibMPSession): LogIterator;
	Dispose(this: LibMPSession): void;
}

interface FrameDesc {
	FrameAbsoluteId(this: FrameDesc): number;
}

interface LogIterator {
	Configure(this: LogIterator, config: Record<string, unknown>): void;
	Step(this: LogIterator): boolean;
	Dispose(this: LogIterator): void;
}

const DEFAULT_DURATION_MS = 1000;
const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 30000;
// A start/stop recording stops itself after this long; its data waits for
// action="stop" for RECORDING_RETENTION_SECONDS, then is discarded.
const MAX_RECORDING_SECONDS = 120;
const RECORDING_RETENTION_SECONDS = 600;
const WATCHDOG_INTERVAL_SECONDS = 0.5;
// User-managed slots 1-4 hold finalized streams. Slot 4 is the one users are
// least likely to fill by hand; a recording overwrites and then clears it.
const STREAM_SLOT = 4;
// StopStream finalizes on the next frame flip; the slot is readable a frame later.
const STREAM_FINALIZE_TIMEOUT_SECONDS = 2;
// Recorded data trails the frame being rendered by 7 frames (measured in Studio
// by tests/micro-profiler-recording-verification.mjs). Before stopping, wait
// until the frame rendered at the stop request plus this margin is current.
const STREAM_TAIL_FRAMES = 8;
const STREAM_FLUSH_TIMEOUT_SECONDS = 2;
// The engine holds at most 256 frames, and fresh Studio peers already use 256.
// SetFrameLimit only narrows the view of retained frames. Changing the limit
// clears counter history; setting the same value does not.
const HISTORY_FRAME_LIMIT = 256;
// A recording peer shows a new frame after one task.wait() almost always;
// Studio hitches of up to 12 frames (~0.2 s) were observed.
const RECORDING_PROBE_SECONDS = 0.3;
const RECORDING_PROBE_INTERVAL_SECONDS = 0.1;
// A capture's first frame with scope events can arrive several frames after
// EnableCapture (on a fresh Studio peer the first frame took ~70 ms and frames
// 1-5 had no events). Check every frame for the first FIRST_FRAME_FAST_POLLS
// checks, then at the poll interval, for at most the timeout.
const FIRST_FRAME_TIMEOUT_SECONDS = 0.5;
const FIRST_FRAME_FAST_POLLS = 12;
const FIRST_FRAME_POLL_SECONDS = 0.05;
// Transfers: the server pulls base64 chunks of at most MAX_CHUNK_BYTES raw bytes
// (it asks for less through the client broker). Unread transfers expire.
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_TRANSFERS = 2;
const TRANSFER_TTL_SECONDS = 120;
// How long a playtest peer that has only just started may take to report its
// MicroProfiler backend ready.
const BACKEND_READY_TIMEOUT_SECONDS = 2;
const BACKEND_READY_POLL_SECONDS = 0.1;
const NO_FRAMES_MESSAGE = "Studio rendered no frames during the capture, so MicroProfiler recorded no data. Studio draws frames only while its window can be displayed, which stops when the display turns off (for example after the power-saving timeout) or Studio is minimized. Wake the display or restore Studio, then retry.";

type Method = "stream" | "snapshot";

interface PriorCaptureState {
	recording: boolean;
	// Absolute ID of the newest frame that predates this capture (0 if none).
	boundaryAbsolute: number;
}

interface Recording {
	id: string;
	method: Method;
	prior: PriorCaptureState;
	// First absolute frame the capture records; older frames in the container
	// (a stream starts with the engine's retained history) are not analyzed.
	startAbsoluteFrame: number;
	// Timing origin: the first frame with events, or the start of the wait for
	// it when that timed out.
	startedAt: number;
	firstFrameWaitMs: number;
	requestedDurationMs?: number;
	notes: string[];
	// Set when the recording ended before action="stop" (time or size limit).
	finished?: FinishedRecording;
	// Set while finishRecording runs, which yields; a second caller waits for it.
	finishing?: boolean;
	// Set once action="stop" claims the recording.
	stopping?: boolean;
	// No frame newer than the pre-capture boundary arrived during the first-frame
	// wait, so startAbsoluteFrame is a lower bound, not a frame of this capture.
	startEstimated: boolean;
	watchdog?: thread;
	// A one-shot capture (action="capture") that action="stop" must not end.
	oneShot: boolean;
}

interface FinishedRecording {
	data?: buffer;
	error?: Record<string, unknown>;
	meta: Record<string, unknown>;
	reason?: string;
	at: number;
}

interface Transfer {
	data: buffer;
	expiresAt: number;
}

let cachedLibMP: LibMPLike | undefined;
let active: Recording | undefined;
let starting = false;
const transfers = new Map<string, Transfer>();

function safeCall<T>(fn: () => T): LuaTuple<[boolean, T | string]> {
	const [ok, value] = pcall(fn);
	if (ok) return $tuple(true, value as T);
	return $tuple(false, tostring(value));
}

function round2(value: number): number {
	return math.floor(value * 100 + 0.5) / 100;
}

function normalizeDurationMs(value: unknown): number {
	if (!typeIs(value, "number")) return DEFAULT_DURATION_MS;
	return math.clamp(math.floor(value), MIN_DURATION_MS, MAX_DURATION_MS);
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

function backendInfo(LibMP: LibMPLike): Record<string, unknown> {
	return {
		accessible: LibMP.Control.IsBackendAccessible(),
		ready: LibMP.Control.IsBackendReady(),
		compatible: LibMP.Control.IsBackendVersionCompatible(),
		versions: LibMP.Versions,
	};
}

interface NewestFrame {
	id: number;
	absolute: number;
	// Only set when requested: whether the newest frame holds any CPU scope event.
	hasEvents: boolean;
}

function readNewestFrame(LibMP: LibMPLike, checkEvents = false): NewestFrame | undefined {
	const [readOk, data] = safeCall(() => LibMP.Control.CaptureToBufferSync());
	if (!readOk || data === undefined) return undefined;
	const [openOk, opened] = safeCall(() => LibMP.Session.OpenFromBuffer(data as buffer));
	if (!openOk || !opened) return undefined;
	const session = opened as LibMPSession;
	const [infoOk, info] = safeCall((): NewestFrame => {
		const newest = session.GetFrameIdMax();
		// A GetFrameDesc view is invalidated by the next Get/Fetch call on the
		// session, so read it immediately.
		const desc = newest > 0 ? session.GetFrameDesc(newest) : undefined;
		const absolute = desc !== undefined ? desc.FrameAbsoluteId() : 0;
		let hasEvents = false;
		if (checkEvents && newest > 0) {
			const iterator = session.CreateLogIterator();
			const [configured] = safeCall(() => {
				iterator.Configure({
					StartFrameId: newest,
					EndFrameId: newest,
					SkipGpuThreads: true,
					SkipEvents: true,
					SkipPausedFrames: true,
					SkipFrameBoundaries: true,
				});
				return true;
			});
			if (configured) {
				const [stepped, steppedResult] = safeCall(() => iterator.Step());
				hasEvents = stepped && steppedResult === true;
			}
			iterator.Dispose();
		}
		return { id: math.max(newest, 0), absolute, hasEvents };
	});
	session.Dispose();
	return infoOk ? info as NewestFrame : undefined;
}

// LibMP cannot report whether capture is on. A paused peer serves the same
// cached frames on every read, so only a recording peer's newest absolute frame
// ID advances. Studio peers start with capture paused. This must run before the
// tool calls EnableProfiler: on a fresh peer EnableProfiler alone starts frames
// recording, which would read as a peer that was already recording.
function detectRecording(LibMP: LibMPLike): PriorCaptureState {
	const first = readNewestFrame(LibMP);
	if (first === undefined) return { recording: false, boundaryAbsolute: 0 };
	const deadline = os.clock() + RECORDING_PROBE_SECONDS;
	let waitSeconds: number | undefined;
	while (os.clock() < deadline) {
		task.wait(waitSeconds);
		waitSeconds = RECORDING_PROBE_INTERVAL_SECONDS;
		const latest = readNewestFrame(LibMP);
		if (latest === undefined) break;
		if (latest.absolute !== first.absolute) {
			return { recording: true, boundaryAbsolute: latest.absolute };
		}
	}
	return { recording: false, boundaryAbsolute: first.absolute };
}

function streamApi(LibMP: LibMPLike): LibMPExperimentalV1 | undefined {
	const experimental = LibMP.Experimental;
	return experimental !== undefined ? experimental.V1 : undefined;
}

function streamStatus(LibMP: LibMPLike): StreamStatus | undefined {
	const v1 = streamApi(LibMP);
	if (v1 === undefined) return undefined;
	const [ok, status] = safeCall(() => v1.GetStreamStatus());
	return ok && typeIs(status, "table") ? status as StreamStatus : undefined;
}

function beginRecording(LibMP: LibMPLike, requestedDurationMs?: number): Recording | Record<string, unknown> {
	// A playtest DataModel that has only just started can report its backend
	// unready for a moment; give it that moment before reporting it unavailable.
	let backend = backendInfo(LibMP);
	const readyDeadline = os.clock() + BACKEND_READY_TIMEOUT_SECONDS;
	while (backend.accessible === true && backend.compatible === true && backend.ready !== true && os.clock() < readyDeadline) {
		task.wait(BACKEND_READY_POLL_SECONDS);
		backend = backendInfo(LibMP);
	}
	if (backend.accessible !== true || backend.ready !== true || backend.compatible !== true) {
		return {
			error: "micro_profiler_backend_unavailable",
			message: "MicroProfilerService backend is not accessible, ready, and compatible in this runtime peer.",
			backend,
		};
	}

	// Studio peers start with capture paused. Leave the peer as found: if
	// something else is already recording, keep it recording; otherwise pause
	// again after the capture.
	const prior = detectRecording(LibMP);
	const notes: string[] = [];

	const [frameLimitOk, frameLimitResult] = safeCall(() => LibMP.Control.SetFrameLimit(HISTORY_FRAME_LIMIT));
	if (!frameLimitOk) {
		return { error: "micro_profiler_frame_limit_failed", message: tostring(frameLimitResult), backend };
	}
	// Profiling is on by default in Studio and the tool never turns it off. It
	// must follow the recording check: on a fresh peer EnableProfiler alone
	// starts frames recording.
	const [profilerOk, profilerResult] = safeCall(() => LibMP.Control.EnableProfiler(true));
	if (!profilerOk) {
		return { error: "micro_profiler_enable_failed", message: tostring(profilerResult), backend };
	}

	let method: Method = "snapshot";
	const v1 = streamApi(LibMP);
	if (v1 === undefined) {
		notes.push("This LibMP build has no stream API, so the capture holds only the frames Studio kept in its live history.");
	} else {
		const status = streamStatus(LibMP);
		if (status !== undefined && status.Active) {
			notes.push("Another MicroProfiler stream is recording in this Studio process, so the capture holds only the frames Studio kept in its live history.");
		} else {
			const [startOk, started] = safeCall(() => v1.StartMemoryStream(STREAM_SLOT));
			if (startOk && started === true) {
				method = "stream";
			} else {
				notes.push(`The MicroProfiler stream did not start (${tostring(started)}), so the capture holds only the frames Studio kept in its live history.`);
			}
		}
	}

	if (!prior.recording) {
		const [captureStartOk, captureStartResult] = safeCall(() => LibMP.Control.EnableCapture(true));
		if (!captureStartOk) {
			if (method === "stream") safeCall(() => v1!.StopStream());
			return { error: "micro_profiler_capture_start_failed", message: tostring(captureStartResult), backend };
		}
	}

	// The first frames after capture starts can carry no scope events yet, so
	// time the capture from the first frame with events.
	let startAbsoluteFrame = prior.boundaryAbsolute + 1;
	let startEstimated = true;
	let firstNewFrame: number | undefined;
	const waitStartedAt = os.clock();
	let startedAt = waitStartedAt;
	let polls = 0;
	while (os.clock() - waitStartedAt < FIRST_FRAME_TIMEOUT_SECONDS) {
		task.wait(polls < FIRST_FRAME_FAST_POLLS ? undefined : FIRST_FRAME_POLL_SECONDS);
		polls += 1;
		const latest = readNewestFrame(LibMP, true);
		if (latest === undefined || latest.absolute <= prior.boundaryAbsolute) continue;
		if (firstNewFrame === undefined) firstNewFrame = latest.absolute;
		if (latest.hasEvents) {
			startAbsoluteFrame = latest.absolute;
			startEstimated = false;
			startedAt = os.clock();
			break;
		}
	}
	// Absolute IDs keep counting while capture is paused, so the boundary says
	// nothing about where this capture starts; use the first frame it recorded.
	if (startEstimated && firstNewFrame !== undefined) {
		startAbsoluteFrame = firstNewFrame;
		startEstimated = false;
	}

	if (method === "stream") {
		const status = streamStatus(LibMP);
		if (status === undefined || !status.Active || status.AbsoluteFrameId <= 0) {
			// StartMemoryStream accepted the request but the stream never ran.
			safeCall(() => v1!.StopStream());
			method = "snapshot";
			notes.push("The MicroProfiler stream did not start recording, so the capture holds only the frames Studio kept in its live history.");
		} else {
			// Recorded data trails the frame being rendered by about 7 frames, so
			// the newest frame read above is already in the past. Start the window
			// at the frame being rendered now, when the timer starts.
			startAbsoluteFrame = math.max(startAbsoluteFrame, status.AbsoluteFrameId);
			startEstimated = false;
			startedAt = os.clock();
		}
	}

	return {
		id: HttpService.GenerateGUID(false),
		method,
		prior,
		startAbsoluteFrame,
		startEstimated,
		startedAt,
		firstFrameWaitMs: (os.clock() - waitStartedAt) * 1000,
		requestedDurationMs,
		oneShot: requestedDurationMs !== undefined,
		notes,
	};
}

// A stream holds frames about 7 frames behind the one being rendered, and
// StopStream drops what it has not written yet. Keep recording until the frame
// rendered at the stop request has been written.
function waitForStreamToCatchUp(LibMP: LibMPLike, stopAbsoluteFrame: number): boolean {
	const deadline = os.clock() + STREAM_FLUSH_TIMEOUT_SECONDS;
	while (os.clock() < deadline) {
		const status = streamStatus(LibMP);
		if (status === undefined || !status.Active) return false;
		if (status.AbsoluteFrameId >= stopAbsoluteFrame + STREAM_TAIL_FRAMES) return true;
		task.wait();
	}
	return false;
}

function waitForStreamToFinalize(LibMP: LibMPLike): boolean {
	const deadline = os.clock() + STREAM_FINALIZE_TIMEOUT_SECONDS;
	while (os.clock() < deadline) {
		task.wait();
		const status = streamStatus(LibMP);
		if (status === undefined || !status.Active) {
			// The finalized slot is readable on the next frame.
			task.wait();
			return true;
		}
	}
	return false;
}

function finishRecording(LibMP: LibMPLike, recording: Recording, reason?: string): FinishedRecording {
	const captureWallMs = (os.clock() - recording.startedAt) * 1000;
	const notes = [...recording.notes];
	let method = recording.method;
	let data: buffer | undefined;
	let failure: Record<string, unknown> | undefined;
	let streamInfo: Record<string, unknown> | undefined;
	let stopAbsoluteFrame: number | undefined;

	if (method === "stream") {
		const v1 = streamApi(LibMP)!;
		const status = streamStatus(LibMP);
		// beginRecording saw this stream running; one that hit its size cap
		// stops on its own (an inactive status reads all zeros).
		const sizeLimitReached = status !== undefined && (!status.Active
			|| (status.MaxSizeKb > 0 && status.RecordedSizeKb >= status.MaxSizeKb));
		let tailWritten = false;
		if (status !== undefined && status.Active && status.AbsoluteFrameId > 0) {
			stopAbsoluteFrame = status.AbsoluteFrameId;
			tailWritten = waitForStreamToCatchUp(LibMP, stopAbsoluteFrame);
		}
		streamInfo = {
			recorded_kb: status?.RecordedSizeKb,
			max_kb: status?.MaxSizeKb,
			size_limit_reached: sizeLimitReached,
			tail_written: tailWritten,
		};
		if (sizeLimitReached) {
			notes.push("The MicroProfiler stream reached its size limit and stopped early; the capture ends there.");
		}
		safeCall(() => v1.StopStream());
		const finalized = waitForStreamToFinalize(LibMP);
		const [saveOk, saved] = safeCall(() => LibMP.Control.SaveSlotToBuffer(STREAM_SLOT));
		safeCall(() => LibMP.Control.ResetSlot(STREAM_SLOT));
		if (saveOk && saved !== undefined && buffer.len(saved as buffer) > 0) {
			data = saved as buffer;
		} else {
			notes.push(`The MicroProfiler stream did not produce a readable recording (${finalized ? tostring(saved) : "it did not finalize"}), so the capture holds only the frames Studio kept in its live history.`);
			method = "snapshot";
			stopAbsoluteFrame = undefined;
		}
	}
	if (data === undefined) {
		// Active reads synchronize the engine's data; paused reads can return an
		// empty or stale cache. Export first, then restore.
		const [snapshotOk, snapshot] = safeCall(() => LibMP.Control.CaptureToBufferSync());
		if (!snapshotOk || snapshot === undefined) {
			failure = { error: "micro_profiler_snapshot_failed", message: tostring(snapshot) };
		} else if (buffer.len(snapshot as buffer) === 0) {
			failure = { error: "micro_profiler_no_frames", message: NO_FRAMES_MESSAGE };
		} else {
			data = snapshot as buffer;
		}
	}

	if (!recording.prior.recording) {
		const [captureStopOk, captureStopResult] = safeCall(() => LibMP.Control.EnableCapture(false));
		if (!captureStopOk && failure === undefined) {
			failure = { error: "micro_profiler_capture_stop_failed", message: tostring(captureStopResult) };
		}
	}

	const meta: Record<string, unknown> = {
		method,
		start_absolute_frame: recording.startAbsoluteFrame,
		start_frame_estimated: recording.startEstimated || undefined,
		stop_absolute_frame: stopAbsoluteFrame,
		capture_wall_ms: round2(captureWallMs),
		first_frame_wait_ms: round2(recording.firstFrameWaitMs),
		bytes: data !== undefined ? buffer.len(data) : undefined,
	};
	if (recording.requestedDurationMs !== undefined) meta.requested_duration_ms = recording.requestedDurationMs;
	if (streamInfo !== undefined) meta.stream = streamInfo;
	if (reason !== undefined) meta.stopped_by = reason;
	if (notes.size() > 0) meta.notes = notes;
	return { data, error: failure, meta, reason, at: os.clock() };
}

function pruneTransfers(): void {
	const now = os.clock();
	for (const [id, transfer] of transfers) {
		if (now >= transfer.expiresAt) transfers.delete(id);
	}
}

function captureResponse(LibMP: LibMPLike, recording: Recording, finished: FinishedRecording, action: string): Record<string, unknown> {
	const base: Record<string, unknown> = {
		action,
		recording: finished.meta,
		capture_state: { was_recording: recording.prior.recording },
		libmp: LibMP.Versions,
	};
	if (finished.error !== undefined || finished.data === undefined) {
		const failure = finished.error ?? { error: "micro_profiler_snapshot_failed", message: "No capture data was produced." };
		for (const [key, value] of pairs(failure)) base[key as string] = value;
		return base;
	}
	pruneTransfers();
	if (transfers.size() >= MAX_TRANSFERS) {
		// Older transfers are abandoned by now; a capture must not fail on them.
		let oldestId: string | undefined;
		let oldestExpiry = math.huge;
		for (const [id, transfer] of transfers) {
			if (transfer.expiresAt < oldestExpiry) {
				oldestExpiry = transfer.expiresAt;
				oldestId = id;
			}
		}
		if (oldestId !== undefined) transfers.delete(oldestId);
	}
	const transferId = HttpService.GenerateGUID(false);
	transfers.set(transferId, { data: finished.data, expiresAt: os.clock() + TRANSFER_TTL_SECONDS });
	base.ok = true;
	base.transfer = {
		transfer_id: transferId,
		total_bytes: buffer.len(finished.data),
		max_chunk_bytes: MAX_CHUNK_BYTES,
	};
	return base;
}

function startWatchdog(LibMP: LibMPLike, recording: Recording): void {
	recording.watchdog = task.spawn(() => {
		while (active === recording && recording.finished === undefined && !recording.finishing) {
			task.wait(WATCHDOG_INTERVAL_SECONDS);
			if (active !== recording || recording.finished !== undefined || recording.finishing) return;
			let reason: string | undefined;
			if (os.clock() - recording.startedAt >= MAX_RECORDING_SECONDS) {
				reason = "max_duration";
			} else if (recording.method === "stream") {
				const status = streamStatus(LibMP);
				// beginRecording saw this stream running, so an inactive stream stopped
				// by itself at its size cap.
				if (status !== undefined && !status.Active) reason = "size_limit";
			}
			if (reason === undefined) continue;
			recording.finishing = true;
			recording.finished = finishRecording(LibMP, recording, reason);
			const finishedAt = recording.finished.at;
			task.delay(RECORDING_RETENTION_SECONDS, () => {
				if (active === recording && recording.finished !== undefined && recording.finished.at === finishedAt) {
					active = undefined;
				}
			});
			return;
		}
	});
}

function recordingInfo(recording: Recording): Record<string, unknown> {
	const info: Record<string, unknown> = {
		method: recording.method,
		elapsed_ms: round2((os.clock() - recording.startedAt) * 1000),
		start_absolute_frame: recording.startAbsoluteFrame,
		first_frame_wait_ms: round2(recording.firstFrameWaitMs),
		max_recording_seconds: MAX_RECORDING_SECONDS,
	};
	if (recording.finished !== undefined) info.stopped_by = recording.finished.reason;
	if (recording.notes.size() > 0) info.notes = recording.notes;
	return info;
}

function captureMicroProfiler(requestData: Record<string, unknown>): unknown {
	const action = typeIs(requestData.action, "string") ? requestData.action as string : "capture";
	if (action !== "capture" && action !== "start" && action !== "stop") {
		return { error: "invalid_action", message: `Unknown action ${action}; expected capture, start, or stop.` };
	}
	if (!RunService.IsRunning()) {
		return {
			error: "runtime_target_required",
			message: "MicroProfiler capture requires a running playtest target such as target=\"server\" or target=\"client-1\".",
		};
	}
	const libOrError = requireLibMP();
	if ((libOrError as { Control?: unknown }).Control === undefined) return libOrError;
	const LibMP = libOrError as LibMPLike;

	if (action === "stop") {
		const recording = active;
		if (recording === undefined) {
			return {
				error: "micro_profiler_no_recording",
				message: "No MicroProfiler recording is running on this peer. Start one with action=\"start\" on the same target; a recording ends with its playtest.",
			};
		}
		if (recording.oneShot) {
			return {
				error: "micro_profiler_capture_in_progress",
				message: "A timed capture (action=\"capture\") is recording on this peer and returns by itself; action=\"stop\" ends only recordings opened with action=\"start\".",
				recording: recordingInfo(recording),
			};
		}
		if (recording.stopping) {
			return {
				error: "micro_profiler_no_recording",
				message: "This peer's recording is already being stopped by another action=\"stop\" call, which returns it.",
			};
		}
		// The peer stays busy until the recording has finished: finishing restores
		// capture state, which must not land in the middle of a newer capture.
		recording.stopping = true;
		if (recording.finished === undefined) {
			if (recording.finishing) {
				// The watchdog is stopping it right now.
				while (recording.finished === undefined) task.wait();
			} else {
				recording.finishing = true;
				recording.finished = finishRecording(LibMP, recording);
			}
		}
		if (active === recording) active = undefined;
		return captureResponse(LibMP, recording, recording.finished!, action);
	}

	if (active !== undefined || starting) {
		return {
			error: "micro_profiler_recording_active",
			message: active !== undefined && !active.oneShot
				? "A MicroProfiler recording started with action=\"start\" is still open on this peer. End it with action=\"stop\" first."
				: "Another MicroProfiler capture is recording on this peer. Retry when it returns.",
			recording: active !== undefined ? recordingInfo(active) : undefined,
		};
	}

	const durationMs = action === "capture" ? normalizeDurationMs(requestData.duration_ms) : undefined;
	// beginRecording yields; keep a second request from starting alongside it.
	starting = true;
	const [beginOk, begun] = pcall(() => beginRecording(LibMP, durationMs));
	starting = false;
	if (!beginOk) return { error: "micro_profiler_start_failed", message: tostring(begun) };
	if ((begun as { error?: unknown }).error !== undefined) return begun;
	const recording = begun as Recording;
	active = recording;

	if (action === "start") {
		startWatchdog(LibMP, recording);
		return {
			ok: true,
			action,
			recording: recordingInfo(recording),
			capture_state: { was_recording: recording.prior.recording },
		};
	}

	task.wait(durationMs! / 1000);
	const finished = finishRecording(LibMP, recording);
	if (active === recording) active = undefined;
	return captureResponse(LibMP, recording, finished, action);
}

function readTransfer(requestData: Record<string, unknown>): unknown {
	pruneTransfers();
	const id = requestData.transfer_id;
	if (!typeIs(id, "string")) return { error: "invalid_transfer", message: "transfer_id must be a string." };
	const transfer = transfers.get(id);
	if (transfer === undefined) {
		return { error: "micro_profiler_transfer_expired", message: "The capture transfer is unknown or expired; capture again." };
	}
	const total = buffer.len(transfer.data);
	const offset = requestData.offset;
	const length = requestData.length;
	if (
		!typeIs(offset, "number") || !typeIs(length, "number") || offset !== math.floor(offset) || length !== math.floor(length)
		|| offset < 0 || offset >= total || length < 1 || length > MAX_CHUNK_BYTES || offset + length > total
	) {
		return { error: "invalid_transfer_range", message: `offset and length must select bytes within 0-${total} in chunks of at most ${MAX_CHUNK_BYTES}.` };
	}
	const chunk = buffer.create(length);
	buffer.copy(chunk, 0, transfer.data, offset, length);
	const [encodeOk, encoded] = pcall(() => EncodingService.Base64Encode(chunk));
	if (!encodeOk) return { error: "micro_profiler_transfer_failed", message: `Base64Encode failed: ${tostring(encoded)}` };
	transfer.expiresAt = os.clock() + TRANSFER_TTL_SECONDS;
	// The last chunk releases the capture; an explicit release covers failures.
	if (offset + length === total) transfers.delete(id);
	return { ok: true, transfer_id: id, offset, length, data: buffer.tostring(encoded as buffer) };
}

function releaseTransfer(requestData: Record<string, unknown>): unknown {
	const id = requestData.transfer_id;
	if (typeIs(id, "string")) transfers.delete(id);
	return { ok: true };
}

export = { captureMicroProfiler, readTransfer, releaseTransfer };

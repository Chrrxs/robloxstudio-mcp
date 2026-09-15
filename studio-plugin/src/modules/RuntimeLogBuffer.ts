// Bounded capture for one Peer VM's LogService callbacks.
// Powers get_runtime_logs without parenting state to the DataModel.
//
// A Studio process can host several Peer VMs, and its LogService callbacks are
// delivered in those VM contexts. MCP reads every Peer buffer in an Instance
// and merges them into that process's log stream. Multiplayer Group Instances
// remain isolated and are returned independently.


import { LogService, RunService } from "@rbxts/services";
import PeerRole from "./PeerRole";

type LogLevel = "OUT" | "WARN" | "ERR" | "INFO";

interface RuntimeLogEntry {
	seq: number;
	ts: number; // wall-clock seconds via DateTime, coherent across peers
	level: LogLevel;
	message: string;
	data?: Record<string, unknown>;
	script?: string;
	line?: number;
	stack?: string[];
	count?: number;
	firstTs?: number;
	lastTs?: number;
}

const MAX_BYTES = 64 * 1024;
const HARD_ENTRY_CAP = 50_000;

const entries: RuntimeLogEntry[] = [];
let totalBytes = 0;
let totalDropped = 0;
let nextSeq = 1;
let installed = false;

function levelTag(t: Enum.MessageType): LogLevel {
	if (t === Enum.MessageType.MessageWarning) return "WARN";
	if (t === Enum.MessageType.MessageError) return "ERR";
	if (t === Enum.MessageType.MessageInfo) return "INFO";
	return "OUT";
}

function nowSec(): number {
	return DateTime.now().UnixTimestampMillis / 1000;
}

// Studio occasionally exposes binary-bearing Output messages through
// LogService (for example, plugin hydration diagnostics containing raw CSG
// data). HttpService:JSONEncode rejects those strings outright. Preserve all
// valid UTF-8 verbatim and make only malformed bytes JSON-safe and visible.
function escapeInvalidUtf8(msg: string): string {
	const [valid] = utf8.len(msg);
	// Roblox currently returns nil (not the false declared by @rbxts/types)
	// when it encounters a malformed sequence. A numeric result is the only
	// portable success discriminator across both representations.
	if (typeIs(valid, "number")) return msg;

	const parts: string[] = [];
	let cursor = 1;
	while (cursor <= msg.size()) {
		const [suffixValid, invalidPosition] = utf8.len(msg, cursor);
		if (typeIs(suffixValid, "number")) {
			parts.push(string.sub(msg, cursor));
			break;
		}
		if (!typeIs(invalidPosition, "number")) break;

		if (invalidPosition > cursor) {
			parts.push(string.sub(msg, cursor, invalidPosition - 1));
		}
		const [invalidByte] = string.byte(msg, invalidPosition);
		parts.push(string.format("\\x%02X", invalidByte));
		cursor = invalidPosition + 1;
	}
	return parts.join("");
}

function dropOldestUntilFits(incomingBytes: number): void {
	while (
		entries.size() > 0 &&
		(totalBytes + incomingBytes > MAX_BYTES || entries.size() >= HARD_ENTRY_CAP)
	) {
		const dropped = entries.shift()!;
		totalBytes -= dropped.message.size();
		totalDropped += 1;
	}
}

function pushEntry(
	msg: string,
	t: Enum.MessageType,
	ts = nowSec(),
	data?: Record<string, unknown>,
): void {
	const safeMessage = escapeInvalidUtf8(msg);
	const bytes = safeMessage.size();
	dropOldestUntilFits(bytes);
	entries.push({
		seq: nextSeq,
		ts,
		level: levelTag(t),
		message: safeMessage,
		data,
	});
	nextSeq += 1;
	totalBytes += bytes;
}

interface LogHistoryEntry {
	message: string;
	messageType: Enum.MessageType;
	timestamp: number;
}

function seedRuntimeHistory(): void {
	const [ok, history] = pcall(() => LogService.GetLogHistory() as LogHistoryEntry[]);
	if (!ok) return;
	const isEdit = PeerRole.detect() === "edit";
	// GetLogHistory timestamps and DateTime.now() share Unix time, while
	// os.clock() is elapsed time for this Studio process. Their difference is
	// therefore the process launch boundary. Edit-mode history is filtered to
	// that boundary so startup errors from this launch are recovered without
	// importing history left by an earlier Studio process.
	const processStartedAt = nowSec() - os.clock();

	for (const entry of history) {
		if (!typeIs(entry.message, "string")) continue;
		const timestamp = typeIs(entry.timestamp, "number") ? entry.timestamp : undefined;
		if (isEdit && (timestamp === undefined || timestamp < processStartedAt - 1)) continue;
		pushEntry(entry.message, entry.messageType, timestamp);
	}
}

function install(): void {
	if (installed) return;
	if (!RunService.IsStudio()) return;
	installed = true;
	// Every peer can emit startup logs before the plugin finishes loading.
	// Seed from per-DataModel LogHistory so get_runtime_logs can still see them;
	// edit history is bounded to the current Studio process above.
	seedRuntimeHistory();
	LogService.MessageOut.Connect((msg, t, context?: Record<string, unknown>) => {
		pushEntry(msg, t, undefined, context);
	});
}


interface QueryOptions {
	since?: number;
	tail?: number;
	filter?: string; // Plain substring match, applied to message
	level?: LogLevel;
	sinceTs?: number;
	exclude?: string;
	dedupe?: boolean;
}

const STACK_BEGIN = "Stack Begin";
const STACK_END = "Stack End";
const MILLISECOND_TIMESTAMP_THRESHOLD = 1e11;

function parseStackFrame(frame: string): [string | undefined, number | undefined] {
	const [scriptPath, lineText] = string.match(frame, "^Script '(.-)', Line (%d+)");
	if (!typeIs(scriptPath, "string")) return [undefined, undefined];
	return [scriptPath, tonumber(lineText)];
}

function mergeStackFrames(list: RuntimeLogEntry[]): RuntimeLogEntry[] {
	const merged: RuntimeLogEntry[] = [];
	let index = 0;
	while (index < list.size()) {
		const entry = list[index];
		const following = list[index + 1];
		if (entry.level === "ERR" && following !== undefined && following.level === "INFO" && following.message === STACK_BEGIN) {
			const stack: string[] = [];
			let cursor = index + 2;
			let closed = false;
			while (cursor < list.size()) {
				const frame = list[cursor];
				if (frame.level !== "INFO") break;
				cursor++;
				if (frame.message === STACK_END) {
					closed = true;
					break;
				}
				stack.push(frame.message);
			}
			if (closed) {
				const combined: RuntimeLogEntry = { ...entry, stack };
				for (const frame of stack) {
					const [scriptPath, lineNumber] = parseStackFrame(frame);
					if (scriptPath !== undefined) {
						combined.script = scriptPath;
						combined.line = lineNumber;
						break;
					}
				}
				merged.push(combined);
				index = cursor;
				continue;
			}
		}
		merged.push(entry);
		index++;
	}
	return merged;
}

function dedupeEntries(list: RuntimeLogEntry[]): RuntimeLogEntry[] {
	const deduped: RuntimeLogEntry[] = [];
	const byKey = new Map<string, RuntimeLogEntry>();
	for (const entry of list) {
		const key = `${entry.level}|${entry.script ?? ""}|${entry.line ?? ""}|${entry.message}`;
		const existing = byKey.get(key);
		if (existing === undefined) {
			const first: RuntimeLogEntry = { ...entry, count: 1 };
			byKey.set(key, first);
			deduped.push(first);
		} else {
			existing.count = (existing.count ?? 1) + 1;
			existing.firstTs = existing.firstTs ?? existing.ts;
			existing.lastTs = entry.ts;
		}
	}
	return deduped;
}

function containsSubstring(message: string, needle: string): boolean {
	const [start] = string.find(message, needle, 1, true);
	return start !== undefined;
}

interface QueryResult {
	entries: RuntimeLogEntry[];
	totalDropped: number;
	nextSince: number;
}

function query(opts: QueryOptions): QueryResult {
	let result = opts.since !== undefined
		? entries.filter((e) => e.seq > (opts.since as number))
		: [...entries];

	result = mergeStackFrames(result);

	if (opts.level !== undefined) {
		const level = opts.level;
		result = result.filter((e) => e.level === level);
	}

	if (opts.sinceTs !== undefined) {
		const threshold = opts.sinceTs > MILLISECOND_TIMESTAMP_THRESHOLD ? opts.sinceTs / 1000 : opts.sinceTs;
		result = result.filter((e) => e.ts >= threshold);
	}

	if (opts.filter !== undefined) {
		// Plain substring search (4th arg = true). Pattern matching here was
		// surprising in practice - Lua magic chars in messages would silently
		// not match (e.g. filter="MARK-EDIT" against "MARK-EDIT-001" fails
		// because '-' means "0+" in Lua patterns). Substring search matches
		// most users' mental model of "filter messages containing this text".
		const needle = opts.filter;
		result = result.filter((e) => containsSubstring(e.message, needle));
	}

	if (opts.exclude !== undefined) {
		const needle = opts.exclude;
		result = result.filter((e) => !containsSubstring(e.message, needle));
	}

	if (opts.dedupe === true) {
		result = dedupeEntries(result);
	}

	if (opts.tail !== undefined && result.size() > opts.tail) {
		// roblox-ts arrays don't expose .slice; manual tail copy.
		const tailed: RuntimeLogEntry[] = [];
		const start = result.size() - opts.tail;
		for (let i = start; i < result.size(); i++) {
			tailed.push(result[i]);
		}
		result = tailed;
	}

	const last = entries.size() > 0 ? entries[entries.size() - 1] : undefined;
	return {
		entries: result,
		totalDropped,
		nextSince: last ? last.seq : (opts.since ?? 0),
	};
}

export = {
	install,
	query,
};

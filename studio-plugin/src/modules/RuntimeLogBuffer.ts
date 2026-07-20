// Per-capture in-memory ring buffer for LogService.MessageOut events.
// Powers the get_runtime_logs MCP tool. Replaces the out-of-tree LogBuffer
// primitives + StringValue approach from chrrxs/roblox-mcp-primitives.
//
// Each peer's plugin attaches a MessageOut listener at plugin load (edit DM,
// play-server DM, play-client DM all run their own copy of this module).
// Captured entries live in plugin module-state; nothing is parented to the
// DataModel. The buffer is bounded by a message-byte budget; oldest entries
// drop when over budget.
//
// Capture caveat: returned entries reflect which plugin buffer CAPTURED the
// entry, NOT which peer's script originated the print. LogService reflects
// prints across peers in ordinary Studio Play (a server print can appear in
// server and client LogService:GetLogHistory()). The MCP-side aggregator
// exposes that as capturedBy, and only promotes it to origin peer in
// StudioTestService multiplayer sessions where peer attribution is reliable.

import { LogService, RunService } from "@rbxts/services";

type LogLevel = "OUT" | "WARN" | "ERR" | "INFO";

interface RuntimeLogEntry {
	seq: number;
	ts: number; // wall-clock seconds via DateTime, coherent across peers
	level: LogLevel;
	message: string;
	data?: Record<string, unknown>;
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
	const isEdit = !RunService.IsRunning();
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

function detectPeer(): "edit" | "server" | "client" {
	if (!RunService.IsRunning()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
}

interface QueryOptions {
	since?: number;
	tail?: number;
	filter?: string; // Plain substring match, applied to message
}

interface QueryResult {
	capturedBy: string;
	entries: RuntimeLogEntry[];
	totalDropped: number;
	nextSince: number;
}

function query(opts: QueryOptions, capturedBy: string): QueryResult {
	let result = opts.since !== undefined
		? entries.filter((e) => e.seq > (opts.since as number))
		: [...entries];

	if (opts.filter !== undefined) {
		// Plain substring search (4th arg = true). Pattern matching here was
		// surprising in practice - Lua magic chars in messages would silently
		// not match (e.g. filter="MARK-EDIT" against "MARK-EDIT-001" fails
		// because '-' means "0+" in Lua patterns). Substring search matches
		// most users' mental model of "filter messages containing this text".
		const needle = opts.filter;
		result = result.filter((e) => {
			const [start] = string.find(e.message, needle, 1, true);
			return start !== undefined;
		});
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
		capturedBy,
		entries: result,
		totalDropped,
		nextSince: last ? last.seq : (opts.since ?? 0),
	};
}

export = {
	install,
	detectPeer,
	query,
};

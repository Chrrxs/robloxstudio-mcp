// Exact-text script edits resolved against one source snapshot, so several
// replacements either all apply or none do. Kept free of Studio services so
// the planning logic can be exercised outside Studio.

export interface ScriptEditRequest {
	oldString: string;
	newString: string;
	startLine?: number;
}

interface ResolvedEdit {
	index: number;
	// 1-based byte offsets: the match covers [start, finish).
	start: number;
	finish: number;
	newString: string;
}

export type ScriptEditPlan =
	| { ok: true; newSource: string; diff: string; diffTruncated: boolean }
	| { ok: false; error: string };

const FNV_OFFSET_BASIS = 2166136261;
const UINT32_MODULUS = 4294967296;
const BYTE_CHUNK = 4096;
const DIFF_CHAR_BUDGET = 20000;

/**
 * Content revision of the exact script text: byte length plus FNV-1a 32.
 * It is an optimistic-concurrency token, not a security hash.
 */
export function sourceRevision(source: string): string {
	const length = source.size();
	let hash = FNV_OFFSET_BASIS;
	for (let chunkStart = 1; chunkStart <= length; chunkStart += BYTE_CHUNK) {
		const bytes = [...string.byte(source, chunkStart, math.min(chunkStart + BYTE_CHUNK - 1, length))];
		for (const byte of bytes) {
			hash = bit32.bxor(hash, byte);
			// hash * 16777619 mod 2^32. The FNV prime is 2^24 + 403; splitting the
			// product keeps every intermediate below 2^53, where doubles stay exact.
			hash = (bit32.lshift(hash, 24) + hash * 403) % UINT32_MODULUS;
		}
	}
	return `${length}:${hash}`;
}

// 1-based byte offset at which each line starts. A trailing newline yields a
// final empty line, which is where an anchored insertion at EOF lands.
function lineStarts(source: string): number[] {
	const starts = [1];
	let searchFrom = 1;
	while (true) {
		const [newline] = string.find(source, "\n", searchFrom, true);
		if (newline === undefined) break;
		starts.push(newline + 1);
		searchFrom = newline + 1;
	}
	return starts;
}

// Line containing a byte offset; a newline belongs to the line it ends.
function lineAt(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.size() - 1;
	while (low < high) {
		const middle = math.floor((low + high + 1) / 2);
		if (starts[middle] <= offset) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return low + 1;
}

// Byte offset just past the line's terminator, or past the end of the source.
function lineEnd(starts: number[], source: string, line: number): number {
	return line < starts.size() ? starts[line] : source.size() + 1;
}

function locateEdit(source: string, starts: number[], edit: ScriptEditRequest, label: string): number | string {
	const searchLength = edit.oldString.size();
	if (edit.startLine !== undefined) {
		if (edit.startLine < 1 || edit.startLine % 1 !== 0) {
			return `${label}line must be a positive whole number (got ${edit.startLine}).`;
		}
		if (edit.startLine > starts.size()) {
			return `${label}line ${edit.startLine} is past the end of the script.`;
		}
		const start = starts[edit.startLine - 1];
		if (string.sub(source, start, start + searchLength - 1) !== edit.oldString) {
			return `${label}old_string does not match at line ${edit.startLine}. Use get_script_source to verify the exact text at that line.`;
		}
		return start;
	}
	if (searchLength === 0) {
		return `${label}old_string is empty; pass line_range to insert at the start of a line.`;
	}
	const [first] = string.find(source, edit.oldString, 1, true);
	if (first === undefined) {
		return `${label}old_string not found in script. If old_string contains repeated patterns (e.g. closing braces), pass line_range to anchor the edit.`;
	}
	const [second] = string.find(source, edit.oldString, first + searchLength, true);
	if (second !== undefined) {
		return `${label}old_string matches multiple locations (lines ${lineAt(starts, first)} and ${lineAt(starts, second)}). Provide more surrounding context, or pass line_range to anchor the edit.`;
	}
	return first;
}

// Source text in [regionStart, regionEnd) with every edit in resolved[from, to) applied.
function applyWithin(
	source: string,
	resolved: ResolvedEdit[],
	from: number,
	to: number,
	regionStart: number,
	regionEnd: number,
): string {
	const parts: string[] = [];
	let cursor = regionStart;
	for (let index = from; index < to; index++) {
		const edit = resolved[index];
		parts.push(string.sub(source, cursor, edit.start - 1));
		parts.push(edit.newString);
		cursor = edit.finish;
	}
	parts.push(string.sub(source, cursor, regionEnd - 1));
	return parts.join("");
}

const NO_FINAL_NEWLINE = "\\ No newline at end of file";

// Lines of a diff region. A last line without its newline only occurs at the
// end of the file; it is flagged so that adding or removing that newline still
// differs, as in a unified diff.
interface TextLines {
	lines: string[];
	missingFinalNewline: boolean;
}

function textLines(text: string): TextLines {
	if (text === "") return { lines: [], missingFinalNewline: false };
	const lines = text.split("\n");
	const missingFinalNewline = string.sub(text, -1) !== "\n";
	if (!missingFinalNewline) lines.pop();
	return { lines, missingFinalNewline };
}

function sameLine(a: TextLines, aIndex: number, b: TextLines, bIndex: number): boolean {
	return a.lines[aIndex] === b.lines[bIndex]
		&& (a.missingFinalNewline && aIndex === a.lines.size() - 1)
			=== (b.missingFinalNewline && bIndex === b.lines.size() - 1);
}

function pushHunkLines(hunk: string[], text: TextLines, from: number, count: number, prefix: string): void {
	for (let index = from; index < from + count; index++) {
		hunk.push(`${prefix}${text.lines[index]}`);
		if (text.missingFinalNewline && index === text.lines.size() - 1) hunk.push(NO_FINAL_NEWLINE);
	}
}

function hunkStart(line: number, count: number): number {
	return count === 0 ? line - 1 : line;
}

function editFirstLine(starts: number[], edit: ResolvedEdit): number {
	return lineAt(starts, edit.start);
}

function editLastLine(starts: number[], edit: ResolvedEdit): number {
	return lineAt(starts, edit.finish > edit.start ? edit.finish - 1 : edit.start);
}

// Unified diff of whole changed lines, without context lines. Edits that share
// a line become one hunk; lines the edit left unchanged are trimmed away.
function buildDiff(source: string, starts: number[], resolved: ResolvedEdit[]): { diff: string; truncated: boolean } {
	const output: string[] = [];
	let outputSize = 0;
	let truncated = false;
	let lineDelta = 0;
	let groupStart = 0;
	while (groupStart < resolved.size() && !truncated) {
		const firstLine = editFirstLine(starts, resolved[groupStart]);
		let lastLine = editLastLine(starts, resolved[groupStart]);
		let groupEnd = groupStart + 1;
		let oldText: string;
		let newText: string;
		while (true) {
			while (groupEnd < resolved.size() && editFirstLine(starts, resolved[groupEnd]) <= lastLine) {
				lastLine = math.max(lastLine, editLastLine(starts, resolved[groupEnd]));
				groupEnd++;
			}
			const regionStart = starts[firstLine - 1];
			const regionEnd = lineEnd(starts, source, lastLine);
			oldText = string.sub(source, regionStart, regionEnd - 1);
			newText = applyWithin(source, resolved, groupStart, groupEnd, regionStart, regionEnd);
			// A replacement that drops the region's final newline joins the next
			// line onto it, so that line belongs in the hunk too.
			const nextLineHasText = lastLine < starts.size() && starts[lastLine] <= source.size();
			if (nextLineHasText && string.sub(oldText, -1) === "\n" && string.sub(newText, -1) !== "\n") {
				lastLine++;
				continue;
			}
			break;
		}

		const oldRegion = textLines(oldText);
		const newRegion = textLines(newText);
		const oldSize = oldRegion.lines.size();
		const newSize = newRegion.lines.size();
		let prefix = 0;
		while (prefix < oldSize && prefix < newSize && sameLine(oldRegion, prefix, newRegion, prefix)) prefix++;
		let suffix = 0;
		while (
			suffix < oldSize - prefix
			&& suffix < newSize - prefix
			&& sameLine(oldRegion, oldSize - 1 - suffix, newRegion, newSize - 1 - suffix)
		) suffix++;
		const oldCount = oldSize - prefix - suffix;
		const newCount = newSize - prefix - suffix;

		if (oldCount > 0 || newCount > 0) {
			const oldStart = firstLine + prefix;
			const newStart = oldStart + lineDelta;
			const hunk: string[] = [
				`@@ -${hunkStart(oldStart, oldCount)},${oldCount} +${hunkStart(newStart, newCount)},${newCount} @@`,
			];
			pushHunkLines(hunk, oldRegion, prefix, oldCount, "-");
			pushHunkLines(hunk, newRegion, prefix, newCount, "+");
			for (const line of hunk) {
				if (outputSize + line.size() + 1 > DIFF_CHAR_BUDGET) {
					truncated = true;
					break;
				}
				output.push(line);
				outputSize += line.size() + 1;
			}
		}
		lineDelta += newSize - oldSize;
		groupStart = groupEnd;
	}
	return { diff: output.join("\n"), truncated };
}

/**
 * Resolves every edit against the same source, rejects overlaps, and builds
 * the edited source in memory. Nothing is written: the caller applies
 * newSource in one compare-and-set write, so a bad edit changes nothing.
 * line_range anchors refer to the source as it was before any edit.
 */
export function planScriptEdits(source: string, edits: ScriptEditRequest[], includeDiff: boolean): ScriptEditPlan {
	if (edits.size() === 0) return { ok: false, error: "At least one edit is required." };
	const starts = lineStarts(source);
	const resolved: ResolvedEdit[] = [];
	for (let index = 0; index < edits.size(); index++) {
		const edit = edits[index];
		const label = edits.size() > 1 ? `edits[${index}]: ` : "";
		const located = locateEdit(source, starts, edit, label);
		if (typeIs(located, "string")) return { ok: false, error: located };
		resolved.push({ index, start: located, finish: located + edit.oldString.size(), newString: edit.newString });
		// Insertion sort by position; k is small and ties keep request order.
		for (let at = resolved.size() - 1; at > 0 && resolved[at - 1].start > resolved[at].start; at--) {
			const swap = resolved[at - 1];
			resolved[at - 1] = resolved[at];
			resolved[at] = swap;
		}
	}

	for (let at = 1; at < resolved.size(); at++) {
		const previous = resolved[at - 1];
		const current = resolved[at];
		if (current.start < previous.finish || current.start === previous.start) {
			const first = math.min(previous.index, current.index);
			const second = math.max(previous.index, current.index);
			return {
				ok: false,
				error: `edits[${first}] and edits[${second}] overlap at line ${lineAt(starts, current.start)}; combine them into one edit.`,
			};
		}
	}

	const newSource = applyWithin(source, resolved, 0, resolved.size(), 1, source.size() + 1);
	if (!includeDiff) return { ok: true, newSource, diff: "", diffTruncated: false };
	const built = buildDiff(source, starts, resolved);
	return { ok: true, newSource, diff: built.diff, diffTruncated: built.truncated };
}

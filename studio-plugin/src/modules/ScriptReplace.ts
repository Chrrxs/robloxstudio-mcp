import { diffSources, sourceRevision } from "./ScriptEdits";
import ScriptClasses from "./ScriptClasses";

// Find-and-replace across scripts, planned against one snapshot of every
// matching script before anything is written. The whole plan is checked (the
// replacement cap and any expected revisions) before the first write. Each
// write is a compare-and-set against the planned source, and a failed write
// restores the scripts already written wherever they still hold the written
// text, so a newer editor draft is never overwritten. ChangeHistoryService is
// not relied on to undo Source. Free of Studio services so it can run outside
// Studio.

interface ScriptSnapshot {
	instancePath: string;
	name: string;
	className: string;
	source: string;
}

interface WriteResult {
	success: boolean;
	error?: string;
}

interface ReplaceCorpus<T> {
	resolvePath(path: string): T | undefined;
	getChildren(node: T): T[];
	/** Snapshot of a readable script that passes classFilter, else undefined. */
	readScript(node: T, classFilter?: string): ScriptSnapshot | undefined;
	/** Optional per-request predicate: true when a script's path names several instances. */
	createAmbiguityChecker?(): (node: T) => boolean;
	/** Compare-and-set write: refuses when the script no longer holds expectedSource. */
	writeScript(node: T, newSource: string, expectedSource: string): WriteResult;
	beginRecording(label: string): string | undefined;
	finishRecording(recording: string | undefined, commit: boolean): void;
}

interface ReplaceRequest {
	pattern: string;
	replacement: string;
	caseSensitive: boolean;
	usePattern: boolean;
	path: string;
	classFilter?: string;
	dryRun: boolean;
	maxReplacements: number;
	expectedRevisions?: Map<string, string>;
}

interface PlannedScript<T> {
	node: T;
	snapshot: ScriptSnapshot;
	newSource: string;
	replacements: number;
	revision: string;
	resultRevision: string;
	ambiguous: boolean;
}

type MismatchReason = "changed" | "not_reviewed" | "no_longer_matches" | "missing" | "ambiguous_path";

interface RevisionMismatch {
	instancePath: string;
	reason: MismatchReason;
	expectedRevision?: string;
	revision?: string;
}

type ScriptStatus = "applied" | "failed" | "not_attempted" | "restored" | "restore_failed";

const DEFAULT_MAX_REPLACEMENTS = 1000;
const PREVIEW_DIFF_CHAR_BUDGET = 20000;
// Originals returned when a restore was refused, so the caller can recover them.
const RETAINED_SOURCE_CHAR_BUDGET = 200000;

function readRequest(data: Record<string, unknown>): ReplaceRequest | string {
	const pattern = data.pattern;
	if (!typeIs(pattern, "string") || pattern === "") return "pattern is required";
	const replacement = data.replacement;
	if (!typeIs(replacement, "string")) return "replacement is required";
	for (const option of ["caseSensitive", "usePattern", "dryRun"]) {
		const value = data[option];
		if (value !== undefined && !typeIs(value, "boolean")) return `${option} must be a boolean`;
	}
	const caseSensitive = (data.caseSensitive as boolean | undefined) ?? false;
	const usePattern = (data.usePattern as boolean | undefined) ?? false;
	if (!caseSensitive && usePattern) {
		return "Case-insensitive Lua pattern replacement is not supported. Use caseSensitive: true with usePattern: true, or use literal matching.";
	}
	const path = data.path ?? "";
	if (!typeIs(path, "string")) return "path must be a string";
	const classError = ScriptClasses.classFilterError(data.classFilter);
	if (classError !== undefined) return classError;
	const maxReplacements = data.maxReplacements ?? DEFAULT_MAX_REPLACEMENTS;
	if (!typeIs(maxReplacements, "number") || maxReplacements < 1 || maxReplacements % 1 !== 0) {
		return "maxReplacements must be a positive whole number";
	}

	let expectedRevisions: Map<string, string> | undefined;
	const rawRevisions = data.expectedRevisions;
	if (rawRevisions !== undefined) {
		if (!typeIs(rawRevisions, "table")) return "expectedRevisions must map script paths to revisions";
		expectedRevisions = new Map<string, string>();
		for (const [key, value] of pairs(rawRevisions as Record<string, unknown>)) {
			if (!typeIs(key, "string") || !typeIs(value, "string") || value === "") {
				return "expectedRevisions must map script paths to revisions";
			}
			expectedRevisions.set(key, value);
		}
	}

	return {
		pattern,
		replacement,
		caseSensitive,
		usePattern,
		path,
		classFilter: data.classFilter as string | undefined,
		dryRun: (data.dryRun as boolean | undefined) ?? false,
		maxReplacements,
		expectedRevisions,
	};
}

// Replaces every non-overlapping occurrence, left to right. Case-insensitive
// matching compares lowered copies; string.lower keeps byte offsets.
function replaceLiteral(source: string, search: string, replacement: string, caseSensitive: boolean): [string, number] {
	const haystack = caseSensitive ? source : source.lower();
	const needle = caseSensitive ? search : search.lower();
	const parts: string[] = [];
	let cursor = 1;
	let count = 0;
	while (true) {
		const [found] = string.find(haystack, needle, cursor, true);
		if (found === undefined) break;
		parts.push(string.sub(source, cursor, found - 1));
		parts.push(replacement);
		cursor = found + needle.size();
		count++;
	}
	if (count === 0) return [source, 0];
	parts.push(string.sub(source, cursor));
	return [parts.join(""), count];
}

function createScriptReplace<T extends defined>(corpus: ReplaceCorpus<T>) {
	function replaceIn(request: ReplaceRequest, source: string): [string, number] {
		if (request.usePattern) {
			const [result, count] = string.gsub(source, request.pattern, request.replacement);
			return [result, count];
		}
		return replaceLiteral(source, request.pattern, request.replacement, request.caseSensitive);
	}

	function planScripts(request: ReplaceRequest, root: T): [PlannedScript<T>[], number] {
		const isAmbiguous = corpus.createAmbiguityChecker?.() ?? (() => false);
		const planned: PlannedScript<T>[] = [];
		let scriptsSearched = 0;
		const stack: T[] = [root];
		while (stack.size() > 0) {
			const node = stack.pop()!;
			const snapshot = corpus.readScript(node, request.classFilter);
			if (snapshot !== undefined && ScriptClasses.matchesClassFilter(snapshot.className, request.classFilter)) {
				scriptsSearched++;
				const [newSource, replacements] = replaceIn(request, snapshot.source);
				if (replacements > 0) {
					planned.push({
						node,
						snapshot,
						newSource,
						replacements,
						revision: sourceRevision(snapshot.source),
						resultRevision: sourceRevision(newSource),
						ambiguous: isAmbiguous(node),
					});
				}
			}
			const children = corpus.getChildren(node);
			for (let index = children.size() - 1; index >= 0; index--) stack.push(children[index]);
		}

		// A path shared by two planned scripts cannot key a revision either.
		const pathCounts = new Map<string, number>();
		for (const entry of planned) {
			pathCounts.set(entry.snapshot.instancePath, (pathCounts.get(entry.snapshot.instancePath) ?? 0) + 1);
		}
		for (const entry of planned) {
			if (pathCounts.get(entry.snapshot.instancePath)! > 1) entry.ambiguous = true;
		}
		return [planned, scriptsSearched];
	}

	function checkRevisions(planned: PlannedScript<T>[], expected: Map<string, string>): RevisionMismatch[] {
		const mismatches: RevisionMismatch[] = [];
		const plannedPaths = new Set<string>();
		for (const entry of planned) {
			const instancePath = entry.snapshot.instancePath;
			plannedPaths.add(instancePath);
			const expectedRevision = expected.get(instancePath);
			if (entry.ambiguous) {
				mismatches.push({ instancePath, reason: "ambiguous_path", expectedRevision, revision: entry.revision });
			} else if (expectedRevision === undefined) {
				mismatches.push({ instancePath, reason: "not_reviewed", revision: entry.revision });
			} else if (expectedRevision !== entry.revision) {
				mismatches.push({ instancePath, reason: "changed", expectedRevision, revision: entry.revision });
			}
		}

		const reviewedOnly: string[] = [];
		for (const [instancePath] of expected) {
			if (!plannedPaths.has(instancePath)) reviewedOnly.push(instancePath);
		}
		reviewedOnly.sort();
		for (const instancePath of reviewedOnly) {
			const expectedRevision = expected.get(instancePath)!;
			const node = corpus.resolvePath(instancePath);
			const snapshot = node === undefined ? undefined : corpus.readScript(node);
			if (snapshot === undefined) {
				mismatches.push({ instancePath, reason: "missing", expectedRevision });
				continue;
			}
			const revision = sourceRevision(snapshot.source);
			mismatches.push({
				instancePath,
				reason: revision === expectedRevision ? "no_longer_matches" : "changed",
				expectedRevision,
				revision,
			});
		}
		return mismatches;
	}

	function describePlanned(entry: PlannedScript<T>): Record<string, unknown> {
		const change: Record<string, unknown> = {
			instancePath: entry.snapshot.instancePath,
			name: entry.snapshot.name,
			className: entry.snapshot.className,
			replacements: entry.replacements,
			revision: entry.revision,
			resultRevision: entry.resultRevision,
		};
		if (entry.ambiguous) change.ambiguous = true;
		return change;
	}

	function run(data: Record<string, unknown>): Record<string, unknown> {
		const request = readRequest(data);
		if (typeIs(request, "string")) return { success: false, error: request };
		const root = corpus.resolvePath(request.path);
		if (root === undefined) return { success: false, error: `Path not found: ${request.path}` };

		const summary: Record<string, unknown> = {
			dryRun: request.dryRun,
			pattern: request.pattern,
			replacement: request.replacement,
			maxReplacements: request.maxReplacements,
		};
		// Planning reads and computes only; a malformed Lua pattern fails here,
		// before any write.
		const [scanned, scanResult] = pcall(() => planScripts(request, root));
		if (!scanned) {
			return {
				...summary,
				success: false,
				error: `Script traversal failed: ${scanResult}`,
				totalReplacements: 0,
				scriptsSearched: 0,
				scriptsMatched: 0,
				scriptsModified: 0,
				scriptsFailed: 0,
				changes: [],
			};
		}
		const [scripts, scriptsSearched] = scanResult as [PlannedScript<T>[], number];
		let totalReplacements = 0;
		for (const entry of scripts) totalReplacements += entry.replacements;
		summary.totalReplacements = totalReplacements;
		summary.scriptsSearched = scriptsSearched;
		summary.scriptsMatched = scripts.size();

		const changes = scripts.map(describePlanned);
		const revisions = new Map<string, string>();
		for (const entry of scripts) {
			if (!entry.ambiguous) revisions.set(entry.snapshot.instancePath, entry.revision);
		}
		const refused = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
			...summary,
			...extra,
			success: false,
			code,
			error: message,
			scriptsModified: 0,
			scriptsFailed: 0,
			changes,
		});

		if (request.expectedRevisions !== undefined) {
			const mismatches = checkRevisions(scripts, request.expectedRevisions);
			if (mismatches.size() > 0) {
				return refused(
					"revision_mismatch",
					"The scripts this replacement would change differ from the reviewed expected_revisions; nothing was written. Preview again with dryRun and pass its revisions.",
					{ mismatches },
				);
			}
		}
		if (totalReplacements > request.maxReplacements) {
			return refused(
				"max_replacements_exceeded",
				`This replacement makes ${totalReplacements} replacements, more than maxReplacements (${request.maxReplacements}); nothing was written. Narrow path or classFilter, or raise maxReplacements.`,
			);
		}

		if (request.dryRun) {
			let diffBudget = PREVIEW_DIFF_CHAR_BUDGET;
			let anyDiffTruncated = false;
			for (let index = 0; index < scripts.size(); index++) {
				const entry = scripts[index];
				const change = changes[index];
				if (diffBudget <= 0) {
					change.diffTruncated = true;
					anyDiffTruncated = true;
					continue;
				}
				const built = diffSources(entry.snapshot.source, entry.newSource, diffBudget);
				change.diff = built.diff;
				diffBudget -= built.diff.size() + 1;
				if (built.truncated) {
					change.diffTruncated = true;
					anyDiffTruncated = true;
				}
			}
			const preview: Record<string, unknown> = {
				...summary,
				success: true,
				// Scripts the apply would modify.
				scriptsModified: scripts.size(),
				scriptsFailed: 0,
				changes,
			};
			// Pass back as expected_revisions to apply exactly this plan. Omitted
			// when empty: Luau encodes an empty table as a JSON array.
			if (scripts.some((entry) => !entry.ambiguous)) preview.revisions = revisions;
			if (anyDiffTruncated) preview.diffTruncated = true;
			return preview;
		}

		if (scripts.size() === 0) {
			return { ...summary, success: true, scriptsModified: 0, scriptsFailed: 0, changes };
		}

		const recording = corpus.beginRecording("Find and replace in scripts");
		const write = (node: T, newSource: string, expectedSource: string): WriteResult => {
			const [ok, result] = pcall(() => corpus.writeScript(node, newSource, expectedSource));
			return ok ? (result as WriteResult) : { success: false, error: tostring(result) };
		};
		let failedAt: number | undefined;
		let failure: string | undefined;
		for (let index = 0; index < scripts.size(); index++) {
			const entry = scripts[index];
			const result = write(entry.node, entry.newSource, entry.snapshot.source);
			if (!result.success) {
				failedAt = index;
				failure = result.error ?? "Script write failed verification";
				break;
			}
			changes[index].status = "applied";
		}

		if (failedAt === undefined) {
			corpus.finishRecording(recording, true);
			return { ...summary, success: true, scriptsModified: scripts.size(), scriptsFailed: 0, changes };
		}

		const statuses: ScriptStatus[] = [];
		for (let index = 0; index < scripts.size(); index++) {
			statuses.push(index < failedAt ? "applied" : index === failedAt ? "failed" : "not_attempted");
		}
		changes[failedAt].error = failure;
		// A failed write can still have landed (verification refused it); if the
		// script holds the written text, undo it like the others.
		const failedEntry = scripts[failedAt];
		const holds = (entry: PlannedScript<T>, source: string): boolean => {
			const [readOk, current] = pcall(() => corpus.readScript(entry.node));
			return readOk && current !== undefined && current.source === source;
		};
		const restoreFrom = holds(failedEntry, failedEntry.newSource) ? failedAt : failedAt - 1;

		let retainedBudget = RETAINED_SOURCE_CHAR_BUDGET;
		let restored = 0;
		let restoreFailed = 0;
		for (let index = restoreFrom; index >= 0; index--) {
			const entry = scripts[index];
			const change = changes[index];
			const result = write(entry.node, entry.snapshot.source, entry.newSource);
			// A restore refused by verification can still have landed.
			if (result.success || holds(entry, entry.snapshot.source)) {
				statuses[index] = "restored";
				restored++;
				continue;
			}
			statuses[index] = "restore_failed";
			restoreFailed++;
			change.restoreError = result.error ?? "Script restore failed verification";
			if (entry.snapshot.source.size() <= retainedBudget) {
				change.originalSource = entry.snapshot.source;
				retainedBudget -= entry.snapshot.source.size();
			} else {
				change.originalSourceOmitted = true;
			}
		}
		for (let index = 0; index < scripts.size(); index++) changes[index].status = statuses[index];
		corpus.finishRecording(recording, restoreFailed > 0);

		let notAttempted = 0;
		for (const status of statuses) if (status === "not_attempted") notAttempted++;
		const restoreSummary = restoreFailed > 0
			? `${restored} written script(s) were restored; ${restoreFailed} changed again after the write and were left as they are, with their original source in changes[].originalSource where it fits.`
			: `${restored} written script(s) were restored.`;
		return {
			...summary,
			success: false,
			code: "apply_failed",
			error: `Failed to write ${failedEntry.snapshot.instancePath}: ${failure}. ${restoreSummary}`,
			scriptsModified: restoreFailed,
			scriptsRestored: restored,
			scriptsFailed: 1,
			scriptsNotAttempted: notAttempted,
			changes,
		};
	}

	return { run };
}

export = {
	createScriptReplace,
};

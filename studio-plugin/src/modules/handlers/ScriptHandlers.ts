import Utils from "../Utils";
import Recording from "../Recording";
import ScriptReplace from "../ScriptReplace";
import { planScriptEdits, sourceRevision, ScriptEditRequest } from "../ScriptEdits";

const {
	getInstancePath,
	getInstanceByPath,
	createPathAmbiguityChecker,
	readScriptSource,
	applyScriptSource,
	splitLines,
	joinLines,
} = Utils;
const { beginRecording, finishRecording } = Recording;

const SOURCE_TRUNCATE_CHAR_BUDGET = 25000;
const SOURCE_TRUNCATE_LINE_BUDGET = 400;
const SOURCE_TRUNCATE_TO_LINES = 300;

function getTopServiceName(instance: Instance): string {
	let topServiceInst: Instance = instance;
	while (topServiceInst.Parent && topServiceInst.Parent !== game) {
		topServiceInst = topServiceInst.Parent;
	}
	return topServiceInst.Name;
}

function sliceLines(lines: string[], startLine: number, endLine: number): string[] {
	const selectedLines: string[] = [];
	for (let i = startLine; i <= endLine; i++) {
		selectedLines.push(lines[i - 1] ?? "");
	}
	return selectedLines;
}

function numberLines(lines: string[], lineOffset: number): string {
	const numberedLines: string[] = [];
	for (let i = 0; i < lines.size(); i++) {
		numberedLines.push(`${i + lineOffset}: ${lines[i]}`);
	}
	return numberedLines.join("\n");
}

function getScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number | undefined;
	const endLine = requestData.endLine as number | undefined;

	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [success, result] = pcall(() => {
		const fullSource = readScriptSource(instance);
		const [lines, hasTrailingNewline] = splitLines(fullSource);
		const totalLineCount = lines.size();
		const explicitRange = startLine !== undefined || endLine !== undefined;
		const shouldTruncate = !explicitRange &&
			(fullSource.size() > SOURCE_TRUNCATE_CHAR_BUDGET || totalLineCount > SOURCE_TRUNCATE_LINE_BUDGET);
		const returnedStartLine = explicitRange ? math.max(1, startLine ?? 1) : 1;
		const returnedEndLine = shouldTruncate
			? math.min(SOURCE_TRUNCATE_TO_LINES, totalLineCount)
			: explicitRange ? math.min(totalLineCount, endLine ?? totalLineCount) : totalLineCount;
		const selectedLines = (explicitRange || shouldTruncate)
			? sliceLines(lines, returnedStartLine, returnedEndLine)
			: lines;
		const sourceToReturn = explicitRange
			? joinLines(selectedLines, hasTrailingNewline && returnedEndLine === totalLineCount)
			: shouldTruncate ? selectedLines.join("\n") : fullSource;

		const resp: Record<string, unknown> = {
			instancePath,
			className: instance.ClassName,
			name: instance.Name,
			source: sourceToReturn,
			numberedSource: numberLines(selectedLines, returnedStartLine),
			sourceLength: fullSource.size(),
			lineCount: totalLineCount,
			revision: sourceRevision(fullSource),
			startLine: returnedStartLine,
			endLine: returnedEndLine,
			isPartial: explicitRange,
			truncated: shouldTruncate,
		};

		if (shouldTruncate) {
			resp.note = `Script truncated to first ${returnedEndLine} of ${totalLineCount} lines (${fullSource.size()} chars). Use line_range to read specific sections.`;
		}

		if (instance.IsA("BaseScript")) {
			resp.enabled = instance.Enabled;
		}

		resp.topService = getTopServiceName(instance);

		return resp;
	});

	if (success) {
		return result;
	} else {
		return { error: `Failed to get script source: ${result}` };
	}
}

// The revision_mismatch response shared by every revision-checked script
// write, or undefined when no revision was expected or it still matches.
function revisionMismatch(instancePath: string, source: string, expectedRevision: string | undefined) {
	if (expectedRevision === undefined) return undefined;
	const revision = sourceRevision(source);
	if (revision === expectedRevision) return undefined;
	return {
		error: "Script changed since expected_revision; read it again with get_script_source and retry.",
		code: "revision_mismatch",
		instancePath,
		expectedRevision,
		revision,
	};
}

function readExpectedRevision(requestData: Record<string, unknown>): string | undefined | false {
	const expectedRevision = requestData.expectedRevision;
	if (expectedRevision === undefined) return undefined;
	return typeIs(expectedRevision, "string") && expectedRevision !== "" ? expectedRevision : false;
}

function setScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const newSource = requestData.source;
	const expectedRevision = readExpectedRevision(requestData);

	if (!instancePath || !typeIs(newSource, "string")) return { error: "Instance path and source are required" };
	if (expectedRevision === false) return { error: "expectedRevision must be a nonempty string" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	// Communication has already JSON-decoded the transport payload; source text is exact at this boundary.
	const sourceToSet = newSource;
	const [readSuccess, readResult] = pcall(() => readScriptSource(instance));
	if (!readSuccess) {
		return { error: `Failed to read script source before updating: ${readResult}` };
	}
	const oldSource = readResult as string;
	const mismatch = revisionMismatch(instancePath, oldSource, expectedRevision);
	if (mismatch) return mismatch;

	const recordingId = beginRecording(`Set script source: ${instance.Name}`);
	// A revision-checked replacement is a compare-and-set against the checked text,
	// so a draft typed while UpdateSourceAsync yields is not overwritten.
	const applyResult = expectedRevision === undefined
		? applyScriptSource(instance, sourceToSet)
		: applyScriptSource(instance, sourceToSet, oldSource);

	if (applyResult.success) {
		finishRecording(recordingId, true);
		return {
			success: true, instancePath,
			oldSourceLength: oldSource.size(), newSourceLength: sourceToSet.size(),
			revision: sourceRevision(sourceToSet),
			method: applyResult.method,
			message: `Script source updated successfully (${applyResult.method === "UpdateSourceAsync" ? "editor-safe" : "direct assignment"})`,
		};
	}

	finishRecording(recordingId, false);
	return {
		error: `Failed to set script source: ${applyResult.error}`,
	};
}

// Accepts the batched `edits` array or the single top-level old_string form.
function readScriptEdits(requestData: Record<string, unknown>): ScriptEditRequest[] | string {
	const rawEdits = requestData.edits;
	if (rawEdits === undefined) {
		const oldString = requestData.old_string;
		const newString = requestData.new_string;
		const startLine = requestData.startLine;
		if (!typeIs(oldString, "string") || !typeIs(newString, "string")) {
			return "Instance path, old_string, and new_string are required";
		}
		if (startLine !== undefined && !typeIs(startLine, "number")) return "startLine must be a number";
		return [{ oldString, newString, startLine }];
	}
	if (!typeIs(rawEdits, "table")) return "edits must be an array";
	const edits: ScriptEditRequest[] = [];
	for (const rawEdit of rawEdits as unknown[]) {
		const index = edits.size();
		if (!typeIs(rawEdit, "table")) return `edits[${index}] must be an object`;
		const fields = rawEdit as Record<string, unknown>;
		const oldString = fields.old_string;
		const newString = fields.new_string;
		const startLine = fields.startLine;
		if (!typeIs(oldString, "string") || !typeIs(newString, "string")) {
			return `edits[${index}] requires old_string and new_string`;
		}
		if (startLine !== undefined && !typeIs(startLine, "number")) return `edits[${index}].startLine must be a number`;
		edits.push({ oldString, newString, startLine });
	}
	if (edits.size() === 0) return "edits must contain at least one edit";
	return edits;
}

function editScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const expectedRevision = requestData.expectedRevision;
	const dryRun = requestData.dryRun === true;

	if (!instancePath) return { error: "Instance path is required" };
	const edits = readScriptEdits(requestData);
	if (typeIs(edits, "string")) return { error: edits };
	if (expectedRevision !== undefined && !typeIs(expectedRevision, "string")) {
		return { error: "expectedRevision must be a string" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [readSuccess, readResult] = pcall(() => readScriptSource(instance));
	if (!readSuccess) return { error: `Failed to edit script: ${readResult}` };
	const source = readResult as string;
	const revision = sourceRevision(source);
	const mismatch = revisionMismatch(instancePath, source, expectedRevision as string | undefined);
	if (mismatch) return mismatch;

	const plan = planScriptEdits(source, edits, dryRun);
	if (!plan.ok) return { error: `Failed to edit script: ${plan.error}` };

	if (dryRun) {
		const preview: Record<string, unknown> = {
			success: true,
			dryRun: true,
			instancePath,
			editCount: edits.size(),
			revision,
			resultRevision: sourceRevision(plan.newSource),
			diff: plan.diff,
		};
		if (plan.diffTruncated) preview.diffTruncated = true;
		return preview;
	}

	const recordingId = beginRecording(edits.size() > 1
		? `Edit script (${edits.size()} edits): ${instance.Name}`
		: `Edit script: ${instance.Name}`);
	// One compare-and-set write: a draft typed since the read rejects the whole batch.
	const applyResult = applyScriptSource(instance, plan.newSource, source);
	if (!applyResult.success) {
		finishRecording(recordingId, false);
		return { error: `Failed to edit script: ${applyResult.error}` };
	}
	finishRecording(recordingId, true);
	return {
		success: true,
		instancePath,
		editCount: edits.size(),
		revision: sourceRevision(plan.newSource),
		method: applyResult.method,
		message: "Script edited successfully",
	};
}

function insertScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const afterLine = (requestData.afterLine as number) ?? 0;
	const newContent = requestData.newContent as string;
	const expectedRevision = readExpectedRevision(requestData);

	if (!instancePath || !newContent) return { error: "Instance path and newContent are required" };
	if (expectedRevision === false) return { error: "expectedRevision must be a nonempty string" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [readSuccess, readResult] = pcall(() => readScriptSource(instance));
	if (!readSuccess) return { error: `Failed to insert script lines: ${readResult}` };
	const source = readResult as string;
	const mismatch = revisionMismatch(instancePath, source, expectedRevision);
	if (mismatch) return mismatch;

	const recordingId = beginRecording(`Insert script lines after line ${afterLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(source);
		const totalLines = lines.size();

		if (afterLine < 0 || afterLine > totalLines) error(`afterLine out of range (0-${totalLines})`);

		const [newLines] = splitLines(newContent);
		const resultLines: string[] = [];

		for (let i = 0; i < afterLine; i++) resultLines.push(lines[i]);
		for (const line of newLines) resultLines.push(line);
		for (let i = afterLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		const applyResult = applyScriptSource(instance, newSource, source);
		if (!applyResult.success) error(applyResult.error);

		return {
			success: true, instancePath,
			insertedAfterLine: afterLine,
			linesInserted: newLines.size(),
			newLineCount: resultLines.size(),
			revision: sourceRevision(newSource),
			method: applyResult.method,
			message: "Script lines inserted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to insert script lines: ${result}` };
}

function deleteScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const startLine = requestData.startLine as number;
	const endLine = requestData.endLine as number;
	const expectedRevision = readExpectedRevision(requestData);

	if (!instancePath || !startLine || !endLine) {
		return { error: "Instance path, startLine, and endLine are required" };
	}
	if (expectedRevision === false) return { error: "expectedRevision must be a nonempty string" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const [readSuccess, readResult] = pcall(() => readScriptSource(instance));
	if (!readSuccess) return { error: `Failed to delete script lines: ${readResult}` };
	const source = readResult as string;
	// Line numbers name different text once the script changes; a revision
	// keeps a retried delete from removing lines it never saw.
	const mismatch = revisionMismatch(instancePath, source, expectedRevision);
	if (mismatch) return mismatch;

	const recordingId = beginRecording(`Delete script lines ${startLine}-${endLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const [lines, hadTrailingNewline] = splitLines(source);
		const totalLines = lines.size();

		if (startLine < 1 || startLine > totalLines) error(`startLine out of range (1-${totalLines})`);
		if (endLine < startLine || endLine > totalLines) error(`endLine out of range (${startLine}-${totalLines})`);

		const resultLines: string[] = [];
		for (let i = 0; i < startLine - 1; i++) resultLines.push(lines[i]);
		for (let i = endLine; i < totalLines; i++) resultLines.push(lines[i]);

		const newSource = joinLines(resultLines, hadTrailingNewline);
		const applyResult = applyScriptSource(instance, newSource, source);
		if (!applyResult.success) error(applyResult.error);

		return {
			success: true, instancePath,
			deletedLines: { startLine, endLine },
			linesDeleted: endLine - startLine + 1,
			newLineCount: resultLines.size(),
			revision: sourceRevision(newSource),
			method: applyResult.method,
			message: "Script lines deleted successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to delete script lines: ${result}` };
}

const scriptReplace = ScriptReplace.createScriptReplace<Instance>({
	resolvePath(path: string): Instance | undefined {
		return path === "" ? game : getInstanceByPath(path);
	},
	getChildren(instance: Instance): Instance[] {
		return instance.GetChildren();
	},
	readScript(instance: Instance, classFilter?: string) {
		if (!instance.IsA("LuaSourceContainer")) return undefined;
		if (classFilter !== undefined && instance.ClassName !== classFilter) return undefined;
		return {
			instancePath: getInstancePath(instance),
			name: instance.Name,
			className: instance.ClassName,
			source: readScriptSource(instance),
		};
	},
	createAmbiguityChecker(): (instance: Instance) => boolean {
		return createPathAmbiguityChecker();
	},
	writeScript(instance: Instance, newSource: string, expectedSource: string) {
		// Only planned scripts are written, and planning admits LuaSourceContainers only.
		return applyScriptSource(instance as LuaSourceContainer, newSource, expectedSource);
	},
	beginRecording(label: string): string | undefined {
		return beginRecording(label);
	},
	finishRecording(recording: string | undefined, commit: boolean): void {
		finishRecording(recording, commit);
	},
});

function findAndReplaceInScripts(requestData: Record<string, unknown>) {
	return scriptReplace.run(requestData);
}

export = {
	getScriptSource,
	setScriptSource,
	editScriptLines,
	insertScriptLines,
	deleteScriptLines,
	findAndReplaceInScripts,
};

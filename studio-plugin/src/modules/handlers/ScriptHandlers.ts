import Utils from "../Utils";
import Recording from "../Recording";

const { getInstancePath, getInstanceByPath, readScriptSource, applyScriptSource, splitLines, joinLines } = Utils;
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

function setScriptSource(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const newSource = requestData.source;

	if (!instancePath || !typeIs(newSource, "string")) return { error: "Instance path and source are required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	// Communication has already JSON-decoded the poll payload; source text is exact at this boundary.
	const sourceToSet = newSource;
	const recordingId = beginRecording(`Set script source: ${instance.Name}`);

	const [readSuccess, readResult] = pcall(() => readScriptSource(instance).size());
	if (!readSuccess) {
		finishRecording(recordingId, false);
		return { error: `Failed to read script source before updating: ${readResult}` };
	}
	const oldSourceLength = readResult as number;
	const applyResult = applyScriptSource(instance, sourceToSet);

	if (applyResult.success) {
		finishRecording(recordingId, true);
		return {
			success: true, instancePath,
			oldSourceLength, newSourceLength: sourceToSet.size(),
			method: applyResult.method,
			message: `Script source updated successfully (${applyResult.method === "UpdateSourceAsync" ? "editor-safe" : "direct assignment"})`,
		};
	}

	finishRecording(recordingId, false);
	return {
		error: `Failed to set script source: ${applyResult.error}`,
	};
}

function editScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const oldString = requestData.old_string as string;
	const newString = requestData.new_string as string;
	const startLine = requestData.startLine as number | undefined;

	if (!instancePath || oldString === undefined || newString === undefined) {
		return { error: "Instance path, old_string, and new_string are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const recordingId = beginRecording(`Edit script: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
		const searchLen = oldString.size();
		let matchStart: number;

		if (startLine !== undefined) {
			if (startLine < 1) error(`startLine must be >= 1 (got ${startLine})`);

			let lineStartByte = 1;
			let currentLine = 1;
			while (currentLine < startLine) {
				const [nlPos] = string.find(source, "\n", lineStartByte, true);
				if (nlPos === undefined) {
					error(`startLine ${startLine} is past end of script (${currentLine} lines)`);
				}
				lineStartByte = (nlPos as number) + 1;
				currentLine++;
			}

			const candidate = string.sub(source, lineStartByte, lineStartByte + searchLen - 1);
			if (candidate !== oldString) {
				error(`old_string does not match at line ${startLine}. Use get_script_source to verify the exact text at that line.`);
			}
			matchStart = lineStartByte;
		} else {
			let count = 0;
			let searchPos = 1;
			let firstMatch: number | undefined;
			while (true) {
				const [foundStart] = string.find(source, oldString, searchPos, true);
				if (foundStart === undefined) break;
				if (firstMatch === undefined) firstMatch = foundStart;
				count++;
				if (count > 1) break;
				searchPos = foundStart + searchLen;
			}
			if (count === 0) error("old_string not found in script. If old_string contains repeated patterns (e.g. closing braces), pass startLine to anchor the edit.");
			if (count > 1) error("old_string matches multiple locations. Provide more surrounding context, or pass startLine to anchor the edit to a specific line.");
			matchStart = firstMatch as number;
		}

		// Byte-slice replacement avoids Lua pattern escaping (safe for multi-byte chars like em dashes).
		const newSource = string.sub(source, 1, matchStart - 1) + newString + string.sub(source, matchStart + searchLen);

		const applyResult = applyScriptSource(instance, newSource, source);
		if (!applyResult.success) error(applyResult.error);

		return {
			success: true,
			instancePath,
			method: applyResult.method,
			message: "Script edited successfully",
		};
	});

	if (success) {
		finishRecording(recordingId, true);
		return result;
	}
	finishRecording(recordingId, false);
	return { error: `Failed to edit script: ${result}` };
}

function insertScriptLines(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const afterLine = (requestData.afterLine as number) ?? 0;
	const newContent = requestData.newContent as string;

	if (!instancePath || !newContent) return { error: "Instance path and newContent are required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const recordingId = beginRecording(`Insert script lines after line ${afterLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
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

	if (!instancePath || !startLine || !endLine) {
		return { error: "Instance path, startLine, and endLine are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: `Instance is not a script-like object: ${instance.ClassName}` };
	}

	const recordingId = beginRecording(`Delete script lines ${startLine}-${endLine}: ${instance.Name}`);

	const [success, result] = pcall(() => {
		const source = readScriptSource(instance);
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

function escapeLuaPattern(s: string): string {
	return s.gsub("([%(%)%.%%%+%-%*%?%[%]%^%$])", "%%%1")[0];
}

function escapeLuaReplacement(s: string): string {
	return s.gsub("%%", "%%%%")[0];
}

function caseInsensitiveLiteralReplace(src: string, searchStr: string, repl: string): [string, number] {
	const lowerSrc = src.lower();
	const lowerSearch = searchStr.lower();
	const parts: string[] = [];
	let lastEnd = 1;
	const searchLen = lowerSearch.size();
	let pos = 1;
	let replCount = 0;

	while (true) {
		const [foundStart] = string.find(lowerSrc, lowerSearch, pos, true);
		if (foundStart === undefined) break;
		parts.push(string.sub(src, lastEnd, foundStart - 1));
		parts.push(repl);
		lastEnd = foundStart + searchLen;
		pos = foundStart + searchLen;
		replCount++;
	}
	parts.push(string.sub(src, lastEnd));
	return [parts.join(""), replCount];
}

function findAndReplaceInScripts(requestData: Record<string, unknown>) {
	const searchPattern = requestData.pattern as string;
	const replacement = requestData.replacement as string;

	if (!searchPattern) return { error: "pattern is required" };
	if (replacement === undefined) return { error: "replacement is required" };

	const caseSensitive = (requestData.caseSensitive as boolean) ?? false;
	const usePattern = (requestData.usePattern as boolean) ?? false;
	const searchPath = (requestData.path as string) ?? "";
	const classFilter = requestData.classFilter as string | undefined;
	const dryRun = (requestData.dryRun as boolean) ?? false;
	const maxReplacements = (requestData.maxReplacements as number) ?? 1000;

	if (!caseSensitive && usePattern) {
		return { error: "Case-insensitive Lua pattern replacement is not supported. Use caseSensitive: true with usePattern: true, or use literal matching." };
	}

	const startInstance = searchPath !== "" ? getInstanceByPath(searchPath) : game;
	if (!startInstance) return { error: `Path not found: ${searchPath}` };

	interface ScriptChange {
		instancePath: string;
		name: string;
		className: string;
		replacements: number;
		error?: string;
	}

	const changes: ScriptChange[] = [];
	let totalReplacements = 0;
	let scriptsSearched = 0;
	let hitLimit = false;

	const recordingId = dryRun ? undefined : beginRecording("Find and replace in scripts");

	function processInstance(instance: Instance) {
		if (hitLimit) return;

		const matchesClass = classFilter === undefined
			|| instance.ClassName.lower().find(classFilter.lower())[0] !== undefined;
		if (instance.IsA("LuaSourceContainer") && matchesClass) {
			scriptsSearched++;
			const source = readScriptSource(instance);

			let newSource: string;
			let replCount: number;

			if (usePattern) {
				const [result, count] = string.gsub(source, searchPattern, replacement);
				newSource = result;
				replCount = count;
			} else if (caseSensitive) {
				const escaped = escapeLuaPattern(searchPattern);
				const escapedRepl = escapeLuaReplacement(replacement);
				const [result, count] = string.gsub(source, escaped, escapedRepl);
				newSource = result;
				replCount = count;
			} else {
				[newSource, replCount] = caseInsensitiveLiteralReplace(source, searchPattern, replacement);
			}

			if (replCount > 0) {
				if (totalReplacements + replCount > maxReplacements) {
					hitLimit = true;
					return;
				}

				const applyResult = dryRun
					? undefined
					: applyScriptSource(instance, newSource, source);
				if (applyResult !== undefined && !applyResult.success) {
					changes.push({
						instancePath: getInstancePath(instance),
						name: instance.Name,
						className: instance.ClassName,
						replacements: 0,
						error: applyResult.error ?? "Script write failed verification",
					});
				} else {
					totalReplacements += replCount;
					changes.push({
						instancePath: getInstancePath(instance),
						name: instance.Name,
						className: instance.ClassName,
						replacements: replCount,
					});
				}
			}
		}

		for (const child of instance.GetChildren()) {
			if (hitLimit) return;
			processInstance(child);
		}
	}

	const [traversalSuccess, traversalResult] = pcall(() => processInstance(startInstance));

	const failedScripts = changes.filter((change) => change.error !== undefined).size();
	const scriptsModified = changes.size() - failedScripts;
	if (recordingId !== undefined) {
		finishRecording(recordingId, scriptsModified > 0);
	}

	return {
		success: traversalSuccess && failedScripts === 0,
		error: traversalSuccess ? undefined : `Script traversal failed: ${traversalResult}`,
		dryRun,
		pattern: searchPattern,
		replacement,
		totalReplacements,
		scriptsSearched,
		scriptsModified,
		scriptsFailed: failedScripts,
		changes,
		truncated: hitLimit,
	};
}

export = {
	getScriptSource,
	setScriptSource,
	editScriptLines,
	insertScriptLines,
	deleteScriptLines,
	findAndReplaceInScripts,
};

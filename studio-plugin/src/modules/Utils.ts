const ScriptEditorService = game.GetService("ScriptEditorService");

const LUAU_KEYWORDS = new Set<string>([
	"and", "break", "continue", "do", "else", "elseif", "end", "export",
	"false", "for", "function", "if", "in", "local", "nil", "not", "or",
	"repeat", "return", "then", "true", "type", "until", "while",
]);

function safeCall<T>(func: (...args: never[]) => T, ...args: never[]): T | undefined {
	const [success, result] = pcall(func, ...args);
	if (success) {
		return result;
	} else {
		warn(`MCP Plugin Error: ${result}`);
		return undefined;
	}
}

function isSimplePathSegment(segment: string): boolean {
	return segment.match("^[%a_][%w_]*$")[0] !== undefined && !LUAU_KEYWORDS.has(segment);
}

function quotePathSegment(segment: string): string {
	let escaped = segment.gsub("\\", "\\\\")[0];
	escaped = escaped.gsub("\n", "\\n")[0];
	escaped = escaped.gsub("\r", "\\r")[0];
	escaped = escaped.gsub("\t", "\\t")[0];
	escaped = escaped.gsub('"', '\\"')[0];
	return `"${escaped}"`;
}

function unescapePathSegment(segment: string): string {
	const chars: string[] = [];
	let i = 1;
	while (i <= segment.size()) {
		const ch = segment.sub(i, i);
		if (ch === "\\" && i < segment.size()) {
			const nextChar = segment.sub(i + 1, i + 1);
			if (nextChar === "n") {
				chars.push("\n");
			} else if (nextChar === "r") {
				chars.push("\r");
			} else if (nextChar === "t") {
				chars.push("\t");
			} else {
				chars.push(nextChar);
			}
			i += 2;
		} else {
			chars.push(ch);
			i += 1;
		}
	}
	return chars.join("");
}

function isCanonicalBracketStart(path: string, index: number): boolean {
	const quote = path.sub(index + 1, index + 1);
	return (quote === '"' || quote === "'") && path.sub(index - 1, index - 1) !== ".";
}

function parseInstancePath(path: string): string[] | undefined {
	let i = 1;
	const len = path.size();
	const parts: string[] = [];
	let current = "";

	if (path === "" || path === "game") return parts;
	if (path.sub(1, 5) === "game.") {
		i = 6;
	} else if (path.sub(1, 5) === "game[") {
		i = 5;
	}

	while (i <= len) {
		const ch = path.sub(i, i);

		if (ch === ".") {
			if (current !== "") {
				parts.push(current);
				current = "";
				i += 1;
			} else if (i > 1 && path.sub(i - 1, i - 1) === "." && i < len && path.sub(i + 1, i + 1) !== "[") {
				// Back-compat for previously emitted paths such as
				// game.ServerScriptService..dir.ReproScript, where ".dir"
				// was an actual instance name.
				current = ".";
				i += 1;
			} else {
				i += 1;
			}
		} else if (ch === "[" && i < len && isCanonicalBracketStart(path, i)) {
			if (current !== "") {
				parts.push(current);
				current = "";
			}

			const quote = path.sub(i + 1, i + 1);
			if (quote !== '"' && quote !== "'") return undefined;
			let j = i + 2;
			let raw = "";
			while (j <= len) {
				const c = path.sub(j, j);
				if (c === "\\") {
					if (j >= len) return undefined;
					raw += c + path.sub(j + 1, j + 1);
					j += 2;
				} else if (c === quote) {
					break;
				} else {
					raw += c;
					j += 1;
				}
			}
			if (j > len || path.sub(j, j) !== quote || path.sub(j + 1, j + 1) !== "]") return undefined;
			parts.push(unescapePathSegment(raw));
			i = j + 2;
		} else {
			current += ch;
			i += 1;
		}
	}

	if (current !== "") parts.push(current);
	return parts;
}

function getRootSegment(instance: Instance): string {
	if (instance.Parent === game) {
		const [ok, service] = pcall(() => game.GetService(instance.ClassName as keyof Services));
		if (ok && service === instance) {
			return instance.ClassName;
		}
	}
	return instance.Name;
}

function getInstancePath(instance: Instance): string {
	if (!instance || instance === game) {
		return "game";
	}

	const pathParts: string[] = [];
	let current: Instance | undefined = instance;

	while (current && current !== game) {
		pathParts.unshift(getRootSegment(current));
		current = current.Parent as Instance | undefined;
	}

	let path = "game";
	for (const part of pathParts) {
		if (isSimplePathSegment(part)) {
			path += `.${part}`;
		} else {
			path += `[${quotePathSegment(part)}]`;
		}
	}
	return path;
}

function getRootInstance(segment: string): Instance | undefined {
	const [ok, service] = pcall(() => game.GetService(segment as keyof Services));
	if (ok && service) return service as Instance;
	return game.FindFirstChild(segment);
}

function getInstanceByPath(path: string): Instance | undefined {
	const parts = parseInstancePath(path);
	if (parts === undefined) return undefined;
	if (parts.size() === 0) return game;

	let current: Instance | undefined = getRootInstance(parts[0]);
	for (let i = 1; i < parts.size(); i++) {
		const part = parts[i];
		if (!current) return undefined;
		current = current.FindFirstChild(part);
	}

	return current;
}

function splitLines(source: string): LuaTuple<[string[], boolean]> {
	const normalized = ((source ?? "") as string).gsub("\r\n", "\n")[0].gsub("\r", "\n")[0];
	const endsWithNewline = normalized.sub(-1) === "\n";
	const lines = normalized.split("\n");

	// split() includes a final empty field for a trailing newline. Keep the
	// existing splitLines contract, which tracks that newline separately.
	if (endsWithNewline && lines[lines.size() - 1] === "") {
		lines.pop();
	}

	if (lines.size() === 0) {
		lines.push("");
	}

	return [lines, endsWithNewline] as unknown as LuaTuple<[string[], boolean]>;
}

function joinLines(lines: string[], hadTrailingNewline: boolean): string {
	let source = lines.join("\n");
	if (hadTrailingNewline && source.sub(-1) !== "\n") {
		source += "\n";
	}
	return source;
}

function readScriptSource(instance: LuaSourceContainer): string {
	const [editorOk, editorSource] = pcall(() => ScriptEditorService.GetEditorSource(instance));
	if (editorOk) return editorSource;

	const [documentOk, documentSource] = pcall(() => {
		const doc = ScriptEditorService.FindScriptDocument(instance);
		if (doc) return doc.GetText();
		return undefined;
	});
	if (documentOk && documentSource !== undefined) {
		return documentSource;
	}
	// @rbxts/types does not expose PluginSecurity Source reads.
	const readableScript = instance as unknown as { Source: string };
	return readableScript.Source;
}

interface ApplyScriptSourceResult {
	success: boolean;
	method: "UpdateSourceAsync" | "direct";
	error?: string;
}

/**
 * Writes newSource to instance and verifies the live editor text before
 * reporting success. expectedSource turns line-based edits into a
 * compare-and-set operation: if the document changes while
 * UpdateSourceAsync yields or before the direct fallback runs, the write is
 * rejected instead of overwriting the newer draft.
 */
function applyScriptSource(
	instance: LuaSourceContainer,
	newSource: string,
	expectedSource?: string,
): ApplyScriptSourceResult {
	const [updateSuccess, updateResult] = pcall(() => {
		ScriptEditorService.UpdateSourceAsync(instance, (currentSource: string) => {
			if (expectedSource !== undefined && currentSource !== expectedSource) {
				error("Script source changed while the edit was being applied; read the script again and retry");
			}
			return newSource;
		});
		if (readScriptSource(instance) !== newSource) {
			error("UpdateSourceAsync completed without updating the live script source");
		}
	});
	if (updateSuccess) {
		return { success: true, method: "UpdateSourceAsync" };
	}

	const [directSuccess, directResult] = pcall(() => {
		if (expectedSource !== undefined && readScriptSource(instance) !== expectedSource) {
			error("Script source changed before direct assignment; read the script again and retry");
		}
		// @rbxts/types does not expose PluginSecurity Source writes.
		const writableScript = instance as unknown as { Source: string };
		writableScript.Source = newSource;
		if (readScriptSource(instance) !== newSource) {
			error("Direct assignment completed without updating the live script source");
		}
	});
	if (directSuccess) {
		return { success: true, method: "direct" };
	}

	return {
		success: false,
		method: "direct",
		error: `UpdateSourceAsync failed: ${updateResult}. Direct assignment failed: ${directResult}`,
	};
}

function convertPropertyValue(instance: Instance, propertyName: string, propertyValue: unknown): unknown {
	if (propertyValue === undefined) return undefined;

	const inst = instance as unknown as Record<string, unknown>;

	if (typeIs(propertyValue, "table")) {
		const arr = propertyValue as unknown[];
		const tbl = propertyValue as Record<string, unknown>;

		if (typeIs(arr, "table") && (arr as defined[]).size() > 0) {
			const len = (arr as defined[]).size();

			if (len === 3) {
				const prop = propertyName.lower();
				if (
					prop === "position" || prop === "size" || prop === "orientation" ||
					prop === "velocity" || prop === "angularvelocity"
				) {
					return new Vector3(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
					);
				} else if (prop === "color" || prop === "color3") {
					return new Color3(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
					);
				} else {
					const [success, currentVal] = pcall(() => inst[propertyName]);
					if (success) {
						if (typeOf(currentVal) === "Vector3") {
							return new Vector3(
								(arr[0] as number) ?? 0,
								(arr[1] as number) ?? 0,
								(arr[2] as number) ?? 0,
							);
						} else if (typeOf(currentVal) === "Color3") {
							return new Color3(
								(arr[0] as number) ?? 0,
								(arr[1] as number) ?? 0,
								(arr[2] as number) ?? 0,
							);
						}
					}
				}
			} else if (len === 2) {
				const [success, currentVal] = pcall(() => inst[propertyName]);
				if (success && typeOf(currentVal) === "Vector2") {
					return new Vector2((arr[0] as number) ?? 0, (arr[1] as number) ?? 0);
				}
			} else if (len === 4) {
				const [success, currentVal] = pcall(() => inst[propertyName]);
				if (success && typeOf(currentVal) === "UDim2") {
					return new UDim2(
						(arr[0] as number) ?? 0,
						(arr[1] as number) ?? 0,
						(arr[2] as number) ?? 0,
						(arr[3] as number) ?? 0,
					);
				}
			}
		}

		if (tbl.X !== undefined || tbl.Y !== undefined || tbl.Z !== undefined) {

			if (typeIs(tbl.X, "table") && typeIs(tbl.Y, "table")) {
				const xTbl = tbl.X as unknown as Record<string, number>;
				const yTbl = tbl.Y as unknown as Record<string, number>;
				return new UDim2(
					xTbl.Scale ?? 0, xTbl.Offset ?? 0,
					yTbl.Scale ?? 0, yTbl.Offset ?? 0,
				);
			}
			const [success, currentVal] = pcall(() => inst[propertyName]);
			if (success) {
				const currentType = typeOf(currentVal);
				if (currentType === "Vector2") {
					return new Vector2(
						(tbl.X as number) ?? 0,
						(tbl.Y as number) ?? 0,
					);
				}
				if (currentType === "Vector3") {
					return new Vector3(
						(tbl.X as number) ?? 0,
						(tbl.Y as number) ?? 0,
						(tbl.Z as number) ?? 0,
					);
				}
			}
			return new Vector3(
				(tbl.X as number) ?? 0,
				(tbl.Y as number) ?? 0,
				(tbl.Z as number) ?? 0,
			);
		}

		if (tbl.R !== undefined || tbl.G !== undefined || tbl.B !== undefined) {
			return new Color3(
				(tbl.R as number) ?? 0,
				(tbl.G as number) ?? 0,
				(tbl.B as number) ?? 0,
			);
		}
	}

	if (typeIs(propertyValue, "string")) {
		const [success, currentVal] = pcall(() => inst[propertyName]);
		if (success && typeOf(currentVal) === "EnumItem") {
			const enumItem = currentVal as EnumItem;
			const enumTypeName = tostring(enumItem.EnumType);
			const [enumSuccess, enumVal] = pcall(() => {
				return (Enum as unknown as Record<string, Record<string, EnumItem>>)[enumTypeName][propertyValue];
			});
			if (enumSuccess && enumVal) return enumVal;
		}
		if (propertyName === "BrickColor") {
			return new BrickColor(propertyValue as unknown as number);
		}
		if (propertyValue === "true") return true;
		if (propertyValue === "false") return false;
	}

	return propertyValue;
}

function evaluateFormula(
	formula: string,
	variables: Record<string, unknown> | undefined,
	instance: Instance | undefined,
	index: number,
): LuaTuple<[number, string | undefined]> {
	let value = formula;

	value = value.gsub("index", tostring(index))[0];

	if (instance && instance.IsA("BasePart")) {
		const pos = instance.Position;
		const sz = instance.Size;
		value = value.gsub("Position%.X", tostring(pos.X))[0];
		value = value.gsub("Position%.Y", tostring(pos.Y))[0];
		value = value.gsub("Position%.Z", tostring(pos.Z))[0];
		value = value.gsub("Size%.X", tostring(sz.X))[0];
		value = value.gsub("Size%.Y", tostring(sz.Y))[0];
		value = value.gsub("Size%.Z", tostring(sz.Z))[0];
		value = value.gsub("magnitude", tostring(pos.Magnitude))[0];
	}

	if (variables) {
		for (const [k, v] of pairs(variables)) {
			value = value.gsub(k as string, tostring(v))[0];
		}
	}

	value = value.gsub("sin%(([%d%.%-]+)%)", (x: string) => tostring(math.sin(tonumber(x) ?? 0)))[0];
	value = value.gsub("cos%(([%d%.%-]+)%)", (x: string) => tostring(math.cos(tonumber(x) ?? 0)))[0];
	value = value.gsub("sqrt%(([%d%.%-]+)%)", (x: string) => tostring(math.sqrt(tonumber(x) ?? 0)))[0];
	value = value.gsub("abs%(([%d%.%-]+)%)", (x: string) => tostring(math.abs(tonumber(x) ?? 0)))[0];
	value = value.gsub("floor%(([%d%.%-]+)%)", (x: string) => tostring(math.floor(tonumber(x) ?? 0)))[0];
	value = value.gsub("ceil%(([%d%.%-]+)%)", (x: string) => tostring(math.ceil(tonumber(x) ?? 0)))[0];

	const directResult = tonumber(value);
	if (directResult !== undefined) {
		return [directResult, undefined] as unknown as LuaTuple<[number, string | undefined]>;
	}

	const [success, evalResult] = pcall(() => {
		const num = tonumber(value);
		if (num !== undefined) return num;

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%*%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) * (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%+%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) + (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*%-%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) return (tonumber(a) ?? 0) - (tonumber(b) ?? 0);
		}

		{
			const [a, b] = value.match("^([%d%.%-]+)%s*/%s*([%d%.%-]+)$") as LuaTuple<[string?, string?]>;
			if (a && b) {
				const divisor = tonumber(b) ?? 1;
				if (divisor !== 0) return (tonumber(a) ?? 0) / divisor;
			}
		}

		error(`Unsupported formula pattern: ${value}`);
	});

	if (success && typeIs(evalResult, "number")) {
		return [evalResult, undefined] as unknown as LuaTuple<[number, string | undefined]>;
	} else {
		return [index, "Complex formulas not supported - using index value"] as unknown as LuaTuple<[number, string | undefined]>;
	}
}

function compareVersions(v1: string, v2: string): number {
	function parseVersion(v: string): number[] {
		const parts: number[] = [];
		for (const [num] of string.gmatch(v, "%d+")) {
			parts.push(tonumber(num) ?? 0);
		}
		return parts;
	}

	const p1 = parseVersion(v1);
	const p2 = parseVersion(v2);
	const maxLen = math.max(p1.size(), p2.size());
	for (let i = 0; i < maxLen; i++) {
		const n1 = p1[i] ?? 0;
		const n2 = p2[i] ?? 0;
		if (n1 < n2) return -1;
		if (n1 > n2) return 1;
	}
	return 0;
}

export = {
	safeCall,
	getInstancePath,
	getInstanceByPath,
	splitLines,
	joinLines,
	readScriptSource,
	applyScriptSource,
	convertPropertyValue,
	evaluateFormula,
	compareVersions,
};

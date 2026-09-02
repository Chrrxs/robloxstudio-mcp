import Utils from "../Utils";
import PeerRole from "../PeerRole";

const { getInstanceByPath } = Utils;

const HttpService = game.GetService("HttpService");
const ServerStorage = game.GetService("ServerStorage");

const LOG_PREFIX = "Breakpoint";
const REGISTRY_KEY_PREFIX = "MCP_BREAKPOINTS_V1_";
const MCP_PLACE_ID_ATTRIBUTE = "__MCPPlaceId";

let pluginRef: Plugin | undefined;
let loadedRegistryKey: string | undefined;
let loadedRegistryFromSettings = false;

interface ScriptBreakpointSpec {
	Line: number;
	Enabled?: boolean;
	Condition?: string;
	LogMessage?: string;
	ContinueExecution?: boolean;
}

interface ScriptBreakpointResult {
	Verified?: boolean;
	Line?: number;
	Message?: string;
}

interface ScriptDebuggerServiceLike extends Instance {
	AddBreakpoint(this: ScriptDebuggerServiceLike, script: Instance, breakpoint: ScriptBreakpointSpec): ScriptBreakpointResult;
	RemoveBreakpoint(this: ScriptDebuggerServiceLike, script: Instance, line: number): boolean;
	ClearBreakpoints(this: ScriptDebuggerServiceLike): void;
}

interface BreakpointEntry {
	script_path: string;
	line: number;
	requested_line?: number;
	enabled?: boolean;
	condition?: string;
	log_message?: string;
	continue_execution?: boolean;
	verified?: false;
	message?: string;
	created_at?: number;
}

interface PersistedBreakpointEntry {
	script_path: string;
	line: number;
}

interface RegistryScope {
	key: string;
}

const breakpoints = new Map<string, BreakpointEntry>();

function init(p: Plugin): void {
	pluginRef = p;
}

function breakpointKey(scriptPath: string, line: number): string {
	return `${scriptPath}:${line}`;
}

function computePlaceKey(): string {
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	const existing = ServerStorage.GetAttribute(MCP_PLACE_ID_ATTRIBUTE);
	if (typeIs(existing, "string") && existing !== "") {
		return `anon:${existing}`;
	}
	const fresh = HttpService.GenerateGUID(false);
	pcall(() => ServerStorage.SetAttribute(MCP_PLACE_ID_ATTRIBUTE, fresh));
	return `anon:${fresh}`;
}

function detectRole(): string {
	return PeerRole.detect();
}

function requestedRole(requestData: Record<string, unknown>): string {
	return typeIs(requestData.__mcp_target_role, "string") && requestData.__mcp_target_role !== ""
		? requestData.__mcp_target_role as string
		: detectRole();
}

function registryScope(requestData: Record<string, unknown>): RegistryScope {
	const placeKey = computePlaceKey();
	const role = requestedRole(requestData);
	return {
		key: `${REGISTRY_KEY_PREFIX}${placeKey}:${role}`,
	};
}

function readSetting(key: string): unknown {
	if (!pluginRef) return undefined;
	const [ok, value] = pcall(() => pluginRef!.GetSetting(key));
	return ok ? value : undefined;
}

function writeSetting(key: string, value: unknown): boolean {
	if (!pluginRef) return false;
	const [ok] = pcall(() => pluginRef!.SetSetting(key, value));
	return ok;
}

function decodePersistedBreakpointEntry(value: unknown): BreakpointEntry | undefined {
	if (!typeIs(value, "table")) return undefined;
	const data = value as Record<string, unknown>;
	if (!typeIs(data.script_path, "string") || data.script_path === "") return undefined;
	if (!typeIs(data.line, "number") || data.line < 1) return undefined;

	return {
		script_path: data.script_path as string,
		line: math.floor(data.line as number),
	};
}

function loadRegistry(requestData: Record<string, unknown>): RegistryScope {
	const scope = registryScope(requestData);
	if (loadedRegistryKey !== scope.key) {
		breakpoints.clear();
		loadedRegistryKey = scope.key;
		loadedRegistryFromSettings = false;
	}

	if (loadedRegistryFromSettings) return scope;
	loadedRegistryFromSettings = true;

	const stored = readSetting(scope.key);
	if (stored === undefined) return scope;

	let decoded: unknown = stored;
	if (typeIs(stored, "string")) {
		const [ok, result] = pcall(() => HttpService.JSONDecode(stored as string));
		if (!ok) return scope;
		decoded = result;
	}
	if (!typeIs(decoded, "table")) return scope;

	breakpoints.clear();
	for (const item of decoded as unknown[]) {
		const entry = decodePersistedBreakpointEntry(item);
		if (entry) {
			breakpoints.set(breakpointKey(entry.script_path, entry.line), entry);
		}
	}
	return scope;
}

interface PersistResult {
	ok: boolean;
	error?: string;
}

function persistRegistry(scope: RegistryScope): PersistResult {
	if (!pluginRef) return { ok: false, error: "Plugin settings are unavailable; managed breakpoint registry is memory-only." };

	const out: PersistedBreakpointEntry[] = [];
	for (const [, entry] of breakpoints) {
		out.push({
			script_path: entry.script_path,
			line: entry.line,
		});
	}

	const [encodedOk, encoded] = pcall(() => HttpService.JSONEncode(out));
	if (!encodedOk || !typeIs(encoded, "string")) {
		return { ok: false, error: `Failed to encode managed breakpoint registry: ${tostring(encoded)}` };
	}
	if (!writeSetting(scope.key, encoded)) {
		return { ok: false, error: "Failed to persist managed breakpoint registry with plugin:SetSetting." };
	}
	const stored = readSetting(scope.key);
	if (stored !== encoded) {
		return { ok: false, error: "Failed to verify managed breakpoint registry persistence after plugin:SetSetting." };
	}
	return { ok: true };
}

function attachPersistenceWarning(response: Record<string, unknown>, persist: PersistResult): Record<string, unknown> {
	if (!persist.ok) {
		response.managed_registry_persisted = false;
		response.registry_error = persist.error;
	}
	return response;
}

function serviceError(message?: string): Record<string, unknown> {
	return {
		error: "script_debugger_unavailable",
		message: message ?? "ScriptDebuggerService is unavailable. Enable the Studio Debugger Luau API beta feature and restart Studio.",
		betaFeatureRequired: true,
	};
}

function operationError(errorCode: string, operation: string, raw: unknown): Record<string, unknown> {
	return {
		error: errorCode,
		message:
			`${operation} failed. The breakpoints tool requires the Studio Debugger Luau API beta feature. ` +
			"Enable it in Studio Beta Features and restart/reload Studio, then retry.",
		rawMessage: tostring(raw),
		betaFeatureRequired: true,
	};
}

function getService(): ScriptDebuggerServiceLike | Record<string, unknown> {
	const provider = game as unknown as { GetService(serviceName: string): Instance };
	const [ok, service] = pcall(() => provider.GetService("ScriptDebuggerService") as ScriptDebuggerServiceLike);
	if (!ok || !service) {
		return serviceError(`ScriptDebuggerService unavailable: ${tostring(service)}`);
	}
	return service;
}

function luauStringLiteral(value: string): string {
	let escaped = value.gsub("\\", "\\\\")[0];
	escaped = escaped.gsub("\n", "\\n")[0];
	escaped = escaped.gsub("\r", "\\r")[0];
	escaped = escaped.gsub("\t", "\\t")[0];
	escaped = escaped.gsub('"', '\\"')[0];
	return `"${escaped}"`;
}

function buildLogMessage(scriptPath: string, line: number, logMessage: string | undefined): string {
	const prefix = [
		luauStringLiteral(LOG_PREFIX),
		luauStringLiteral(`${scriptPath}:${line}`),
	];
	if (typeIs(logMessage, "string") && logMessage !== "") {
		prefix.push(logMessage);
	}
	return prefix.join(", ");
}

function listBreakpoints(requestData: Record<string, unknown>): Record<string, unknown> {
	loadRegistry(requestData);
	const out: BreakpointEntry[] = [];
	for (const [, entry] of breakpoints) {
		out.push(entry);
	}
	return {
		breakpoints: out,
		count: out.size(),
	};
}

function setBreakpoint(requestData: Record<string, unknown>): unknown {
	const scope = loadRegistry(requestData);
	const serviceOrError = getService();
	if (!serviceOrError.IsA) return serviceOrError;
	const service = serviceOrError as ScriptDebuggerServiceLike;

	const scriptPath = requestData.script_path as string | undefined;
	const lineRaw = requestData.line as number | undefined;
	if (!typeIs(scriptPath, "string") || scriptPath === "" || !typeIs(lineRaw, "number")) {
		return { error: "invalid_args", message: "breakpoints action=set requires script_path and line" };
	}

	const requestedLine = math.floor(lineRaw);
	if (requestedLine < 1) {
		return { error: "invalid_line", message: "line must be a 1-based positive number" };
	}

	const instance = getInstanceByPath(scriptPath);
	if (!instance) return { error: "script_not_found", script_path: scriptPath };
	if (!instance.IsA("LuaSourceContainer")) {
		return {
			error: "not_a_script",
			message: `${scriptPath} is ${instance.ClassName}, not a LuaSourceContainer`,
			script_path: scriptPath,
		};
	}

	const rawLogMessage = typeIs(requestData.log_message, "string") ? requestData.log_message as string : undefined;
	const hasLogMessage = rawLogMessage !== undefined && rawLogMessage !== "";
	const continueExecution = typeIs(requestData.continue_execution, "boolean")
		? requestData.continue_execution as boolean
		: hasLogMessage;
	const enabled = typeIs(requestData.enabled, "boolean") ? requestData.enabled as boolean : true;
	const effectiveLogMessage = hasLogMessage || continueExecution ? buildLogMessage(scriptPath, requestedLine, rawLogMessage) : undefined;

	const spec: ScriptBreakpointSpec = {
		Line: requestedLine,
		Enabled: enabled,
		ContinueExecution: continueExecution,
	};
	if (typeIs(requestData.condition, "string") && requestData.condition !== "") {
		spec.Condition = requestData.condition as string;
	}
	if (effectiveLogMessage !== undefined) {
		spec.LogMessage = effectiveLogMessage;
	}

	const [ok, result] = pcall(() => service.AddBreakpoint(instance, spec));
	if (!ok) return operationError("add_breakpoint_failed", "ScriptDebuggerService:AddBreakpoint", result);

	const breakpointResult = result as ScriptBreakpointResult;
	const actualLine = typeIs(breakpointResult.Line, "number") ? breakpointResult.Line : requestedLine;
	const verified = typeIs(breakpointResult.Verified, "boolean") ? breakpointResult.Verified : undefined;
	const message = typeIs(breakpointResult.Message, "string") ? breakpointResult.Message : undefined;
	const entry: BreakpointEntry = {
		script_path: scriptPath,
		line: actualLine,
		requested_line: actualLine !== requestedLine ? requestedLine : undefined,
		enabled,
		condition: spec.Condition,
		log_message: rawLogMessage,
		continue_execution: continueExecution,
		verified: verified === false ? false : undefined,
		message,
		created_at: DateTime.now().UnixTimestampMillis,
	};

	breakpoints.set(breakpointKey(scriptPath, actualLine), entry);
	return attachPersistenceWarning({
		ok: true,
		breakpoint: entry,
	}, persistRegistry(scope));
}

function removeBreakpoint(requestData: Record<string, unknown>): unknown {
	const scope = loadRegistry(requestData);
	const serviceOrError = getService();
	if (!serviceOrError.IsA) return serviceOrError;
	const service = serviceOrError as ScriptDebuggerServiceLike;

	const scriptPath = requestData.script_path as string | undefined;
	const lineRaw = requestData.line as number | undefined;
	if (!typeIs(scriptPath, "string") || scriptPath === "" || !typeIs(lineRaw, "number")) {
		return { error: "invalid_args", message: "breakpoints action=remove requires script_path and line" };
	}
	const line = math.floor(lineRaw);
	if (line < 1) {
		return { error: "invalid_line", message: "line must be a 1-based positive number" };
	}

	const instance = getInstanceByPath(scriptPath);
	if (!instance) return { error: "script_not_found", script_path: scriptPath };
	if (!instance.IsA("LuaSourceContainer")) {
		return {
			error: "not_a_script",
			message: `${scriptPath} is ${instance.ClassName}, not a LuaSourceContainer`,
			script_path: scriptPath,
		};
	}

	const [ok, removed] = pcall(() => service.RemoveBreakpoint(instance, line));
	if (!ok) return operationError("remove_breakpoint_failed", "ScriptDebuggerService:RemoveBreakpoint", removed);

	breakpoints.delete(breakpointKey(scriptPath, line));
	return attachPersistenceWarning({
		ok: true,
		removed,
		script_path: scriptPath,
		line,
	}, persistRegistry(scope));
}

function clearManagedBreakpoints(requestData: Record<string, unknown>): unknown {
	const scope = loadRegistry(requestData);
	const serviceOrError = getService();
	if (!serviceOrError.IsA) return serviceOrError;
	const service = serviceOrError as ScriptDebuggerServiceLike;

	let cleared = 0;
	const errors: Record<string, unknown>[] = [];

	for (const [key, entry] of breakpoints) {
		const instance = getInstanceByPath(entry.script_path);
		if (!instance || !instance.IsA("LuaSourceContainer")) {
			breakpoints.delete(key);
			cleared += 1;
			continue;
		}

		const [ok, removedOrError] = pcall(() => service.RemoveBreakpoint(instance, entry.line));
		if (ok) {
			breakpoints.delete(key);
			cleared += 1;
		} else {
			errors.push({
				script_path: entry.script_path,
				line: entry.line,
				error: tostring(removedOrError),
			});
		}
	}

	if (errors.size() > 0) {
		return {
			ok: false,
			cleared,
			errors,
		};
	}

	return attachPersistenceWarning({
		ok: true,
		cleared,
	}, persistRegistry(scope));
}

function clearAllBreakpoints(requestData: Record<string, unknown>): unknown {
	const scope = loadRegistry(requestData);
	const serviceOrError = getService();
	if (!serviceOrError.IsA) return serviceOrError;
	const service = serviceOrError as ScriptDebuggerServiceLike;

	const managedCount = breakpoints.size();
	const [ok, err] = pcall(() => service.ClearBreakpoints());
	if (!ok) return operationError("clear_breakpoints_failed", "ScriptDebuggerService:ClearBreakpoints", err);
	breakpoints.clear();
	return attachPersistenceWarning({
		ok: true,
		cleared_managed: managedCount,
	}, persistRegistry(scope));
}

function clearBreakpoints(requestData: Record<string, unknown>): unknown {
	if (requestData.clear_all === true) {
		return clearAllBreakpoints(requestData);
	}
	return clearManagedBreakpoints(requestData);
}

function breakpointsTool(requestData: Record<string, unknown>): unknown {
	const action = requestData.action as string | undefined;
	if (!typeIs(action, "string") || action === "") {
		return { error: "invalid_args", message: "breakpoints requires action=set|remove|clear|list" };
	}

	switch (action) {
		case "set":
			return setBreakpoint(requestData);
		case "remove":
			return removeBreakpoint(requestData);
		case "clear":
			return clearBreakpoints(requestData);
		case "list":
			return listBreakpoints(requestData);
		default:
			return {
				error: "unknown_action",
				message: `breakpoints action must be one of: set, remove, clear, list (got ${action})`,
			};
	}
}

export = { breakpoints: breakpointsTool, init };

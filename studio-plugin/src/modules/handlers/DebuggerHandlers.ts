import Utils from "../Utils";

const { getInstanceByPath } = Utils;

// Beta API typings (ScriptDebuggerService is not yet in @rbxts/types).
interface ScriptBreakpointSpec {
	Line: number;
	Condition?: string;
	LogMessage?: string;
	ContinueExecution?: boolean;
}

interface ScriptDebuggerServiceLike extends Instance {
	AddBreakpoint(this: ScriptDebuggerServiceLike, script: Instance, bp: ScriptBreakpointSpec): unknown;
	RemoveBreakpoint(this: ScriptDebuggerServiceLike, script: Instance, line: number): boolean;
	ClearBreakpoints(this: ScriptDebuggerServiceLike): void;
	SetExceptionBreakMode(this: ScriptDebuggerServiceLike, mode: unknown): void;
	Pause(this: ScriptDebuggerServiceLike): void;
	GetThreads(this: ScriptDebuggerServiceLike): unknown;
	GetStackTrace(this: ScriptDebuggerServiceLike, threadId: number, startFrame?: number): unknown;
	GetRootVariables(this: ScriptDebuggerServiceLike, frameId: number): unknown;
	GetVariables(this: ScriptDebuggerServiceLike, variablesReference: number): unknown;
	Evaluate(this: ScriptDebuggerServiceLike, expression: string, frameId?: number): unknown;
	OnStopped: (stopped: Record<string, unknown>) => unknown;
	Resumed: RBXScriptSignal;
}

interface BreakpointEntry {
	scriptPath: string;
	line: number;
	condition?: string;
	logMessage?: string;
	continueExecution?: boolean;
}

interface CurrentStop {
	reason: string;
	exceptionText?: string;
	threadIds: number[];
	scriptPath?: string;
	line?: number;
	receivedAt: number;
}

// Module-level state - the debug session is inherently stateful.
// Breakpoints persist across requests; currentStop holds the parked OnStopped.
const breakpoints = new Map<string, BreakpointEntry>();
let currentStop: CurrentStop | undefined;
let resumeActionPending: unknown | undefined;
let stopSignal: BindableEvent | undefined;
let resumeSignal: BindableEvent | undefined;
let serviceCached: ScriptDebuggerServiceLike | undefined;
let serviceUnavailableReason: string | undefined;
let onStoppedInstalled = false;

function bpKey(scriptPath: string, line: number): string {
	return `${scriptPath}:${line}`;
}

function ensureSignals(): void {
	if (!stopSignal) {
		stopSignal = new Instance("BindableEvent");
	}
	if (!resumeSignal) {
		resumeSignal = new Instance("BindableEvent");
	}
}

function getService(): ScriptDebuggerServiceLike | undefined {
	if (serviceCached) return serviceCached;
	if (serviceUnavailableReason !== undefined) return undefined;
	const provider = game as unknown as { GetService(serviceName: string): Instance };
	const [ok, service] = pcall(() => provider.GetService("ScriptDebuggerService") as ScriptDebuggerServiceLike);
	if (!ok || !service) {
		serviceUnavailableReason = `ScriptDebuggerService unavailable: ${tostring(service)}`;
		return undefined;
	}
	serviceCached = service;
	return service;
}

function serviceError(): Record<string, unknown> {
	return {
		error: "script_debugger_unavailable",
		message:
			serviceUnavailableReason ??
			"ScriptDebuggerService is not available. Enable the Studio Debugger Luau API beta feature and restart Studio.",
		betaFeatureRequired: true,
	};
}

function resolveResumeEnum(action: string): unknown | undefined {
	const e = (Enum as unknown as Record<string, Record<string, unknown> | undefined>).DebuggerResumeType;
	if (!e) return undefined;
	const mapping: Record<string, string> = {
		continue: "Resume",
		resume: "Resume",
		step_in: "StepInto",
		step_into: "StepInto",
		step_over: "StepOver",
		step_out: "StepOut",
	};
	const enumName = mapping[action.lower()];
	if (!enumName) return undefined;
	return e[enumName];
}

function resolveExceptionMode(mode: string): unknown | undefined {
	const e = (Enum as unknown as Record<string, Record<string, unknown> | undefined>).DebugBreakModeType;
	if (!e) return undefined;
	const mapping: Record<string, string> = {
		never: "Never",
		none: "Never",
		always: "Always",
		all: "Always",
		unhandled: "Unhandled",
	};
	const enumName = mapping[mode.lower()];
	if (!enumName) return undefined;
	return e[enumName];
}

function installOnStopped(service: ScriptDebuggerServiceLike): void {
	if (onStoppedInstalled) return;
	ensureSignals();
	const [ok, err] = pcall(() => {
		service.OnStopped = (stopped: Record<string, unknown>) => {
			const reasonEnum = stopped.Reason as { Name?: string } | undefined;
			const reasonName = reasonEnum && typeIs(reasonEnum, "userdata") ? tostring(reasonEnum) : tostring(reasonEnum);
			const threadIdsRaw = stopped.ThreadIds as number[] | undefined;
			const threadIds: number[] = [];
			if (threadIdsRaw) {
				for (const tid of threadIdsRaw) threadIds.push(tid);
			}
			currentStop = {
				reason: reasonName,
				exceptionText: stopped.ExceptionText as string | undefined,
				threadIds,
				receivedAt: tick(),
			};
			resumeActionPending = undefined;
			if (stopSignal) stopSignal.Fire();
			// Park here until a debug_control resume action arrives.
			if (resumeSignal) resumeSignal.Event.Wait();
			const action = resumeActionPending;
			currentStop = undefined;
			resumeActionPending = undefined;
			// Default to Resume if no action set (shouldn't happen).
			if (action === undefined) {
				const fallback = resolveResumeEnum("resume");
				return fallback as unknown;
			}
			return action;
		};
	});
	if (ok) {
		onStoppedInstalled = true;
	} else {
		warn(`[robloxstudio-mcp] failed to install ScriptDebuggerService.OnStopped: ${tostring(err)}`);
	}
}

function ensureReady(): ScriptDebuggerServiceLike | undefined {
	const service = getService();
	if (!service) return undefined;
	installOnStopped(service);
	return service;
}

function setBreakpoint(data: Record<string, unknown>): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const scriptPath = data.script_path as string | undefined;
	const line = data.line as number | undefined;
	if (!scriptPath || !typeIs(line, "number")) {
		return { error: "invalid_args", message: "script_path and line are required" };
	}
	const instance = getInstanceByPath(scriptPath);
	if (!instance) return { error: "script_not_found", scriptPath };
	if (!instance.IsA("LuaSourceContainer")) {
		return { error: "not_a_script", message: `${scriptPath} is ${instance.ClassName}, not a LuaSourceContainer` };
	}
	const bp: ScriptBreakpointSpec = { Line: math.floor(line) };
	if (typeIs(data.condition, "string")) bp.Condition = data.condition as string;
	if (typeIs(data.log_message, "string")) bp.LogMessage = data.log_message as string;
	if (typeIs(data.continue_execution, "boolean")) bp.ContinueExecution = data.continue_execution as boolean;
	const [ok, result] = pcall(() => service.AddBreakpoint(instance, bp));
	if (!ok) return { error: "add_breakpoint_failed", message: tostring(result) };
	const entry: BreakpointEntry = {
		scriptPath,
		line: bp.Line,
		condition: bp.Condition,
		logMessage: bp.LogMessage,
		continueExecution: bp.ContinueExecution,
	};
	breakpoints.set(bpKey(scriptPath, bp.Line), entry);
	return { ok: true, breakpoint: entry, raw: result };
}

function removeBreakpoint(data: Record<string, unknown>): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const scriptPath = data.script_path as string | undefined;
	const line = data.line as number | undefined;
	if (!scriptPath || !typeIs(line, "number")) {
		return { error: "invalid_args", message: "script_path and line are required" };
	}
	const instance = getInstanceByPath(scriptPath);
	if (!instance) return { error: "script_not_found", scriptPath };
	const [ok, result] = pcall(() => service.RemoveBreakpoint(instance, math.floor(line)));
	if (!ok) return { error: "remove_breakpoint_failed", message: tostring(result) };
	breakpoints.delete(bpKey(scriptPath, math.floor(line)));
	return { ok: true, removed: result };
}

function clearBreakpoints(): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const [ok, err] = pcall(() => service.ClearBreakpoints());
	if (!ok) return { error: "clear_breakpoints_failed", message: tostring(err) };
	breakpoints.clear();
	return { ok: true };
}

function listBreakpoints(): unknown {
	const out: BreakpointEntry[] = [];
	for (const [, entry] of breakpoints) out.push(entry);
	return { breakpoints: out, count: out.size() };
}

function setExceptionMode(data: Record<string, unknown>): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const mode = data.mode as string | undefined;
	if (!mode) return { error: "invalid_args", message: "mode is required (never|always|unhandled)" };
	const enumVal = resolveExceptionMode(mode);
	if (enumVal === undefined) {
		return { error: "invalid_mode", message: `mode must be one of: never, always, unhandled (got ${mode})` };
	}
	const [ok, err] = pcall(() => service.SetExceptionBreakMode(enumVal));
	if (!ok) return { error: "set_exception_mode_failed", message: tostring(err) };
	return { ok: true, mode };
}

function pauseExecution(): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const [ok, err] = pcall(() => service.Pause());
	if (!ok) return { error: "pause_failed", message: tostring(err) };
	return { ok: true };
}

function resumeExecution(data: Record<string, unknown>): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	if (!currentStop) {
		return { error: "not_paused", message: "Debugger is not currently paused." };
	}
	const action = (data.action as string | undefined) ?? "continue";
	const enumVal = resolveResumeEnum(action);
	if (enumVal === undefined) {
		return {
			error: "invalid_action",
			message: `action must be one of: continue, step_in, step_over, step_out (got ${action})`,
		};
	}
	resumeActionPending = enumVal;
	if (resumeSignal) resumeSignal.Fire();
	return { ok: true, action };
}

function statusSnapshot(): Record<string, unknown> {
	if (!currentStop) {
		return { paused: false };
	}
	return {
		paused: true,
		reason: currentStop.reason,
		exceptionText: currentStop.exceptionText,
		threadIds: currentStop.threadIds,
		scriptPath: currentStop.scriptPath,
		line: currentStop.line,
		stoppedSinceMs: math.floor((tick() - currentStop.receivedAt) * 1000),
	};
}

function waitForStop(data: Record<string, unknown>): unknown {
	ensureReady();
	if (currentStop) return statusSnapshot();
	// Studio's HTTP poll loop runs each request on its own task; we can yield
	// here freely. Cap at 50s so we stay well under any Studio-side request
	// bound. Caller re-polls if it needs to wait longer.
	const timeoutMs = typeIs(data.timeout_ms, "number") ? (data.timeout_ms as number) : 10000;
	const timeoutSec = math.max(0.05, math.min(timeoutMs / 1000, 50));
	const start = tick();
	const deadline = start + timeoutSec;
	while (!currentStop && tick() < deadline) {
		task.wait(0.05);
	}
	const elapsed = math.floor((tick() - start) * 1000);
	const snap = statusSnapshot();
	snap.waited_ms = elapsed;
	return snap;
}

function getThreads(): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const [ok, result] = pcall(() => service.GetThreads());
	if (!ok) return { error: "get_threads_failed", message: tostring(result) };
	return { threads: result };
}

function getStack(data: Record<string, unknown>): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const threadId = data.thread_id as number | undefined;
	if (!typeIs(threadId, "number")) {
		return { error: "invalid_args", message: "thread_id is required" };
	}
	const startFrame = typeIs(data.start_frame, "number") ? (data.start_frame as number) : undefined;
	const [ok, result] = pcall(() =>
		startFrame !== undefined ? service.GetStackTrace(threadId, startFrame) : service.GetStackTrace(threadId),
	);
	if (!ok) return { error: "get_stack_failed", message: tostring(result) };
	return { stack: result };
}

function getVariables(data: Record<string, unknown>): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const frameId = data.frame_id as number | undefined;
	const variablesReference = data.variables_reference as number | undefined;
	if (typeIs(frameId, "number")) {
		const [ok, result] = pcall(() => service.GetRootVariables(frameId));
		if (!ok) return { error: "get_root_variables_failed", message: tostring(result) };
		return { variables: result, scope: "root", frame_id: frameId };
	}
	if (typeIs(variablesReference, "number")) {
		const [ok, result] = pcall(() => service.GetVariables(variablesReference));
		if (!ok) return { error: "get_variables_failed", message: tostring(result) };
		return { variables: result, scope: "nested", variables_reference: variablesReference };
	}
	return { error: "invalid_args", message: "Provide frame_id (for root vars) or variables_reference (to drill in)" };
}

function evaluate(data: Record<string, unknown>): unknown {
	const service = ensureReady();
	if (!service) return serviceError();
	const expression = data.expression as string | undefined;
	if (!typeIs(expression, "string") || expression === "") {
		return { error: "invalid_args", message: "expression is required" };
	}
	const frameId = data.frame_id as number | undefined;
	const [ok, result] = pcall(() =>
		typeIs(frameId, "number") ? service.Evaluate(expression, frameId) : service.Evaluate(expression),
	);
	if (!ok) return { error: "evaluate_failed", message: tostring(result) };
	return { result };
}

function debugControl(requestData: Record<string, unknown>): unknown {
	const action = requestData.action as string | undefined;
	if (!action) return { error: "invalid_args", message: "action is required" };
	const params = (requestData.params as Record<string, unknown> | undefined) ?? {};
	switch (action) {
		case "set_breakpoint":
			return setBreakpoint(params);
		case "remove_breakpoint":
			return removeBreakpoint(params);
		case "clear_breakpoints":
			return clearBreakpoints();
		case "set_exception_mode":
			return setExceptionMode(params);
		case "pause":
			return pauseExecution();
		case "resume":
			return resumeExecution(params);
		default:
			return {
				error: "unknown_action",
				message: `debug_control action must be one of: set_breakpoint, remove_breakpoint, clear_breakpoints, set_exception_mode, pause, resume (got ${action})`,
			};
	}
}

function debugInspect(requestData: Record<string, unknown>): unknown {
	const action = requestData.action as string | undefined;
	if (!action) return { error: "invalid_args", message: "action is required" };
	const params = (requestData.params as Record<string, unknown> | undefined) ?? {};
	switch (action) {
		case "status":
			ensureReady();
			return statusSnapshot();
		case "wait_for_stop":
			return waitForStop(params);
		case "list_breakpoints":
			return listBreakpoints();
		case "threads":
			return getThreads();
		case "stack":
			return getStack(params);
		case "variables":
			return getVariables(params);
		case "evaluate":
			return evaluate(params);
		default:
			return {
				error: "unknown_action",
				message: `debug_inspect action must be one of: status, wait_for_stop, list_breakpoints, threads, stack, variables, evaluate (got ${action})`,
			};
	}
}

export = { debugControl, debugInspect };

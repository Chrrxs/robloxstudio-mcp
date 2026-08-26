import { HttpService, Players, ReplicatedStorage, RunService } from "@rbxts/services";
import RuntimeLogBuffer from "./RuntimeLogBuffer";
import MemoryHandlers from "./handlers/MemoryHandlers";
import SceneAnalysisHandlers from "./handlers/SceneAnalysisHandlers";
import CaptureHandlers from "./handlers/CaptureHandlers";
import InputHandlers from "./handlers/InputHandlers";
import MetadataHandlers from "./handlers/MetadataHandlers";
import EvalRuntimeHandlers from "./handlers/EvalRuntimeHandlers";
import BreakpointHandlers from "./handlers/BreakpointHandlers";
import ScriptProfilerHandlers from "./handlers/ScriptProfilerHandlers";
import MicroProfilerHandlers from "./handlers/MicroProfilerHandlers";
import LuauExec from "./LuauExec";
import HttpDiagnostics from "./HttpDiagnostics";
import PluginSession from "./PluginSession";

interface StudioTestServiceMultiplayer extends StudioTestService {
	CanLeaveTest(): boolean;
	LeaveTest(): void;
	EditModeActive: boolean;
}

const StudioTestService = game.GetService("StudioTestService") as StudioTestServiceMultiplayer;


// The client peer cannot reach the MCP HTTP server - Roblox forbids
// HttpService:RequestAsync from the client DM even under PluginSecurity, and
// HttpEnabled reads as false there regardless of identity. So the server peer
// brokers client-targeted requests through a RemoteFunction it places
// in ReplicatedStorage; each player gets a logical proxy registration on the
// MCP side, multiplexed over the play-server peer's physical event stream.

const DEFAULT_MCP_URL = "http://localhost:58741";
let mcpUrl = DEFAULT_MCP_URL;
const BROKER_NAME = "__MCPClientBroker";
const BROKER_OWNER_ATTRIBUTE = "__MCPBrokerOwner";

interface ProxyEntry {
	player: Player;
	remote: RemoteFunction;
	pluginSessionId: string;
	role: string;
	registered: boolean;
	registering: boolean;
	retryAttempt: number;
	generation: number;
}

interface BrokerEnvelope {
	endpoint: string;
	data?: Record<string, unknown>;
}


// Endpoints the server-peer broker is allowed to forward to the client peer.
// Each requires the client peer's plugin VM (because the buffer / require
// cache / etc. lives there) so the server peer alone can't satisfy them.
const CLIENT_BROKER_ALLOWED_ENDPOINTS = new Set<string>([
	"/api/execute-luau",
	"/api/eval-runtime",
	"/api/get-runtime-logs",
	"/api/get-memory-breakdown",
	"/api/get-scene-analysis",
	"/api/breakpoints",
	"/api/capture-script-profiler",
	"/api/capture-micro-profiler",
	"/api/multiplayer-test-state",
	"/api/multiplayer-test-leave-client",
	// Screenshot capture must run in the client peer (CaptureService captures
	// the play viewport there); the edit DM reads the temp id back separately.
	"/api/capture-begin",
	// Virtual input (CreateVirtualInput) drives the running client's input
	// pipeline, so it must execute in the client peer's VM.
	"/api/simulate-mouse-input",
	"/api/simulate-keyboard-input",
	// Viewport framing must target the same live client captured by screenshots.
	"/api/focus-viewport",
]);


function forkRole(): "edit" | "server" | "client" {
	if (!RunService.IsRunning()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
}

function postJson(endpoint: string, body: Record<string, unknown>) {
	return pcall(() =>
		HttpService.RequestAsync({
			Url: `${mcpUrl}${endpoint}`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode(body),
		}),
	);
}

function formatPostJsonFailure(endpoint: string, ok: boolean, res: unknown): string {
	return HttpDiagnostics.formatRequestFailure(`${mcpUrl}${endpoint}`, ok, res);
}

function setServerUrl(serverUrl: string | undefined): void {
	if (serverUrl !== undefined && serverUrl !== "") {
		mcpUrl = serverUrl;
	}
}


function handleExecuteLuau(data: Record<string, unknown> | undefined) {
	const code = data && (data.code as string | undefined);
	if (typeIs(code, "string") === false || code === "") {
		return { success: false, error: "code is required" };
	}
	// Shared with edit/server (MetadataHandlers.executeLuau). Adds the IIFE
	// wrapper (so `print("hi")` with no return doesn't fail the
	// ModuleScript's "must return one value" rule) and JSON-encodes table
	// returns instead of yielding "table: 0xaddr".
	return LuauExec.execute(code as string);
}

function handleGetRuntimeLogs(data: Record<string, unknown> | undefined): unknown {
	const d = data ?? {};
	const since = d.since as number | undefined;
	const tail = d.tail as number | undefined;
	const filter = d.filter as string | undefined;
	// "client" is the generic capture tag; MCP-side aggregation overrides it
	// with the specific role (e.g. "client-1") for capturedBy.
	return RuntimeLogBuffer.query({ since, tail, filter }, "client");
}

function handleMultiplayerTestState(): unknown {
	const [argsOk, args] = pcall(() => StudioTestService.GetTestArgs());
	const [canLeaveOk, canLeave] = pcall(() => StudioTestService.CanLeaveTest());
	const players = Players.GetPlayers().map((player) => ({
		name: player.Name,
		userId: player.UserId,
		displayName: player.DisplayName,
	}));
	players.sort((a, b) => a.name < b.name);
	return {
		success: true,
		peer: "client",
		isRunning: RunService.IsRunning(),
		isRunMode: RunService.IsRunMode(),
		editModeActive: StudioTestService.EditModeActive,
		testArgsOk: argsOk,
		testArgs: argsOk ? args : undefined,
		testArgsError: argsOk ? undefined : tostring(args),
		players,
		playerCount: players.size(),
		localPlayer: Players.LocalPlayer ? Players.LocalPlayer.Name : undefined,
		canLeaveOk,
		canLeave: canLeaveOk ? canLeave : false,
		canLeaveError: canLeaveOk ? undefined : tostring(canLeave),
	};
}

function handleMultiplayerTestLeaveClient(): unknown {
	const [canLeaveOk, canLeave] = pcall(() => StudioTestService.CanLeaveTest());
	if (!canLeaveOk) {
		return { error: tostring(canLeave), canLeaveOk: false };
	}
	if (!canLeave) {
		return { error: "This client cannot leave the current test session.", canLeaveOk: true, canLeave: false };
	}
	const localPlayer = Players.LocalPlayer ? Players.LocalPlayer.Name : undefined;
	task.defer(() => {
		pcall(() => StudioTestService.LeaveTest());
	});
	return {
		success: true,
		message: "Client leave requested.",
		localPlayer,
	};
}

function setupClientBroker() {
	const rf = ReplicatedStorage.WaitForChild(BROKER_NAME, 10);
	if (!rf || !rf.IsA("RemoteFunction")) {
		warn(`[robloxstudio-mcp] client: ${BROKER_NAME} not found`);
		return;
	}
	rf.OnClientInvoke = (payload: BrokerEnvelope | undefined) => {
		if (!payload || !typeIs(payload.endpoint, "string")) {
			return { error: "Client broker request is missing its endpoint." };
		}
		if (payload && payload.endpoint === "/api/get-runtime-logs") {
			return handleGetRuntimeLogs(payload.data);
		}
		if (payload && payload.endpoint === "/api/get-memory-breakdown") {
			return MemoryHandlers.getMemoryBreakdown(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/get-scene-analysis") {
			return SceneAnalysisHandlers.getSceneAnalysis(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/breakpoints") {
			return BreakpointHandlers.breakpoints(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/capture-script-profiler") {
			return ScriptProfilerHandlers.captureScriptProfiler(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/capture-micro-profiler") {
			return MicroProfilerHandlers.captureMicroProfiler(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/multiplayer-test-state") {
			return handleMultiplayerTestState();
		}
		if (payload && payload.endpoint === "/api/multiplayer-test-leave-client") {
			return handleMultiplayerTestLeaveClient();
		}
		if (payload && payload.endpoint === "/api/capture-begin") {
			return CaptureHandlers.captureBegin();
		}
		if (payload && payload.endpoint === "/api/simulate-mouse-input") {
			return InputHandlers.simulateMouseInput(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/simulate-keyboard-input") {
			return InputHandlers.simulateKeyboardInput(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/focus-viewport") {
			return MetadataHandlers.focusViewport(payload.data ?? {});
		}
		if (payload && payload.endpoint === "/api/execute-luau") {
			return handleExecuteLuau(payload.data);
		}
		if (payload && payload.endpoint === "/api/eval-runtime") {
			return EvalRuntimeHandlers.evalRuntime(payload.data ?? {});
		}
		return { error: `Unsupported client broker endpoint: ${payload.endpoint}` };
	};
}

const INITIAL_PROXY_RETRY_DELAY_SECONDS = 0.5;
const MAX_PROXY_RETRY_DELAY_SECONDS = 5;
const proxyByPlayer = new Map<Player, ProxyEntry>();
const proxyBySessionId = new Map<string, ProxyEntry>();
const proxyRegisterFailuresByPlayer = new Set<Player>();
const pendingProxyDisconnects = new Set<string>();
let serverBrokerStarted = false;

function unregisterProxy(player: Player, entry?: ProxyEntry): void {
	const proxy = entry ?? proxyByPlayer.get(player);
	if (!proxy) return;
	proxy.generation++;
	proxyByPlayer.delete(player);
	proxyBySessionId.delete(proxy.pluginSessionId);
	proxyRegisterFailuresByPlayer.delete(player);
	queueProxyDisconnect(proxy.pluginSessionId);
}

function disconnectAllProxies(): void {
	for (const [player, entry] of proxyByPlayer) {
		unregisterProxy(player, entry);
	}
	proxyByPlayer.clear();
	proxyBySessionId.clear();
	proxyRegisterFailuresByPlayer.clear();
}

function proxyRetryDelay(attempt: number): number {
	return math.min(
		INITIAL_PROXY_RETRY_DELAY_SECONDS * math.pow(2, math.max(attempt - 1, 0)),
		MAX_PROXY_RETRY_DELAY_SECONDS,
	);
}
function deliverProxyDisconnect(pluginSessionId: string, attempt: number): void {
	if (!pendingProxyDisconnects.has(pluginSessionId)) return;
	const [ok, response] = postJson("/disconnect", { pluginSessionId });
	if (ok && response && response.Success) {
		pendingProxyDisconnects.delete(pluginSessionId);
		return;
	}
	task.delay(proxyRetryDelay(attempt + 1), () => {
		deliverProxyDisconnect(pluginSessionId, attempt + 1);
	});
}

function queueProxyDisconnect(pluginSessionId: string): void {
	if (pendingProxyDisconnects.has(pluginSessionId)) return;
	pendingProxyDisconnects.add(pluginSessionId);
	task.spawn(deliverProxyDisconnect, pluginSessionId, 0);
}


function parseAssignedRole(body: string): string | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(body));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const ready = decoded as Record<string, unknown>;
	if (ready.success !== true) return undefined;
	return typeIs(ready.assignedRole, "string") && ready.assignedRole !== ""
		? ready.assignedRole
		: undefined;
}

function scheduleProxyRetry(entry: ProxyEntry): void {
	entry.retryAttempt++;
	const expectedGeneration = entry.generation;
	task.delay(proxyRetryDelay(entry.retryAttempt), () => {
		if (
			proxyByPlayer.get(entry.player) !== entry ||
			entry.generation !== expectedGeneration ||
			entry.registered ||
			entry.registering ||
			entry.player.Parent === undefined ||
			!RunService.IsRunning()
		) {
			return;
		}
		registerProxyEntry(entry);
	});
}

function failProxyRegistration(entry: ProxyEntry, detail: string): void {
	entry.registered = false;
	if (!proxyRegisterFailuresByPlayer.has(entry.player)) {
		proxyRegisterFailuresByPlayer.add(entry.player);
		warn(`[robloxstudio-mcp] proxy register failed for ${entry.player.Name}: ${detail}`);
	}
	scheduleProxyRetry(entry);
}

function registerProxyEntry(entry: ProxyEntry): void {
	if (
		entry.registering ||
		proxyByPlayer.get(entry.player) !== entry ||
		entry.player.Parent === undefined ||
		!RunService.IsRunning()
	) {
		return;
	}
	entry.registering = true;
	const expectedGeneration = entry.generation;
	const requestedRole = entry.role === "client" ? "client" : entry.role;
	const readyPayload = PluginSession.createReadyPayload(entry.pluginSessionId, requestedRole);
	if (proxyByPlayer.get(entry.player) !== entry) return;
	if (entry.generation !== expectedGeneration) {
		if (!entry.registering) task.spawn(registerProxyEntry, entry);
		return;
	}
	const [ok, res] = postJson("/ready", readyPayload);
	if (proxyByPlayer.get(entry.player) !== entry) {
		if (ok && res && res.Success) {
			queueProxyDisconnect(entry.pluginSessionId);
		}
		return;
	}
	if (entry.generation !== expectedGeneration) {
		if (!entry.registering) task.spawn(registerProxyEntry, entry);
		return;
	}
	entry.registering = false;

	if (!ok || !res || !res.Success) {
		failProxyRegistration(entry, formatPostJsonFailure("/ready", ok, res));
		return;
	}
	const assignedRole = parseAssignedRole(res.Body);
	if (assignedRole === undefined) {
		failProxyRegistration(entry, "invalid /ready response: expected success=true and a non-empty assignedRole");
		return;
	}
	entry.role = assignedRole;
	entry.registered = true;
	entry.retryAttempt = 0;
	if (proxyRegisterFailuresByPlayer.has(entry.player)) {
		proxyRegisterFailuresByPlayer.delete(entry.player);
		print(`[robloxstudio-mcp] proxy registered for ${entry.player.Name} as ${assignedRole} via ${mcpUrl}`);
	}
}

function registerProxy(player: Player, rf: RemoteFunction): void {
	if (proxyByPlayer.has(player)) return;
	const entry: ProxyEntry = {
		player,
		remote: rf,
		pluginSessionId: HttpService.GenerateGUID(false),
		role: "client",
		registered: false,
		registering: false,
		retryAttempt: 0,
		generation: 0,
	};
	proxyByPlayer.set(player, entry);
	proxyBySessionId.set(entry.pluginSessionId, entry);
	task.spawn(registerProxyEntry, entry);
}

function refreshAllLogicalRegistrations(): void {
	for (const [, entry] of proxyByPlayer) {
		entry.generation++;
		entry.registered = false;
		entry.registering = false;
		entry.retryAttempt = 0;
		task.spawn(registerProxyEntry, entry);
	}
}

function dispatchClientRequest(
	logicalSessionId: string,
	target: string,
	endpoint: string,
	data?: Record<string, unknown>,
): unknown {
	const entry = proxyBySessionId.get(logicalSessionId);
	if (!entry || proxyByPlayer.get(entry.player) !== entry) {
		return { error: `Client proxy ${target} (${logicalSessionId}) is not registered.` };
	}
	if (entry.role === "client") {
		const [assignedClientRole] = target.match("^client%-%d+$");
		if (assignedClientRole !== undefined) entry.role = target;
	}
	if (entry.role !== target) {
		return {
			error: `Client proxy ${logicalSessionId} is registered as ${entry.role}, not ${target}.`,
		};
	}
	if (entry.player.Parent === undefined || !RunService.IsRunning()) {
		unregisterProxy(entry.player, entry);
		return { error: `Client proxy ${target} is no longer available.` };
	}
	if (!CLIENT_BROKER_ALLOWED_ENDPOINTS.has(endpoint)) {
		const allowed: string[] = [];
		for (const allowedEndpoint of CLIENT_BROKER_ALLOWED_ENDPOINTS) allowed.push(allowedEndpoint);
		return {
			error: `Client-proxy does not forward ${endpoint}. Allowed: ${allowed.join(", ")}.`,
		};
	}

	const envelope = { endpoint, data };
	const [invokeOk, invokeResult] = pcall(() => entry.remote.InvokeClient(entry.player, envelope));
	if (!invokeOk) {
		return { success: false, error: `InvokeClient failed: ${tostring(invokeResult)}` };
	}
	return invokeResult !== undefined ? invokeResult : { success: false, error: "nil response" };
}


function setupServerBroker() {
	if (serverBrokerStarted) return;
	let rf = ReplicatedStorage.FindFirstChild(BROKER_NAME) as RemoteFunction | undefined;
	if (!rf) {
		rf = new Instance("RemoteFunction");
		rf.Name = BROKER_NAME;
		rf.Parent = ReplicatedStorage;
	}
	if (rf.GetAttribute(BROKER_OWNER_ATTRIBUTE) !== undefined) {
		return;
	}
	rf.SetAttribute(BROKER_OWNER_ATTRIBUTE, HttpService.GenerateGUID(false));
	serverBrokerStarted = true;
	const broker = rf;
	Players.PlayerAdded.Connect((p) => registerProxy(p, broker));
	for (const p of Players.GetPlayers()) {
		task.spawn(registerProxy, p, broker);
	}
	Players.PlayerRemoving.Connect((p) => {
		unregisterProxy(p);
	});
	game.BindToClose(() => {
		disconnectAllProxies();
	});
}

export = {
	DEFAULT_MCP_URL,
	setServerUrl,
	disconnectAllProxies,
	refreshAllLogicalRegistrations,
	dispatchClientRequest,
	forkRole,
	setupClientBroker,
	setupServerBroker,
};

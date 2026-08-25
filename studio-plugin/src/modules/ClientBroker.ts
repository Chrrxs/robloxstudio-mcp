import { HttpService, Players, ReplicatedStorage, RunService, ServerStorage } from "@rbxts/services";
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
import State from "./State";
import HttpDiagnostics from "./HttpDiagnostics";

interface StudioTestServiceMultiplayer extends StudioTestService {
	CanLeaveTest(): boolean;
	LeaveTest(): void;
	EditModeActive: boolean;
}

const StudioTestService = game.GetService("StudioTestService") as StudioTestServiceMultiplayer;

// Mirror of Communication.computeInstanceId() — duplicated here because the
// client broker runs in the play-server DM where it can't easily import from
// the edit-side module, and the place identifier must match what the edit-DM
// plugin reports. Both use the same algorithm against the shared DataModel.
function computeInstanceId(): string {
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	const existing = ServerStorage.GetAttribute("__MCPPlaceId");
	if (typeIs(existing, "string") && existing !== "") {
		return `anon:${existing as string}`;
	}
	const fresh = HttpService.GenerateGUID(false);
	pcall(() => ServerStorage.SetAttribute("__MCPPlaceId", fresh));
	return `anon:${fresh}`;
}

let cachedPlaceName: string | undefined;
function resolvePlaceName(): string {
	if (cachedPlaceName !== undefined) return cachedPlaceName;
	if (game.PlaceId === 0) {
		cachedPlaceName = game.Name;
		return cachedPlaceName;
	}
	const MarketplaceService = game.GetService("MarketplaceService");
	const [ok, info] = pcall(() => MarketplaceService.GetProductInfo(game.PlaceId));
	if (ok && info !== undefined) {
		const name = (info as { Name?: string }).Name;
		if (typeIs(name, "string") && name !== "") {
			cachedPlaceName = name;
			return cachedPlaceName;
		}
	}
	return game.Name;
}

// The client peer cannot reach the MCP HTTP server - Roblox forbids
// HttpService:RequestAsync from the client DM even under PluginSecurity, and
// HttpEnabled reads as false there regardless of identity. So the server peer
// brokers execute_luau requests to the client via a RemoteFunction it places
// in ReplicatedStorage; each player gets a proxy "client" registration on the
// MCP side, polled and dispatched by the server peer.
//
// (Previously the server peer also registered an "edit-proxy" role to
// intercept /api/stop-playtest and call StudioTestService:EndTest. That hack
// is gone: stop now uses StopPlayMonitor with plugin:SetSetting cross-DM
// signaling, which works regardless of MCP server state.)

const DEFAULT_MCP_URL = "http://localhost:58741";
let mcpUrl = DEFAULT_MCP_URL;
const BROKER_NAME = "__MCPClientBroker";
const BROKER_OWNER_ATTRIBUTE = "__MCPBrokerOwner";

interface ProxyEntry {
	pluginSessionId: string;
	role: string;
}

interface BrokerEnvelope {
	endpoint?: string;
	data?: Record<string, unknown>;
	// Backward-compat: older server-broker code (pre-v2.10) sent the raw
	// {code} payload directly. If we see code at the top level and no
	// endpoint, treat it as execute-luau.
	code?: string;
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

interface ReadyResponseBody {
	assignedRole?: string;
}

interface PollResponseBody {
	requestId?: string;
	request?: {
		endpoint: string;
		data?: Record<string, unknown>;
	};
	// Server signals knownInstance=false when our proxy isn't in its
	// in-memory instances map (typically after an MCP process restart).
	// Triggers a re-register POST to /ready.
	knownInstance?: boolean;
	pollMode?: "long";
}

// Throttle re-ready calls per proxyId so a brief window of unknownInstance
// polls doesn't cause a re-register stampede.
const lastReadyByProxy = new Map<string, number>();

function reRegisterProxy(proxyId: string, role: string): void {
	const now = tick();
	const last = lastReadyByProxy.get(proxyId) ?? 0;
	if (now - last < 2) return;
	lastReadyByProxy.set(proxyId, now);
	pcall(() =>
		postJson("/ready", {
			pluginSessionId: proxyId,
			instanceId: computeInstanceId(),
			role,
			placeId: game.PlaceId,
			placeName: resolvePlaceName(),
			dataModelName: game.Name,
			isRunning: RunService.IsRunning(),
			pluginVersion: State.CURRENT_VERSION,
			pluginVariant: State.PLUGIN_VARIANT,
		}),
	);
}

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

function getServerUrl(): string {
	return mcpUrl;
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
		// Two payload shapes in the wild:
		// - {endpoint, data} from v2.10+ server-peer broker (this is the new
		//   discriminated form that lets us dispatch on endpoint)
		// - {code} from pre-v2.10 server-peer broker (raw execute-luau payload)
		// The shapes coexist gracefully because we fall back to execute-luau
		// when endpoint is missing.
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
		// Legacy: raw execute-luau payload at the top level.
		return handleExecuteLuau(payload as Record<string, unknown> | undefined);
	};
}

const proxyByPlayer = new Map<Player, ProxyEntry>();
const proxyRegisterFailuresByPlayer = new Set<Player>();
let serverBrokerStarted = false;

function unregisterProxy(player: Player, entry?: ProxyEntry): void {
	const proxy = entry ?? proxyByPlayer.get(player);
	if (!proxy) return;
	proxyByPlayer.delete(player);
	proxyRegisterFailuresByPlayer.delete(player);
	postJson("/disconnect", { pluginSessionId: proxy.pluginSessionId });
}

function disconnectAllProxies(): void {
	for (const [player, entry] of proxyByPlayer) {
		unregisterProxy(player, entry);
	}
	proxyByPlayer.clear();
	proxyRegisterFailuresByPlayer.clear();
}

function pollProxy(proxyId: string, player: Player, rf: RemoteFunction) {
	while (player.Parent !== undefined && proxyByPlayer.has(player)) {
		if (!RunService.IsRunning()) {
			unregisterProxy(player);
			break;
		}

		let nextPollDelay = 0.5;
		const [ok, res] = pcall(() => {
			const requestOptions = {
				Url: `${mcpUrl}/poll?pluginSessionId=${proxyId}&pollMode=long`,
				Method: "GET" as const,
				Headers: { "Content-Type": "application/json" },
				Timeout: State.POLL_REQUEST_TIMEOUT_SECONDS,
			};
			return HttpService.RequestAsync(requestOptions);
		});

		// RequestAsync may yield for the full long-poll window. Never apply a
		// stale response to a player whose proxy was removed or replaced.
		const currentProxy = proxyByPlayer.get(player);
		if (player.Parent === undefined || currentProxy?.pluginSessionId !== proxyId) break;

		if (ok && res && (res.Success || res.StatusCode === 503)) {
			const [okJson, body] = pcall(() => HttpService.JSONDecode(res.Body) as PollResponseBody);
			if (okJson && body) {
				// Server lost our proxy registration (process restart, etc.) -
				// re-register so the next poll cycle starts routing again.
				if (body.knownInstance === false) {
					reRegisterProxy(proxyId, "client");
				}
				if (body.request && body.requestId !== undefined) {
					const request = body.request;
					let response: unknown;
					if (CLIENT_BROKER_ALLOWED_ENDPOINTS.has(request.endpoint)) {
						// Forward as a discriminated envelope so the client-side
						// OnClientInvoke knows which endpoint it's serving.
						const envelope = { endpoint: request.endpoint, data: request.data };
						const [okInvoke, invokeRes] = pcall(() => rf.InvokeClient(player, envelope));
						if (okInvoke) {
							response = invokeRes !== undefined ? invokeRes : { success: false, error: "nil response" };
						} else {
							response = { success: false, error: `InvokeClient failed: ${tostring(invokeRes)}` };
						}
					} else {
						const allowed: string[] = [];
						for (const ep of CLIENT_BROKER_ALLOWED_ENDPOINTS) allowed.push(ep);
						response = {
							error:
								`Client-proxy does not forward ${tostring(request.endpoint)}. ` +
								`Allowed: ${allowed.join(", ")}.`,
						};
					}
					postJson("/response", { requestId: body.requestId, response });
				}

				if (res.Success && body.pollMode === "long" && body.knownInstance !== false && body.request === undefined) {
					nextPollDelay = 0;
				}
			}
		}

		if (nextPollDelay > 0) {
			task.wait(nextPollDelay);
		} else {
			// Yield one scheduler turn before replacing a completed long poll.
			task.wait();
		}
	}
}

function registerProxy(player: Player, rf: RemoteFunction) {
	if (proxyByPlayer.has(player)) return;
	const proxyId = HttpService.GenerateGUID(false);
	const [ok, res] = postJson("/ready", {
		pluginSessionId: proxyId,
		instanceId: computeInstanceId(),
		role: "client",
		placeId: game.PlaceId,
		placeName: resolvePlaceName(),
		dataModelName: game.Name,
		isRunning: RunService.IsRunning(),
		pluginVersion: State.CURRENT_VERSION,
		pluginVariant: State.PLUGIN_VARIANT,
	});
	if (!ok || !res || !res.Success) {
		proxyRegisterFailuresByPlayer.add(player);
		warn(`[robloxstudio-mcp] proxy register failed for ${player.Name}: ${formatPostJsonFailure("/ready", ok, res)}`);
		return;
	}
	const body = HttpService.JSONDecode(res.Body) as ReadyResponseBody;
	const assigned = body.assignedRole ?? "client";
	proxyByPlayer.set(player, { pluginSessionId: proxyId, role: assigned });
	if (proxyRegisterFailuresByPlayer.has(player)) {
		proxyRegisterFailuresByPlayer.delete(player);
		print(`[robloxstudio-mcp] proxy registered for ${player.Name} as ${assigned} via ${mcpUrl}`);
	}
	task.spawn(pollProxy, proxyId, player, rf);
}

// (Removed: startEditProxyLoop. The play-server DM no longer registers an
// "edit-proxy" peer with the MCP server. stop_playtest now uses a cross-DM
// plugin:SetSetting request consumed by StopPlayMonitor in the play-server DM,
// which doesn't depend on MCP server state or peer registration at all.)

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
	MCP_URL: DEFAULT_MCP_URL,
	DEFAULT_MCP_URL,
	getServerUrl,
	setServerUrl,
	disconnectAllProxies,
	forkRole,
	setupClientBroker,
	setupServerBroker,
};

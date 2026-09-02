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
import TopologyId from "./TopologyId";
import PeerRole from "./PeerRole";

interface StudioTestServiceMultiplayer extends StudioTestService {
	CanLeaveTest(): boolean;
	LeaveTest(): void;
	EditModeActive: boolean;
}

const StudioTestService = game.GetService("StudioTestService") as StudioTestServiceMultiplayer;

// Client Peers cannot reach the MCP HTTP server, so the server transport
// forwards requests over this RemoteFunction. The client supplies only its
// VM Peer identity; the server broker assigns trusted process/group topology
// from its own playtest context before publishing that Peer to MCP.

const DEFAULT_MCP_URL = "http://localhost:58741";
let mcpUrl = DEFAULT_MCP_URL;
const BROKER_NAME = "__MCPClientBroker";
const BROKER_OWNER_ATTRIBUTE = "__MCPBrokerOwner";
const CLIENT_IDENTITY_KIND = "identity";

interface ProxyEntry {
	player: Player;
	remote: RemoteFunction;
	peerId: string;
	instanceId: string;
	multiplayerGroupId?: string;
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

interface ClientIdentityHandshake {
	kind: "identity";
	peerId: string;
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
	return PeerRole.detect();
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
	return RuntimeLogBuffer.query({ since, tail, filter });
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

function sendClientIdentity(rf: RemoteFunction, attempt: number): void {
	if (PeerRole.detect() !== "client" || rf.Parent === undefined) return;
	const identity: ClientIdentityHandshake = {
		kind: "identity",
		peerId: PluginSession.peerId,
	};
	const [ok, response] = pcall(() => rf.InvokeServer(identity));
	if (ok && typeIs(response, "table")) {
		const acknowledgement = response as Record<string, unknown>;
		if (acknowledgement.success === true) return;
	}
	if (attempt === 0) {
		warn(`[robloxstudio-mcp] client identity handshake failed; retrying`);
	}
	task.delay(proxyRetryDelay(attempt + 1), sendClientIdentity, rf, attempt + 1);
}

function setupClientBroker(attempt = 0) {
	if (PeerRole.detect() !== "client") return;
	const rf = ReplicatedStorage.WaitForChild(BROKER_NAME, 10);
	if (!rf || !rf.IsA("RemoteFunction")) {
		if (attempt === 0) warn(`[robloxstudio-mcp] client: ${BROKER_NAME} not found; retrying`);
		if (RunService.IsRunning()) {
			task.delay(proxyRetryDelay(attempt + 1), setupClientBroker, attempt + 1);
		}
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
	task.spawn(sendClientIdentity, rf, 0);
}

const INITIAL_PROXY_RETRY_DELAY_SECONDS = 0.5;
const MAX_PROXY_RETRY_DELAY_SECONDS = 5;
const proxyByPlayer = new Map<Player, ProxyEntry>();
const proxyByPeerId = new Map<string, ProxyEntry>();
const proxyRegisterFailuresByPlayer = new Set<Player>();
const pendingProxyDisconnects = new Set<string>();
let serverBrokerStarted = false;

function unregisterProxy(player: Player, entry?: ProxyEntry): void {
	const proxy = entry ?? proxyByPlayer.get(player);
	if (!proxy) return;
	proxy.generation++;
	proxyByPlayer.delete(player);
	proxyByPeerId.delete(proxy.peerId);
	proxyRegisterFailuresByPlayer.delete(player);
	queueProxyDisconnect(proxy.peerId);
}

function disconnectAllProxies(): void {
	for (const [player, entry] of proxyByPlayer) {
		unregisterProxy(player, entry);
	}
	proxyByPlayer.clear();
	proxyByPeerId.clear();
	proxyRegisterFailuresByPlayer.clear();
}

function proxyRetryDelay(attempt: number): number {
	return math.min(
		INITIAL_PROXY_RETRY_DELAY_SECONDS * math.pow(2, math.max(attempt - 1, 0)),
		MAX_PROXY_RETRY_DELAY_SECONDS,
	);
}
function deliverProxyDisconnect(peerId: string, attempt: number): void {
	if (!pendingProxyDisconnects.has(peerId)) return;
	const [ok, response] = postJson("/disconnect", { peerId });
	if (ok && response && response.Success) {
		pendingProxyDisconnects.delete(peerId);
		return;
	}
	task.delay(proxyRetryDelay(attempt + 1), () => {
		deliverProxyDisconnect(peerId, attempt + 1);
	});
}

function queueProxyDisconnect(peerId: string): void {
	if (pendingProxyDisconnects.has(peerId)) return;
	pendingProxyDisconnects.add(peerId);
	task.spawn(deliverProxyDisconnect, peerId, 0);
}


function parseAssignedRole(body: string, entry: ProxyEntry): string | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(body));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const ready = decoded as Record<string, unknown>;
	if (
		ready.success !== true ||
		ready.peerId !== entry.peerId ||
		ready.instanceId !== entry.instanceId ||
		ready.multiplayerGroupId !== entry.multiplayerGroupId
	) {
		return undefined;
	}
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
	const readyPayload = PluginSession.createReadyPayload(
		entry.peerId,
		requestedRole,
		entry.instanceId,
		entry.multiplayerGroupId,
	);
	const [ok, res] = postJson("/ready", readyPayload);
	if (proxyByPlayer.get(entry.player) !== entry) {
		if (ok && res && res.Success) {
			queueProxyDisconnect(entry.peerId);
		}
		return;
	}
	if (entry.generation !== expectedGeneration) {
		entry.registering = false;
		if (!entry.registered) task.spawn(registerProxyEntry, entry);
		return;
	}
	entry.registering = false;

	if (!ok || !res || !res.Success) {
		failProxyRegistration(entry, formatPostJsonFailure("/ready", ok, res));
		return;
	}
	const assignedRole = parseAssignedRole(res.Body, entry);
	if (assignedRole === undefined) {
		failProxyRegistration(entry, "invalid /ready response for client Peer topology");
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

function parseClientIdentity(payload: unknown): ClientIdentityHandshake | undefined {
	if (!typeIs(payload, "table")) return undefined;
	const identity = payload as Record<string, unknown>;
	if (
		identity.kind !== CLIENT_IDENTITY_KIND ||
		!typeIs(identity.peerId, "string") ||
		identity.peerId === ""
	) {
		return undefined;
	}
	return {
		kind: "identity",
		peerId: identity.peerId,
	};
}

function registerProxy(player: Player, rf: RemoteFunction, identity: ClientIdentityHandshake): boolean {
	const peerOwner = proxyByPeerId.get(identity.peerId);
	if (peerOwner !== undefined && peerOwner.player !== player) return false;

	const current = proxyByPlayer.get(player);
	const multiplayerGroupId = PluginSession.getMultiplayerGroupId();
	// Managed multiplayer launches one client Player per Studio process. The
	// server creates that process identity instead of trusting replicated game
	// code to claim an Instance or Multiplayer Group. Solo clients use the
	// server's process Instance because their VMs share one Studio process.
	const retainedMultiplayerInstanceId =
		current !== undefined && current.multiplayerGroupId === multiplayerGroupId
			? current.instanceId
			: undefined;
	const instanceId = multiplayerGroupId !== undefined
		? retainedMultiplayerInstanceId ?? TopologyId.createInstanceId()
		: PluginSession.getInstanceId();

	if (current !== undefined) {
		if (current.peerId !== identity.peerId) {
			unregisterProxy(player, current);
		} else {
			if (
				current.instanceId !== instanceId ||
				current.multiplayerGroupId !== multiplayerGroupId
			) {
				current.generation++;
				current.instanceId = instanceId;
				current.multiplayerGroupId = multiplayerGroupId;
				current.role = "client";
				current.registered = false;
				current.registering = false;
				current.retryAttempt = 0;
				task.spawn(registerProxyEntry, current);
			}
			return true;
		}
	}

	const entry: ProxyEntry = {
		player,
		remote: rf,
		peerId: identity.peerId,
		instanceId,
		multiplayerGroupId,
		role: "client",
		registered: false,
		registering: false,
		retryAttempt: 0,
		generation: 0,
	};
	proxyByPlayer.set(player, entry);
	proxyByPeerId.set(entry.peerId, entry);
	task.spawn(registerProxyEntry, entry);
	return true;
}

function refreshAllProxyRegistrations(): void {
	for (const [, entry] of proxyByPlayer) {
		entry.generation++;
		entry.registered = false;
		entry.registering = false;
		entry.retryAttempt = 0;
		task.spawn(registerProxyEntry, entry);
	}
}

function dispatchClientRequest(
	peerId: string,
	target: string,
	endpoint: string,
	data?: Record<string, unknown>,
): unknown {
	const entry = proxyByPeerId.get(peerId);
	if (!entry || proxyByPlayer.get(entry.player) !== entry) {
		return { error: `Client proxy ${target} (${peerId}) is not registered.` };
	}
	if (entry.role === "client") {
		const [assignedClientRole] = target.match("^client%-%d+$");
		if (assignedClientRole !== undefined) entry.role = target;
	}
	if (entry.role !== target) {
		return {
			error: `Client proxy ${peerId} is registered as ${entry.role}, not ${target}.`,
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
	const existing = ReplicatedStorage.FindFirstChild(BROKER_NAME);
	let rf: RemoteFunction;
	if (existing !== undefined) {
		if (!existing.IsA("RemoteFunction")) {
			warn(`[robloxstudio-mcp] server: ${BROKER_NAME} exists but is not a RemoteFunction`);
			return;
		}
		rf = existing;
	} else {
		rf = new Instance("RemoteFunction");
	}
	if (rf.GetAttribute(BROKER_OWNER_ATTRIBUTE) !== undefined) return;

	rf.Name = BROKER_NAME;
	rf.SetAttribute(BROKER_OWNER_ATTRIBUTE, PluginSession.peerId);
	rf.OnServerInvoke = (player, payload: unknown) => {
		const identity = parseClientIdentity(payload);
		if (identity === undefined) {
			return { success: false, error: "Invalid client Peer identity handshake." };
		}
		if (!registerProxy(player, rf, identity)) {
			return { success: false, error: "Client Peer identity is already registered by another player." };
		}
		return { success: true };
	};
	if (rf.Parent === undefined) rf.Parent = ReplicatedStorage;
	serverBrokerStarted = true;
	Players.PlayerRemoving.Connect((player) => {
		unregisterProxy(player);
	});
	game.BindToClose(() => {
		disconnectAllProxies();
	});
}

export = {
	DEFAULT_MCP_URL,
	setServerUrl,
	disconnectAllProxies,
	refreshAllProxyRegistrations,
	dispatchClientRequest,
	forkRole,
	setupClientBroker,
	setupServerBroker,
};

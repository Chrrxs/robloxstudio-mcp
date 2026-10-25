import { HttpService, Players, ReplicatedStorage, RunService, Workspace } from "@rbxts/services";
import RuntimeLogBuffer from "./RuntimeLogBuffer";
import MemoryHandlers from "./handlers/MemoryHandlers";
import SceneAnalysisHandlers from "./handlers/SceneAnalysisHandlers";
import CaptureHandlers from "./handlers/CaptureHandlers";
import CaptureTransfer from "./CaptureTransfer";
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
import type { StudioRequestContext } from "../types";

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
// A normal capture needs at most 15s sampling + 5s waiting for profiler data.
// Leave room for processing, then return a diagnostic before the outer 30s wait.
const CLIENT_PROFILER_MAX_WAIT_SECONDS = 25;
// Every forwarded request ends its local wait this long before the MCP
// deadline, so the caller receives the broker's diagnosis instead of a bare
// "executing; unknown" timeout from the server.
const CLIENT_RESPONSE_RESERVE_SECONDS = 5;
const CLIENT_WAIT_POLL_SECONDS = 0.05;

// Client Peers send a heartbeat over this RemoteEvent every second, and the
// server pings them back. Both use the same server-client connection as
// InvokeClient, so they show whether the bridge channel is delivering,
// separately from whether the game itself is running.
const HEARTBEAT_NAME = "__MCPClientBrokerHeartbeat";
const HEARTBEAT_INTERVAL_SECONDS = 1;
// Ten missed heartbeats, or a channel delay of ten seconds, marks the bridge as
// stalled. While it is stalled and an earlier request went unanswered, new
// requests are refused before sending (see unresponsiveBridge).
const BRIDGE_STALE_SECONDS = 10;
const MAX_REPORTED_CLIENT_REQUESTS = 8;
const CLIENT_REQUEST_REPORT_SECONDS = 60;

interface ClientRequestObservation {
	requestId: string;
	endpoint: string;
	startedAt: number;
	finishedAt?: number;
}

interface ClientHeartbeat {
	kind: "heartbeat";
	sentAt: number;
	pingSentAt?: number;
	pingReceivedAt?: number;
	requests: ClientRequestObservation[];
}

interface HeartbeatObservation extends ClientHeartbeat {
	receivedAt: number;
}

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
	heartbeat?: HeartbeatObservation;
	// Server time of the first ping sent to this client.
	firstPingSentAt?: number;
	// os.clock of the latest broker wait that timed out, and of the latest answer.
	lastTimeoutAt?: number;
	lastAnswerAt?: number;
}

interface BrokerEnvelope {
	endpoint: string;
	data?: Record<string, unknown>;
	requestId?: string;
	remainingMs?: number;
	expiresAtServerTime?: number;
}

interface ClientIdentityHandshake {
	kind: "identity";
	peerId: string;
}

interface BridgeHealth {
	heartbeatAgeMs?: number;
	clientToServerDelayMs?: number;
	serverToClientDelayMs?: number;
	// not_received: no server message sent after this request has reached the
	// client yet. not_started: later messages arrived, but the request never ran.
	requestState?: "not_received" | "not_started" | "running" | "completed";
	requestRunningMs?: number;
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
	// The server pulls a client's MicroProfiler capture in bounded chunks.
	"/api/micro-profiler-read",
	"/api/micro-profiler-release",
	"/api/multiplayer-test-state",
	"/api/multiplayer-test-leave-client",
	// Screenshot capture must run in the client peer: CaptureService captures
	// the play viewport there (the edit DM reads the temp id back separately),
	// and StudioCaptureService only completes in the DataModel that is being
	// rendered — during a playtest that is the client, never the edit peer.
	"/api/capture-begin",
	"/api/capture-studio",
	// Host-side window capture locates the play viewport with markers drawn
	// in the client DM (the edit DM is not rendered during a playtest).
	"/api/capture-markers",
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

function routeClientRequest(payload: BrokerEnvelope): unknown {
	if (payload.endpoint === "/api/get-runtime-logs") {
		return handleGetRuntimeLogs(payload.data);
	}
	if (payload.endpoint === "/api/get-memory-breakdown") {
		return MemoryHandlers.getMemoryBreakdown(payload.data ?? {});
	}
	if (payload.endpoint === "/api/get-scene-analysis") {
		return SceneAnalysisHandlers.getSceneAnalysis(payload.data ?? {});
	}
	if (payload.endpoint === "/api/breakpoints") {
		return BreakpointHandlers.breakpoints(payload.data ?? {});
	}
	if (payload.endpoint === "/api/capture-script-profiler") {
		return ScriptProfilerHandlers.captureScriptProfiler(payload.data ?? {});
	}
	if (payload.endpoint === "/api/capture-micro-profiler") {
		return MicroProfilerHandlers.captureMicroProfiler(payload.data ?? {});
	}
	if (payload.endpoint === "/api/micro-profiler-read") {
		return MicroProfilerHandlers.readTransfer(payload.data ?? {});
	}
	if (payload.endpoint === "/api/micro-profiler-release") {
		return MicroProfilerHandlers.releaseTransfer(payload.data ?? {});
	}
	if (payload.endpoint === "/api/multiplayer-test-state") {
		return handleMultiplayerTestState();
	}
	if (payload.endpoint === "/api/multiplayer-test-leave-client") {
		return handleMultiplayerTestLeaveClient();
	}
	if (payload.endpoint === "/api/capture-begin") {
		return CaptureHandlers.captureBegin();
	}
	if (payload.endpoint === "/api/capture-studio") {
		// Every chunk read shares this request's deadline, so after it nobody
		// reads the pixels and the transfer slot can be freed.
		const ttl = typeIs(payload.expiresAtServerTime, "number")
			? payload.expiresAtServerTime - Workspace.GetServerTimeNow() + 1 : undefined;
		return CaptureTransfer.begin(payload.data ?? {}, () => CaptureHandlers.captureStudio(payload.data ?? {}), ttl);
	}
	if (payload.endpoint === "/api/capture-markers") {
		return CaptureHandlers.captureMarkers(payload.data ?? {});
	}
	if (payload.endpoint === CaptureTransfer.READ_ENDPOINT) {
		return CaptureTransfer.read(payload.data ?? {});
	}
	if (payload.endpoint === CaptureTransfer.RELEASE_ENDPOINT) {
		return CaptureTransfer.release(payload.data ?? {});
	}
	if (payload.endpoint === "/api/simulate-mouse-input") {
		return InputHandlers.simulateMouseInput(payload.data ?? {});
	}
	if (payload.endpoint === "/api/simulate-keyboard-input") {
		return InputHandlers.simulateKeyboardInput(payload.data ?? {});
	}
	if (payload.endpoint === "/api/focus-viewport") {
		return MetadataHandlers.focusViewport(payload.data ?? {});
	}
	if (payload.endpoint === "/api/execute-luau") {
		return handleExecuteLuau(payload.data);
	}
	if (payload.endpoint === "/api/eval-runtime") {
		return EvalRuntimeHandlers.evalRuntime(payload.data ?? {});
	}
	return { error: `Unsupported client broker endpoint: ${payload.endpoint}` };
}

// Requests this client received recently, reported in heartbeats so the server
// can tell "never arrived" from "still running" when a request times out.
const clientRequests = new Map<string, ClientRequestObservation>();
let lastServerPing: { sentAt: number; receivedAt: number } | undefined;
let clientHeartbeatStarted = false;

function pruneClientRequests(now: number): void {
	for (const [requestId, observation] of clientRequests) {
		if (observation.finishedAt !== undefined && now - observation.finishedAt > CLIENT_REQUEST_REPORT_SECONDS) {
			clientRequests.delete(requestId);
		}
	}
}

function reportedClientRequests(now: number): ClientRequestObservation[] {
	pruneClientRequests(now);
	const reported: ClientRequestObservation[] = [];
	for (const [, observation] of clientRequests) reported.push(observation);
	// Running requests first, then the most recently started.
	reported.sort((a, b) => {
		if ((a.finishedAt === undefined) !== (b.finishedAt === undefined)) return a.finishedAt === undefined;
		return a.startedAt > b.startedAt;
	});
	const limited: ClientRequestObservation[] = [];
	for (let i = 0; i < math.min(reported.size(), MAX_REPORTED_CLIENT_REQUESTS); i++) limited.push(reported[i]);
	return limited;
}

function handleClientInvoke(payload: BrokerEnvelope | undefined): unknown {
	if (!payload || !typeIs(payload.endpoint, "string")) {
		return { error: "Client broker request is missing its endpoint." };
	}
	// os.clock is VM-local. Only the engine-synchronized server clock can
	// reject an envelope that expired while travelling to this client. The
	// server already reported a timeout for it, so running it now would apply
	// a change the caller was told had an unknown outcome, long after the fact.
	const now = Workspace.GetServerTimeNow();
	if (
		(typeIs(payload.remainingMs, "number") && payload.remainingMs <= 0) ||
		(typeIs(payload.expiresAtServerTime, "number") && now >= payload.expiresAtServerTime)
	) {
		const lateMs = typeIs(payload.expiresAtServerTime, "number")
			? math.floor(math.max(0, now - payload.expiresAtServerTime) * 1000) : 0;
		return {
			success: false,
			error: "client_broker_expired",
			stage: "client_broker_pre_start",
			requestId: payload.requestId,
			executionOutcome: "not_executed",
			lateMs,
			message: `Request ${tostring(payload.requestId)} (${payload.endpoint}) reached the client ${lateMs} ms after its deadline, so it was not started.`,
		};
	}
	const requestId = typeIs(payload.requestId, "string") ? payload.requestId : undefined;
	let observation: ClientRequestObservation | undefined;
	if (requestId !== undefined) {
		observation = { requestId, endpoint: payload.endpoint, startedAt: now };
		clientRequests.set(requestId, observation);
	}
	const [ok, result] = pcall(() => routeClientRequest(payload));
	if (observation !== undefined) observation.finishedAt = Workspace.GetServerTimeNow();
	// Keep the engine's error propagation: InvokeClient raises on the server.
	if (!ok) error(result, 0);
	return result;
}

function startClientHeartbeat(attempt = 0): void {
	if (clientHeartbeatStarted || PeerRole.detect() !== "client" || !RunService.IsRunning()) return;
	const event = ReplicatedStorage.WaitForChild(HEARTBEAT_NAME, 10);
	if (!event || !event.IsA("RemoteEvent")) {
		// An older server broker has no heartbeat channel; requests still work.
		if (RunService.IsRunning() && attempt < 5) {
			task.delay(proxyRetryDelay(attempt + 1), startClientHeartbeat, attempt + 1);
		}
		return;
	}
	clientHeartbeatStarted = true;
	event.OnClientEvent.Connect((payload: unknown) => {
		if (!typeIs(payload, "table")) return;
		const ping = payload as Record<string, unknown>;
		if (ping.kind !== "ping" || !typeIs(ping.sentAt, "number")) return;
		lastServerPing = { sentAt: ping.sentAt, receivedAt: Workspace.GetServerTimeNow() };
	});
	task.spawn(() => {
		while (event.Parent !== undefined && RunService.IsRunning()) {
			// One failed beat must not end the loop: silence means "stalled".
			pcall(() => {
				const now = Workspace.GetServerTimeNow();
				const heartbeat: ClientHeartbeat = {
					kind: "heartbeat",
					sentAt: now,
					pingSentAt: lastServerPing?.sentAt,
					pingReceivedAt: lastServerPing?.receivedAt,
					requests: reportedClientRequests(now),
				};
				event.FireServer(heartbeat);
			});
			task.wait(HEARTBEAT_INTERVAL_SECONDS);
		}
		clientHeartbeatStarted = false;
	});
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
	rf.OnClientInvoke = handleClientInvoke;
	task.spawn(sendClientIdentity, rf, 0);
	task.spawn(startClientHeartbeat, 0);
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

function msBetween(later: number, earlier: number): number {
	return math.floor(math.max(0, later - earlier) * 1000);
}

function seconds(ms: number): string {
	return string.format("%.1f s", ms / 1000);
}

// Everything here is measured with Workspace:GetServerTimeNow, which the engine
// keeps synchronized between the server and its clients.
function bridgeHealth(entry: ProxyEntry, requestId?: string, dispatchedAt?: number): BridgeHealth {
	const heartbeat = entry.heartbeat;
	if (heartbeat === undefined) return {};
	const now = Workspace.GetServerTimeNow();
	const health: BridgeHealth = {
		heartbeatAgeMs: msBetween(now, heartbeat.receivedAt),
		clientToServerDelayMs: msBetween(heartbeat.receivedAt, heartbeat.sentAt),
	};
	// Pings leave every second, so the newest ping the client had seen is at most
	// about a second old on a healthy channel. Its age measures server->client delay.
	if (heartbeat.pingSentAt !== undefined) {
		health.serverToClientDelayMs = msBetween(heartbeat.sentAt, heartbeat.pingSentAt);
	} else if (entry.firstPingSentAt !== undefined && heartbeat.sentAt > entry.firstPingSentAt) {
		health.serverToClientDelayMs = msBetween(heartbeat.sentAt, entry.firstPingSentAt);
	}
	if (requestId !== undefined) {
		const observed = heartbeat.requests.find((request) => request.requestId === requestId);
		if (observed !== undefined) {
			if (observed.finishedAt === undefined) {
				health.requestState = "running";
				health.requestRunningMs = msBetween(now, observed.startedAt);
			} else {
				health.requestState = "completed";
				health.requestRunningMs = msBetween(observed.finishedAt, observed.startedAt);
			}
		} else if (
			dispatchedAt !== undefined && heartbeat.pingSentAt !== undefined && heartbeat.pingSentAt > dispatchedAt &&
			heartbeat.requests.size() < MAX_REPORTED_CLIENT_REQUESTS
		) {
			health.requestState = "not_started";
		} else if (dispatchedAt !== undefined && heartbeat.sentAt > dispatchedAt) {
			health.requestState = "not_received";
		}
	}
	return health;
}

const BACKLOG_EXPLANATION = "Requests to a client share the server-client connection with the game's replication and remote traffic, " +
	"so a backlog there delays them while the game itself keeps running.";

function describeBridgeHealth(health: BridgeHealth): string {
	if (health.heartbeatAgeMs === undefined) {
		return "No heartbeat has arrived from this client's MCP bridge, so its liveness is unknown.";
	}
	const channel = `Bridge heartbeat ${seconds(health.heartbeatAgeMs)} ago; client->server delay ${seconds(health.clientToServerDelayMs ?? 0)}` +
		(health.serverToClientDelayMs !== undefined ? `; server->client delay ${seconds(health.serverToClientDelayMs)}.` : ".");
	if (health.heartbeatAgeMs > BRIDGE_STALE_SECONDS * 1000) {
		return `${channel} The client's MCP bridge has stopped sending heartbeats: either the client's Luau scheduler is blocked by a long-running script, or client->server messages are stalled. The game window can keep rendering in both cases.`;
	}
	if (health.requestState === "running") {
		return `${channel} The client received this request and its handler has been running for ${seconds(health.requestRunningMs ?? 0)}: the code is yielding or blocked inside the client.`;
	}
	if (health.requestState === "completed") {
		return `${channel} The client finished this request but its response has not arrived: client->server traffic is backlogged. ${BACKLOG_EXPLANATION}`;
	}
	if (health.requestState === "not_started") {
		return `${channel} The client has received server messages sent after this request but has not started it: the client broker never ran it, or it is still queued inside the client.`;
	}
	if ((health.serverToClientDelayMs ?? 0) > BRIDGE_STALE_SECONDS * 1000 || health.requestState === "not_received") {
		return `${channel} The request has not reached the client: server->client traffic is backlogged. ${BACKLOG_EXPLANATION}`;
	}
	if ((health.clientToServerDelayMs ?? 0) > BRIDGE_STALE_SECONDS * 1000) {
		return `${channel} Client->server traffic is backlogged. ${BACKLOG_EXPLANATION}`;
	}
	return channel;
}

// A request sent into a stalled channel only waits out its deadline, and may
// then run on the client long after the caller gave up on it. Heartbeats alone
// are not enough to refuse: a request to this client must also have timed out
// with no answer since, so a broken heartbeat can never block a working channel.
function unresponsiveBridge(entry: ProxyEntry): BridgeHealth | undefined {
	if (entry.lastTimeoutAt === undefined) return undefined;
	if (entry.lastAnswerAt !== undefined && entry.lastAnswerAt > entry.lastTimeoutAt) return undefined;
	const health = bridgeHealth(entry);
	if (health.heartbeatAgeMs === undefined) return undefined;
	const staleMs = BRIDGE_STALE_SECONDS * 1000;
	if (
		health.heartbeatAgeMs > staleMs ||
		(health.clientToServerDelayMs ?? 0) > staleMs ||
		(health.serverToClientDelayMs ?? 0) > staleMs
	) {
		return health;
	}
	return undefined;
}

interface ClientCall {
	entry: ProxyEntry;
	target: string;
	endpoint: string;
	context: StudioRequestContext;
	startedAt: number;
	deadlineAt: number;
}

type InvokeOutcome = { ok: true; result: unknown } | { ok: false; failure: Record<string, unknown> };

function callFailure(
	call: ClientCall,
	code: string,
	stage: string,
	outcome: "unknown" | "not_executed",
	detail: string,
	health?: BridgeHealth,
): Record<string, unknown> {
	call.context.executionOutcome = outcome;
	const healthText = health !== undefined ? ` ${describeBridgeHealth(health)}` : "";
	return {
		success: false,
		error: code,
		stage,
		requestId: call.context.requestId,
		peerId: call.entry.peerId,
		target: call.target,
		endpoint: call.endpoint,
		elapsedMs: math.floor(math.max(0, os.clock() - call.startedAt) * 1000),
		executionOutcome: outcome,
		bridge: health,
		message: outcome === "unknown"
			? `${detail}${healthText} Only the broker's local wait ended: a request that already started on the client is not cancelled or rolled back, and one still in transit is refused by the client once its deadline has passed. No retry was started.`
			: `${detail}${healthText} The request was not sent to the client.`,
	};
}

function beginClientCall(
	entry: ProxyEntry,
	target: string,
	endpoint: string,
	context: StudioRequestContext,
	maxWaitSeconds?: number,
	reserveSeconds?: number,
): ClientCall {
	const startedAt = os.clock();
	const remaining = context.deadlineAt - startedAt;
	// Short budgets (runtime log fan-out uses 5 s) keep most of their time.
	const reserve = reserveSeconds ?? math.clamp(remaining * 0.2, 0.25, CLIENT_RESPONSE_RESERVE_SECONDS);
	let deadlineAt = context.deadlineAt - reserve;
	if (maxWaitSeconds !== undefined) deadlineAt = math.min(deadlineAt, startedAt + maxWaitSeconds);
	return { entry, target, endpoint, context, startedAt, deadlineAt };
}

function admitClientCall(call: ClientCall): Record<string, unknown> | undefined {
	if (call.context.isCancelled()) {
		return callFailure(call, "client_broker_cancelled", "client_broker_admission", "not_executed", "Request cancelled before client invocation.");
	}
	if (call.startedAt >= call.deadlineAt) {
		return callFailure(call, "client_broker_timeout", "client_broker_admission", "not_executed", "Insufficient request budget for client invocation and response delivery.");
	}
	const unresponsive = unresponsiveBridge(call.entry);
	if (unresponsive !== undefined) {
		return callFailure(
			call,
			"client_bridge_unresponsive",
			"client_broker_admission",
			"not_executed",
			`The MCP bridge to ${call.target} is unresponsive, so ${call.endpoint} was refused instead of waiting for its deadline. This is the plugin's server-to-client channel, not necessarily the game.`,
			unresponsive,
		);
	}
	return undefined;
}

// InvokeClient yields until the client answers, forever if it never does. Run it
// on its own thread and stop waiting at the call's deadline. requestId names
// this one invocation in the client's heartbeat reports.
function invokeClient(
	call: ClientCall,
	endpoint: string,
	data: Record<string, unknown> | undefined,
	requestId = call.context.requestId,
): InvokeOutcome {
	const { entry, context } = call;
	const dispatchedAt = Workspace.GetServerTimeNow();
	const interrupted = (): Record<string, unknown> | undefined => {
		if (context.isCancelled()) {
			return callFailure(call, "client_broker_cancelled", "client_broker_wait", "unknown", `Request cancelled while awaiting ${call.target}'s response.`);
		}
		if (
			proxyByPeerId.get(entry.peerId) !== entry || proxyByPlayer.get(entry.player) !== entry ||
			entry.player.Parent === undefined || entry.remote.Parent === undefined || !RunService.IsRunning()
		) {
			return callFailure(call, "client_broker_disconnected", "client_broker_wait", "unknown", `Client proxy ${call.target} disconnected while awaiting its response.`);
		}
		if (os.clock() >= call.deadlineAt) {
			entry.lastTimeoutAt = os.clock();
			return callFailure(
				call,
				"client_broker_timeout",
				"client_broker_wait",
				"unknown",
				`${call.target} did not answer ${endpoint} within ${seconds(msBetween(os.clock(), call.startedAt))}.`,
				bridgeHealth(entry, requestId, dispatchedAt),
			);
		}
		return undefined;
	};
	const remainingMs = math.max(0, math.floor((call.deadlineAt - os.clock()) * 1000));
	const expiresAtServerTime = Workspace.GetServerTimeNow() + remainingMs / 1000;
	const envelope: BrokerEnvelope = {
		endpoint,
		data,
		requestId,
		remainingMs,
		expiresAtServerTime,
	};
	let settled = false;
	let outcome: InvokeOutcome | undefined;
	context.executionOutcome = "unknown";
	const invocation = task.spawn(() => {
		const [ok, result] = pcall(() => entry.remote.InvokeClient(entry.player, envelope));
		// Even a late answer shows the channel delivers again.
		if (ok) entry.lastAnswerAt = os.clock();
		// Cancelling a suspended engine wait is best effort. A late return must
		// never replace the chosen outcome, even if task.cancel was unavailable.
		if (settled) return;
		const interruption = interrupted();
		if (interruption !== undefined) {
			outcome = { ok: false, failure: interruption };
		} else if (!ok) {
			outcome = { ok: false, failure: callFailure(call, "client_broker_invoke_failed", "client_broker_wait", "unknown", `InvokeClient failed: ${tostring(result)}`) };
		} else if (result === undefined) {
			outcome = { ok: false, failure: callFailure(call, "client_broker_nil_response", "client_broker_wait", "unknown", `${call.target} returned no response.`) };
		} else {
			outcome = { ok: true, result };
			// Only the client's own pre-start refusal establishes that nothing ran.
			// Other responses keep normal handler outcome classification;
			// arbitrary payload fields cannot override the transport observation.
			context.executionOutcome = undefined;
			if (typeIs(result, "table")) {
				const reply = result as Record<string, unknown>;
				if (reply.error === "client_broker_expired" && reply.stage === "client_broker_pre_start") {
					context.executionOutcome = "not_executed";
				}
			}
		}
		settled = true;
	});
	while (!settled) {
		const interruption = interrupted();
		if (interruption !== undefined) {
			outcome = { ok: false, failure: interruption };
			settled = true;
			// This only releases the local coroutine; it cannot stop the remote
			// OnClientInvoke callback or roll back work that already started.
			pcall(() => task.cancel(invocation));
			break;
		}
		task.wait(math.min(CLIENT_WAIT_POLL_SECONDS, call.deadlineAt - os.clock()));
	}
	return outcome as InvokeOutcome;
}

function invokeClientOnce(
	entry: ProxyEntry,
	target: string,
	endpoint: string,
	data: Record<string, unknown> | undefined,
	context: StudioRequestContext,
	maxWaitSeconds?: number,
	reserveSeconds?: number,
): unknown {
	const call = beginClientCall(entry, target, endpoint, context, maxWaitSeconds, reserveSeconds);
	const refused = admitClientCall(call);
	if (refused !== undefined) return refused;
	const outcome = invokeClient(call, endpoint, data);
	return outcome.ok ? outcome.result : outcome.failure;
}

// Screenshot transfer is several invocations; they share one deadline, and the
// first broker failure ends the transfer with that failure's diagnosis.
function invokeClientCapture(
	entry: ProxyEntry,
	target: string,
	data: Record<string, unknown> | undefined,
	context: StudioRequestContext,
): unknown {
	const call = beginClientCall(entry, target, "/api/capture-studio", context);
	const refused = admitClientCall(call);
	if (refused !== undefined) return refused;
	let brokerFailure: Record<string, unknown> | undefined;
	let outcome: StudioRequestContext["executionOutcome"];
	let invocations = 0;
	const result = CaptureTransfer.receive((captureEndpoint, captureData) => {
		if (brokerFailure !== undefined) error("client broker failed", 0);
		invocations++;
		const invoked = invokeClient(call, captureEndpoint, captureData, `${context.requestId}:${invocations}`);
		if (!invoked.ok) {
			brokerFailure = invoked.failure;
			outcome = context.executionOutcome;
			error("client broker failed", 0);
		}
		return invoked.result;
	}, data ?? {});
	if (brokerFailure !== undefined) {
		context.executionOutcome = outcome;
		return brokerFailure;
	}
	return result;
}

function dispatchClientRequest(
	peerId: string,
	target: string,
	endpoint: string,
	data: Record<string, unknown> | undefined,
	context: StudioRequestContext,
): unknown {
	if (endpoint === "/api/capture-script-profiler") context.executionOutcome = "not_executed";
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
	if (endpoint === "/api/capture-script-profiler") {
		return invokeClientOnce(entry, target, endpoint, data, context, CLIENT_PROFILER_MAX_WAIT_SECONDS, CLIENT_RESPONSE_RESERVE_SECONDS);
	}
	if (endpoint === "/api/capture-studio") {
		return invokeClientCapture(entry, target, data, context);
	}
	return invokeClientOnce(entry, target, endpoint, data, context);
}

function optionalNumber(value: unknown): number | undefined {
	return typeIs(value, "number") && value === value ? value : undefined;
}

function parseHeartbeat(payload: unknown): ClientHeartbeat | undefined {
	if (!typeIs(payload, "table")) return undefined;
	const fields = payload as Record<string, unknown>;
	const sentAt = optionalNumber(fields.sentAt);
	if (fields.kind !== "heartbeat" || sentAt === undefined) return undefined;
	const requests: ClientRequestObservation[] = [];
	if (typeIs(fields.requests, "table")) {
		for (const value of fields.requests as unknown[]) {
			if (requests.size() >= MAX_REPORTED_CLIENT_REQUESTS) break;
			if (!typeIs(value, "table")) continue;
			const request = value as Record<string, unknown>;
			const startedAt = optionalNumber(request.startedAt);
			if (
				!typeIs(request.requestId, "string") || request.requestId.size() > 384 ||
				!typeIs(request.endpoint, "string") || request.endpoint.size() > 128 || startedAt === undefined
			) continue;
			requests.push({
				requestId: request.requestId,
				endpoint: request.endpoint,
				startedAt,
				finishedAt: optionalNumber(request.finishedAt),
			});
		}
	}
	return {
		kind: "heartbeat",
		sentAt,
		pingSentAt: optionalNumber(fields.pingSentAt),
		pingReceivedAt: optionalNumber(fields.pingReceivedAt),
		requests,
	};
}

function setupHeartbeatChannel(): void {
	const existing = ReplicatedStorage.FindFirstChild(HEARTBEAT_NAME);
	if (existing !== undefined && !existing.IsA("RemoteEvent")) {
		warn(`[robloxstudio-mcp] server: ${HEARTBEAT_NAME} exists but is not a RemoteEvent; client bridge liveness is unavailable`);
		return;
	}
	const event = existing ?? new Instance("RemoteEvent");
	event.Name = HEARTBEAT_NAME;
	event.OnServerEvent.Connect((player, payload) => {
		const entry = proxyByPlayer.get(player);
		if (entry === undefined) return;
		const heartbeat = parseHeartbeat(payload);
		if (heartbeat === undefined) return;
		entry.heartbeat = { ...heartbeat, receivedAt: Workspace.GetServerTimeNow() };
	});
	if (event.Parent === undefined) event.Parent = ReplicatedStorage;
	task.spawn(() => {
		while (event.Parent !== undefined && RunService.IsRunning()) {
			const sentAt = Workspace.GetServerTimeNow();
			// Only clients that have shown they listen get pings, so an older
			// client never accumulates unhandled events.
			for (const [player, entry] of proxyByPlayer) {
				if (entry.heartbeat === undefined) continue;
				if (entry.firstPingSentAt === undefined) entry.firstPingSentAt = sentAt;
				pcall(() => event.FireClient(player, { kind: "ping", sentAt }));
			}
			task.wait(HEARTBEAT_INTERVAL_SECONDS);
		}
	});
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
	// Publish the heartbeat channel first, so a client that finds the broker
	// also finds its liveness channel.
	setupHeartbeatChannel();
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

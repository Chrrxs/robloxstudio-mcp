import { HttpService } from "@rbxts/services";
import HttpDiagnostics from "./HttpDiagnostics";
import PluginSession from "./PluginSession";
import type {
	ReadyResponse,
	StudioAckEvent,
	StudioCancelEvent,
	StudioExecutionOutcome,
	StudioProgressEvent,
	StudioRequestContext,
	StudioRequestEvent,
	StudioStatusEvent,
	TransportUpdate,
} from "../types";

const PROTOCOL_VERSION = 1;
const INITIAL_RETRY_DELAY_SECONDS = 0.5;
const MAX_RETRY_DELAY_SECONDS = 5;
const SOCKET_SILENCE_TIMEOUT_SECONDS = 20;
const RESPONSE_RETENTION_SECONDS = 5 * 60;
const RESPONSE_ACK_TIMEOUT_SECONDS = 120;
const MAX_TERMINAL_RESPONSES = 32768;
const MAX_ACTIVE_RESPONSES = 128;
const MAX_ADMISSION_REJECTIONS = 128;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_RESPONSE_BYTES = 64 * 1024 * 1024;
const RESERVED_ERROR_BYTES = 4096;
// The bridge admits 128 UTF-16 code units; each can require three UTF-8 bytes.
const MAX_REQUEST_ID_BYTES = 128 * 3;

interface StudioWebSocketOptions {
	serverUrl: string;
	dispatchRequest: (request: StudioRequestEvent, context: StudioRequestContext) => unknown;
	onStatus: (status: StudioStatusEvent) => void;
	onHeartbeat: (timestamp: number) => void;
	onReady: (response: ReadyResponse) => void;
	onTransportUpdate: (update: TransportUpdate) => void;
}

type DecodedEvent = StudioRequestEvent | StudioCancelEvent | StudioStatusEvent | StudioAckEvent
	| { kind: "heartbeat"; timestamp: number };

interface RequestProgress {
	serverUrl: string;
	phase?: StudioProgressEvent["phase"];
	outcome?: StudioExecutionOutcome;
	sentGeneration?: number;
	sentPhase?: StudioProgressEvent["phase"];
}

interface PendingResponse {
	body: string;
	serverUrl: string;
	expiresAt: number;
	admissionRejection: boolean;
	sendAttempt: number;
	sentGeneration?: number;
	ackTimer?: thread;
	expiryTimer?: thread;
	progress: RequestProgress;
}

interface InFlightRequest {
	cancelled: boolean;
	progress: RequestProgress;
}

interface TerminalResponse {
	requestId: string;
	expiresAt: number;
}

let options: StudioWebSocketOptions | undefined;
let active = false;
let shutdownSuspended = false;
let generation = 0;
let reconnectAttempt = 0;
let socketClient: WebStreamClient | undefined;
let socketOpen = false;
let socketConnections: RBXScriptConnection[] = [];
let lastValidEventAt = 0;
let cachedReady: ReadyResponse | undefined;
let readyRefreshPending = false;
let pendingResponseBytes = 0;
let inFlightRequestBytes = 0;
let pendingRejectionCount = 0;
const inFlightRequests = new Map<string, InFlightRequest>();
const pendingResponses = new Map<string, PendingResponse>();
const terminalResponseIds = new Set<string>();
const terminalResponseOrder: Array<TerminalResponse | undefined> = [];
let terminalHead = 0;
let terminalCount = 0;
const readyFailureLogKeys = new Set<string>();

function validRequestId(value: unknown): value is string {
	return typeIs(value, "string") && value.size() > 0 && value.size() <= MAX_REQUEST_ID_BYTES;
}

function decodeMessage(payload: string): DecodedEvent | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(payload));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const envelope = decoded as Record<string, unknown>;
	if (envelope.kind === "heartbeat") {
		if (!typeIs(envelope.timestamp, "number")) return undefined;
		return { kind: "heartbeat", timestamp: envelope.timestamp };
	}
	if (envelope.kind === "status") {
		if (!typeIs(envelope.knownPeer, "boolean") || !typeIs(envelope.mcpConnected, "boolean")) return undefined;
		return {
			kind: "status",
			knownPeer: envelope.knownPeer,
			mcpConnected: envelope.mcpConnected,
			serverVersion: typeIs(envelope.serverVersion, "string") ? envelope.serverVersion : undefined,
			pluginVersion: typeIs(envelope.pluginVersion, "string") ? envelope.pluginVersion : undefined,
			pluginVariant: typeIs(envelope.pluginVariant, "string") ? envelope.pluginVariant : undefined,
		};
	}
	if (!validRequestId(envelope.requestId)) return undefined;
	if (envelope.kind === "ack") {
		if (envelope.disposition !== "accepted" && envelope.disposition !== "already_settled" && envelope.disposition !== "unknown") return undefined;
		return { kind: "ack", requestId: envelope.requestId, disposition: envelope.disposition };
	}
	if (envelope.kind === "cancel") {
		if (envelope.reason !== "timeout" && envelope.reason !== "aborted" && envelope.reason !== "connection_closed") return undefined;
		return { kind: "cancel", requestId: envelope.requestId, reason: envelope.reason };
	}
	if (envelope.kind === "request") {
		if (
			!typeIs(envelope.peerId, "string") || !typeIs(envelope.target, "string") ||
			!typeIs(envelope.endpoint, "string") || !typeIs(envelope.remainingMs, "number") ||
			envelope.remainingMs < 0 || envelope.remainingMs !== envelope.remainingMs || envelope.remainingMs === math.huge
		) return undefined;
		return {
			kind: "request", requestId: envelope.requestId, peerId: envelope.peerId,
			target: envelope.target, endpoint: envelope.endpoint, remainingMs: envelope.remainingMs,
			data: typeIs(envelope.data, "table") ? envelope.data as Record<string, unknown> : undefined,
		};
	}
	return undefined;
}

function closeCurrentSocket(): void {
	const current = socketClient;
	socketClient = undefined;
	socketOpen = false;
	for (const connection of socketConnections) connection.Disconnect();
	socketConnections = [];
	for (const [, entry] of pendingResponses) {
		if (entry.ackTimer !== undefined) task.cancel(entry.ackTimer);
		entry.ackTimer = undefined;
	}
	if (current !== undefined) pcall(() => current.Close());
}

function disconnectSession(currentOptions: StudioWebSocketOptions): void {
	pcall(() => HttpService.RequestAsync({
		Url: `${currentOptions.serverUrl}/disconnect`, Method: "POST",
		Headers: { "Content-Type": "application/json" },
		Body: HttpService.JSONEncode({ peerId: PluginSession.peerId }),
	}));
}

function retryDelay(attempt: number): number {
	return math.min(INITIAL_RETRY_DELAY_SECONDS * math.pow(2, math.max(attempt - 1, 0)), MAX_RETRY_DELAY_SECONDS);
}

function pruneTerminalResponses(): void {
	const now = os.clock();
	while (terminalCount > 0) {
		const oldest = terminalResponseOrder[terminalHead];
		if (oldest === undefined || oldest.expiresAt > now) break;
		terminalResponseIds.delete(oldest.requestId);
		terminalResponseOrder[terminalHead] = undefined;
		terminalHead = (terminalHead + 1) % MAX_TERMINAL_RESPONSES;
		terminalCount--;
	}
}

function rememberTerminalResponse(requestId: string): void {
	pruneTerminalResponses();
	if (terminalResponseIds.has(requestId)) return;
	// Admission reserves this tombstone before any side effects can execute.
	terminalResponseOrder[(terminalHead + terminalCount) % MAX_TERMINAL_RESPONSES] = {
		requestId, expiresAt: os.clock() + RESPONSE_RETENTION_SECONDS,
	};
	terminalCount++;
	terminalResponseIds.add(requestId);
}

function settleResponse(requestId: string, entry: PendingResponse, disposition: string): void {
	if (pendingResponses.get(requestId) !== entry) return;
	pendingResponses.delete(requestId);
	if (entry.admissionRejection) pendingRejectionCount--;
	else pendingResponseBytes -= entry.body.size();
	if (entry.ackTimer !== undefined) task.cancel(entry.ackTimer);
	if (entry.expiryTimer !== undefined) task.cancel(entry.expiryTimer);
	entry.ackTimer = undefined;
	entry.expiryTimer = undefined;
	// Release a queued native frame before making its capacity available again.
	if (disposition === "expired" && socketOpen && entry.sentGeneration === generation) {
		scheduleReconnect(generation, `WebSocket response ${requestId} expired without acknowledgement`);
	}
	entry.body = "";
	rememberTerminalResponse(requestId);
	if (disposition === "unknown" || disposition === "expired") {
		warn(`[robloxstudio-mcp] Response ${requestId} outcome unknown (${disposition}); stored result released, mutation must not be replayed`);
	}
}

function sendProgress(requestId: string, progress: RequestProgress): void {
	const client = socketClient;
	if (!active || !socketOpen || client === undefined || options?.serverUrl !== progress.serverUrl || progress.phase === undefined) return;
	if (progress.sentGeneration === generation && progress.sentPhase === progress.phase) return;
	const expectedGeneration = generation;
	progress.sentGeneration = expectedGeneration;
	progress.sentPhase = progress.phase;
	const [sent] = pcall(() => client.Send(HttpService.JSONEncode({
		kind: "progress", requestId, phase: progress.phase, outcome: progress.outcome,
	})));
	if (!sent) scheduleReconnect(expectedGeneration, "WebSocket progress send failed; current observation retained for reconnect");
}

function completeProgress(requestId: string, progress: RequestProgress, outcome: StudioExecutionOutcome): void {
	progress.phase = "response_delivery";
	progress.outcome = outcome;
	sendProgress(requestId, progress);
}

function handlerOutcome(response: unknown): StudioExecutionOutcome {
	if (!typeIs(response, "table")) return "success";
	const result = response as Record<string, unknown>;
	if (result.error !== undefined || result.success === false || result.ok === false) return "error";
	if (typeIs(result.summary, "table")) {
		const summary = result.summary as Record<string, unknown>;
		if (typeIs(summary.failed, "number") && summary.failed > 0) return "error";
	}
	return "success";
}

function sendPendingResponse(requestId: string, entry: PendingResponse): void {
	sendProgress(requestId, entry.progress);
	const client = socketClient;
	if (!active || !socketOpen || client === undefined || options?.serverUrl !== entry.serverUrl || pendingResponses.get(requestId) !== entry) return;
	if (os.clock() >= entry.expiresAt) {
		settleResponse(requestId, entry, "expired");
		return;
	}
	if (entry.sentGeneration === generation) return;
	const expectedGeneration = generation;
	entry.sentGeneration = expectedGeneration;
	const [sendOk, sendError] = pcall(() => client.Send(entry.body));
	if (!sendOk) {
		warn(`[robloxstudio-mcp] WebSocket response send failed for ${requestId} (${entry.body.size()} bytes, stage=socket_send): ${tostring(sendError)}`);
		scheduleReconnect(expectedGeneration, "WebSocket response send failed; retained for reconnect");
		return;
	}
	if (pendingResponses.get(requestId) !== entry || generation !== expectedGeneration || socketClient !== client) return;
	// Send only queues bytes. A heartbeat does not prove that this upload drained.
	// Give large transfers a generous window, growing after reconnect; never put
	// a second copy on the same socket, even when an acknowledgement is lost.
	entry.sendAttempt++;
	const ackDelay = RESPONSE_ACK_TIMEOUT_SECONDS * math.pow(2, math.min(entry.sendAttempt - 1, 2));
	if (os.clock() + ackDelay >= entry.expiresAt) return;
	entry.ackTimer = task.delay(ackDelay, () => {
		entry.ackTimer = undefined;
		if (generation !== expectedGeneration || pendingResponses.get(requestId) !== entry) return;
		scheduleReconnect(expectedGeneration, `WebSocket response ${requestId} acknowledgement timed out; retained for reconnect`);
	});
}

function resumePendingResponses(): void {
	for (const [requestId, entry] of inFlightRequests) sendProgress(requestId, entry.progress);
	for (const [requestId, entry] of pendingResponses) sendPendingResponse(requestId, entry);
}

function encodeError(requestId: string, detail: string, executionOutcome: StudioExecutionOutcome): string {
	const [encodeOk, encoded] = pcall(() => HttpService.JSONEncode({ kind: "response", requestId, executionOutcome, error: `Request ${requestId}: ${detail}` }));
	if (encodeOk && encoded.size() <= RESERVED_ERROR_BYTES) return encoded;
	return HttpService.JSONEncode({
		kind: "response", requestId, executionOutcome,
		error: `Request ${requestId}: Plugin error could not be encoded within its reserved response capacity (stage=error_encode); handler outcome=${executionOutcome}`,
	});
}

function encodeResponse(requestId: string, response: unknown, executionOutcome: StudioExecutionOutcome): string {
	const [encodeOk, encoded] = pcall(() => HttpService.JSONEncode({ kind: "response", requestId, response, executionOutcome }));
	if (!encodeOk) return encodeError(requestId, `Plugin response serialization failed (stage=response_encode): ${tostring(encoded).sub(1, 512)}`, executionOutcome);
	if (encoded.size() > MAX_FRAME_BYTES) {
		return encodeError(requestId, `Plugin response exceeds WebSocket frame limit (stage=response_encode, bytes=${encoded.size()}, maxBytes=${MAX_FRAME_BYTES}); execution completed but result cannot be delivered`, executionOutcome);
	}
	return encoded;
}

function retainResponse(requestId: string, body: string, serverUrl: string, progress: RequestProgress, admissionRejection = false): void {
	// Admission errors have their own bounded 128 x 4KiB reserve so a full-size
	// result never consumes the capacity required to retain a rejection.
	const reservedBytes = (inFlightRequests.size() + pendingResponses.size() - pendingRejectionCount) * RESERVED_ERROR_BYTES;
	if (!admissionRejection && pendingResponseBytes + body.size() + reservedBytes > MAX_PENDING_RESPONSE_BYTES) {
		body = encodeError(requestId, `Plugin response exceeds retained-result capacity (stage=response_retention, bytes=${body.size()}, retainedBytes=${pendingResponseBytes}, maxBytes=${MAX_PENDING_RESPONSE_BYTES}); execution completed but result cannot be retained`, progress.outcome ?? "unknown");
	}
	const entry: PendingResponse = { body, serverUrl, progress, expiresAt: os.clock() + RESPONSE_RETENTION_SECONDS, admissionRejection, sendAttempt: 0 };
	pendingResponses.set(requestId, entry);
	if (admissionRejection) pendingRejectionCount++;
	else pendingResponseBytes += body.size();
	entry.expiryTimer = task.delay(RESPONSE_RETENTION_SECONDS, () => {
		entry.expiryTimer = undefined;
		if (pendingResponses.get(requestId) === entry) settleResponse(requestId, entry, "expired");
	});
	sendPendingResponse(requestId, entry);
}

function rejectAdmission(requestId: string, detail: string): void {
	const currentOptions = options;
	if (currentOptions === undefined) return;
	if (
		pendingRejectionCount >= MAX_ADMISSION_REJECTIONS ||
		terminalCount + inFlightRequests.size() + pendingResponses.size() >= MAX_TERMINAL_RESPONSES
	) {
		// No execution and no unretained "result". Reconnect drains existing
		// outcomes so their acknowledgements can release rejection reservations.
		scheduleReconnect(generation, "Plugin admission rejection reserve exhausted; execution not started");
		return;
	}
	const progress: RequestProgress = { serverUrl: currentOptions.serverUrl };
	completeProgress(requestId, progress, "not_executed");
	retainResponse(requestId, encodeError(requestId, detail, "not_executed"), currentOptions.serverUrl, progress, true);
}

function cancelRequest(event: StudioCancelEvent): void {
	const inFlight = inFlightRequests.get(event.requestId);
	if (inFlight !== undefined) inFlight.cancelled = true;
	// Cancellation only changes execution context. Completed results still need
	// recording, including results produced by already-running side effects.
}

function dispatchRequest(request: StudioRequestEvent, requestBytes: number): void {
	pruneTerminalResponses();
	if (terminalResponseIds.has(request.requestId) || pendingResponses.has(request.requestId) || inFlightRequests.has(request.requestId)) return;
	const dispatchOptions = options;
	if (!active || dispatchOptions === undefined) return;
	const activeCount = inFlightRequests.size() + pendingResponses.size() - pendingRejectionCount;
	if (
		activeCount >= MAX_ACTIVE_RESPONSES || terminalCount + activeCount + MAX_ADMISSION_REJECTIONS >= MAX_TERMINAL_RESPONSES ||
		pendingResponseBytes + (activeCount + 1) * RESERVED_ERROR_BYTES > MAX_PENDING_RESPONSE_BYTES ||
		inFlightRequestBytes + requestBytes > MAX_FRAME_BYTES
	) {
		rejectAdmission(request.requestId, `Plugin request admission capacity exceeded (stage=request_admission, bytes=${requestBytes}, inFlightBytes=${inFlightRequestBytes}, activeResponses=${activeCount}, maxActiveResponses=${MAX_ACTIVE_RESPONSES}, terminalIds=${terminalCount}, maxTerminalIds=${MAX_TERMINAL_RESPONSES}, retainedBytes=${pendingResponseBytes}, maxBytes=${MAX_PENDING_RESPONSE_BYTES}); execution not started`);
		return;
	}
	const inFlight: InFlightRequest = { cancelled: false, progress: { serverUrl: dispatchOptions.serverUrl } };
	const context: StudioRequestContext = {
		requestId: request.requestId,
		deadlineAt: os.clock() + request.remainingMs / 1000,
		isCancelled: () => inFlight.cancelled,
	};
	inFlightRequests.set(request.requestId, inFlight);
	inFlightRequestBytes += requestBytes;
	task.spawn(() => {
		if (inFlight.cancelled || !active || os.clock() >= context.deadlineAt) {
			completeProgress(request.requestId, inFlight.progress, "not_executed");
			inFlightRequests.delete(request.requestId);
			inFlightRequestBytes -= requestBytes;
			retainResponse(request.requestId, encodeError(request.requestId, "Request cancelled or admission deadline expired before execution started", "not_executed"), dispatchOptions.serverUrl, inFlight.progress);
			return;
		}
		// This observes handler entry, including broker dispatch, not a user Luau
		// instruction. The waiter's deadline/cancellation is not a rollback.
		inFlight.progress.phase = "executing";
		sendProgress(request.requestId, inFlight.progress);
		const [dispatchOk, response] = pcall(() => dispatchOptions.dispatchRequest(request, context));
		const executionOutcome = dispatchOk ? handlerOutcome(response) : "error";
		// Report handler return before JSON encoding or result retention can fail.
		completeProgress(request.requestId, inFlight.progress, executionOutcome);
		const body = dispatchOk ? encodeResponse(request.requestId, response, executionOutcome)
			: encodeError(request.requestId, `Plugin request execution failed: ${tostring(response).sub(1, 512)}`, executionOutcome);
		inFlightRequests.delete(request.requestId);
		inFlightRequestBytes -= requestBytes;
		retainResponse(request.requestId, body, dispatchOptions.serverUrl, inFlight.progress);
	});
}

function invokeCallback(name: string, callback: () => void): void {
	const [callbackOk, callbackError] = pcall(callback);
	if (!callbackOk) warn(`[robloxstudio-mcp] ${name} callback failed: ${tostring(callbackError)}`);
}

function reportTransport(update: TransportUpdate): void {
	const currentOptions = options;
	if (active && currentOptions !== undefined) invokeCallback("WebSocket transport", () => currentOptions.onTransportUpdate(update));
}

function scheduleReconnect(expectedGeneration: number, detail: string, duplicate = false): void {
	if (!active || generation !== expectedGeneration) return;
	generation++;
	closeCurrentSocket();
	reconnectAttempt++;
	const delay = duplicate ? 1 : retryDelay(reconnectAttempt);
	reportTransport({ state: duplicate ? "waiting-duplicate" : "retrying", attempt: reconnectAttempt, retryDelay: delay, detail });
	const nextGeneration = generation;
	task.delay(delay, () => {
		if (active && generation === nextGeneration) connect(nextGeneration);
	});
}

function watchForSilence(expectedGeneration: number, expectedClient: WebStreamClient): void {
	const elapsed = tick() - lastValidEventAt;
	task.delay(math.max(SOCKET_SILENCE_TIMEOUT_SECONDS - elapsed, 0.1), () => {
		if (!active || generation !== expectedGeneration || socketClient !== expectedClient) return;
		const silentFor = tick() - lastValidEventAt;
		if (silentFor >= SOCKET_SILENCE_TIMEOUT_SECONDS) {
			scheduleReconnect(expectedGeneration, `WebSocket silent for ${math.floor(silentFor)} seconds`);
			return;
		}
		watchForSilence(expectedGeneration, expectedClient);
	});
}

function parseReadyResponse(body: string): ReadyResponse | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(body));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const value = decoded as Record<string, unknown>;
	if (
		value.success !== true || !typeIs(value.assignedRole, "string") || value.assignedRole === "" ||
		!typeIs(value.peerId, "string") || value.peerId === "" || !typeIs(value.instanceId, "string") || value.instanceId === "" ||
		value.protocolVersion !== PROTOCOL_VERSION || !typeIs(value.transportToken, "string") || value.transportToken === "" ||
		(value.multiplayerGroupId !== undefined && !typeIs(value.multiplayerGroupId, "string"))
	) return undefined;
	return {
		success: true, assignedRole: value.assignedRole, peerId: value.peerId, instanceId: value.instanceId,
		multiplayerGroupId: value.multiplayerGroupId, protocolVersion: PROTOCOL_VERSION, transportToken: value.transportToken,
	};
}

function registerReady(currentOptions: StudioWebSocketOptions, expectedGeneration: number, reconnectOnFailure: boolean): ReadyResponse | undefined {
	const instanceId = PluginSession.getInstanceId();
	const multiplayerGroupId = PluginSession.getMultiplayerGroupId();
	const transportRole = PluginSession.getRole();
	const readyUrl = `${currentOptions.serverUrl}/ready`;
	const readyPayload = PluginSession.createReadyPayload(PluginSession.peerId, transportRole, instanceId, multiplayerGroupId);
	if (!active || generation !== expectedGeneration || options !== currentOptions) return undefined;
	const [readyOk, readyResult] = pcall(() => HttpService.RequestAsync({
		Url: readyUrl, Method: "POST", Headers: { "Content-Type": "application/json" }, Body: HttpService.JSONEncode(readyPayload),
	}));
	if (!active || generation !== expectedGeneration || options !== currentOptions) return undefined;
	const readyLogKey = `${currentOptions.serverUrl}|${PluginSession.peerId}`;
	if (!readyOk || !readyResult.Success) {
		const detail = readyOk ? HttpDiagnostics.formatRequestFailure(readyUrl, true, readyResult)
			: HttpDiagnostics.formatRequestFailure(readyUrl, false, readyResult);
		if (!readyFailureLogKeys.has(readyLogKey)) {
			readyFailureLogKeys.add(readyLogKey);
			warn(`[robloxstudio-mcp] /ready failed for ${instanceId}/${transportRole}: ${detail}`);
		}
		if (reconnectOnFailure) scheduleReconnect(expectedGeneration, detail, readyOk && readyResult.StatusCode === 409);
		return undefined;
	}
	const readyData = parseReadyResponse(readyResult.Body);
	if (readyData === undefined || readyData.peerId !== PluginSession.peerId || readyData.instanceId !== instanceId || readyData.multiplayerGroupId !== multiplayerGroupId) {
		if (reconnectOnFailure) scheduleReconnect(expectedGeneration, "Invalid /ready response: expected Peer topology and WebSocket protocol credentials");
		return undefined;
	}
	if (readyFailureLogKeys.has(readyLogKey)) {
		readyFailureLogKeys.delete(readyLogKey);
		print(`[robloxstudio-mcp] /ready connected for ${instanceId}/${readyData.assignedRole} via ${currentOptions.serverUrl}`);
	}
	cachedReady = readyData;
	invokeCallback("WebSocket ready", () => currentOptions.onReady(readyData));
	return readyData;
}

function credentialsRejected(statusCode: number): boolean {
	return statusCode === 401 || statusCode === 403 || statusCode === 404;
}

function connect(expectedGeneration: number): void {
	const currentOptions = options;
	if (!active || generation !== expectedGeneration || currentOptions === undefined) return;
	reportTransport({ state: "connecting", attempt: reconnectAttempt, retryDelay: 0 });
	task.spawn(() => {
		const readyData = cachedReady ?? registerReady(currentOptions, expectedGeneration, true);
		if (readyData === undefined || !active || generation !== expectedGeneration || options !== currentOptions) return;
		const [socketBaseUrl] = currentOptions.serverUrl.gsub("^http", "ws");
		const [createOk, createdClient] = pcall(() => HttpService.CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, {
			Url: `${socketBaseUrl}/studio?peerId=${HttpService.UrlEncode(PluginSession.peerId)}&protocolVersion=${PROTOCOL_VERSION}`,
			Headers: { "X-Studio-Token": readyData.transportToken },
		}));
		if (!createOk) {
			scheduleReconnect(expectedGeneration, `Failed to create WebSocket: ${tostring(createdClient)}`);
			return;
		}
		if (!active || generation !== expectedGeneration || options !== currentOptions) {
			pcall(() => createdClient.Close());
			return;
		}
		socketClient = createdClient;
		socketConnections = [
			createdClient.Opened.Connect((statusCode, _headers) => {
				if (!active || generation !== expectedGeneration || socketClient !== createdClient) return;
				if (statusCode !== 101 && (statusCode < 200 || statusCode >= 300)) {
					if (credentialsRejected(statusCode)) cachedReady = undefined;
					scheduleReconnect(expectedGeneration, `WebSocket opened with HTTP ${statusCode}`);
					return;
				}
				socketOpen = true;
				lastValidEventAt = tick();
				reconnectAttempt = 0;
				reportTransport({ state: "open", attempt: 0, retryDelay: 0 });
				resumePendingResponses();
			}),
			createdClient.MessageReceived.Connect((message) => {
				if (!active || generation !== expectedGeneration || socketClient !== createdClient) return;
				if (!typeIs(message, "string")) {
					scheduleReconnect(expectedGeneration, "Unsupported binary WebSocket frame (stage=request_receive); text JSON required");
					return;
				}
				if (message.size() > MAX_FRAME_BYTES) {
					const detail = `WebSocket request frame exceeds limit (stage=request_receive, bytes=${message.size()}, maxBytes=${MAX_FRAME_BYTES}); execution not started`;
					warn(`[robloxstudio-mcp] ${detail}`);
					scheduleReconnect(expectedGeneration, detail);
					return;
				}
				const event = decodeMessage(message);
				if (event === undefined) return;
				lastValidEventAt = tick();
				if (event.kind === "ack") {
					const pending = pendingResponses.get(event.requestId);
					if (pending !== undefined && pending.serverUrl === currentOptions.serverUrl) settleResponse(event.requestId, pending, event.disposition);
				} else if (event.kind === "heartbeat") {
					invokeCallback("WebSocket heartbeat", () => currentOptions.onHeartbeat(event.timestamp));
				} else if (event.kind === "cancel") {
					cancelRequest(event);
				} else if (event.kind === "request") {
					dispatchRequest(event, message.size());
				} else {
					invokeCallback("WebSocket status", () => currentOptions.onStatus(event));
					if (!event.knownPeer) {
						cachedReady = undefined;
						scheduleReconnect(expectedGeneration, "WebSocket session is no longer registered");
					}
				}
			}),
			createdClient.Error.Connect((statusCode, message) => {
				if (!active || generation !== expectedGeneration || socketClient !== createdClient) return;
				if (credentialsRejected(statusCode)) cachedReady = undefined;
				scheduleReconnect(expectedGeneration, `WebSocket error ${statusCode}: ${message}`);
			}),
			createdClient.Closed.Connect(() => {
				if (!active || generation !== expectedGeneration || socketClient !== createdClient) return;
				scheduleReconnect(expectedGeneration, "WebSocket closed");
			}),
		];
		lastValidEventAt = tick();
		watchForSilence(expectedGeneration, createdClient);
	});
}

function start(newOptions: StudioWebSocketOptions): void {
	if (active || shutdownSuspended) stop();
	options = newOptions;
	active = true;
	shutdownSuspended = false;
	reconnectAttempt = 0;
	generation++;
	connect(generation);
}

function refresh(): void {
	const currentOptions = options;
	if (!active || currentOptions === undefined || readyRefreshPending) return;
	// Metadata changes must not close a healthy socket or make its reconnect
	// depend on RequestAsync quota. Proxy registration remains independent.
	readyRefreshPending = true;
	const expectedGeneration = generation;
	task.spawn(() => {
		registerReady(currentOptions, expectedGeneration, false);
		readyRefreshPending = false;
	});
}

// EndTest may tear down this VM without an Unloading callback. Release the
// native socket before yielding to unregister; a failed EndTest can resume.
function suspendForShutdown(): void {
	const currentOptions = options;
	if (!active || currentOptions === undefined) return;
	active = false;
	shutdownSuspended = true;
	generation++;
	reconnectAttempt = 0;
	closeCurrentSocket();
	cachedReady = undefined;
	disconnectSession(currentOptions);
}

function resumeAfterShutdownFailure(): void {
	if (!shutdownSuspended || options === undefined) return;
	shutdownSuspended = false;
	active = true;
	generation++;
	reconnectAttempt = 0;
	connect(generation);
}

function stop(): void {
	if (!active && !shutdownSuspended) return;
	const currentOptions = options;
	active = false;
	shutdownSuspended = false;
	generation++;
	for (const [, inFlight] of inFlightRequests) inFlight.cancelled = true;
	closeCurrentSocket();
	cachedReady = undefined;
	readyFailureLogKeys.clear();
	options = undefined;
	reconnectAttempt = 0;
	if (currentOptions !== undefined) disconnectSession(currentOptions);
}

export = { start, refresh, suspendForShutdown, resumeAfterShutdownFailure, stop };

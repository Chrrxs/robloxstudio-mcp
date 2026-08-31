import { HttpService } from "@rbxts/services";
import HttpDiagnostics from "./HttpDiagnostics";
import PluginSession from "./PluginSession";
import type {
	ReadyResponse,
	StudioCancelEvent,
	StudioRequestContext,
	StudioRequestEvent,
	StudioStatusEvent,
	TransportUpdate,
} from "../types";

const INITIAL_RECONNECT_DELAY_SECONDS = 0.5;
const MAX_RECONNECT_DELAY_SECONDS = 5;
const INITIAL_RESPONSE_RETRY_DELAY_SECONDS = 0.5;
const MAX_RESPONSE_RETRY_DELAY_SECONDS = 5;
const MAX_TERMINAL_RESPONSES = 256;
const STREAM_SILENCE_TIMEOUT_SECONDS = 20;


interface StudioEventStreamOptions {
	serverUrl: string;
	dispatchRequest: (request: StudioRequestEvent, context: StudioRequestContext) => unknown;
	onStatus: (status: StudioStatusEvent) => void;
	onHeartbeat: (timestamp: number) => void;
	onReady: (response: ReadyResponse) => void;
	onTransportUpdate: (update: TransportUpdate) => void;
}

type DecodedEvent =
	| StudioRequestEvent
	| StudioCancelEvent
	| StudioStatusEvent
	| { kind: "heartbeat"; timestamp: number };

type ResponseDisposition = "accepted" | "already_settled" | "unknown";

interface PendingResponse {
	body: string;
	retryAttempt: number;
	posting: boolean;
	retryToken: number;
}

interface InFlightRequest {
	cancelled: boolean;
}

let options: StudioEventStreamOptions | undefined;
let active = false;
let shutdownSuspended = false;
let generation = 0;
let reconnectAttempt = 0;
let streamClient: WebStreamClient | undefined;
let streamConnections: RBXScriptConnection[] = [];
let lastValidEventAt = 0;
const inFlightRequests = new Map<string, InFlightRequest>();
const pendingResponses = new Map<string, PendingResponse>();
const terminalResponseIds = new Set<string>();
const terminalResponseOrder: string[] = [];
const readyFailureLogKeys = new Set<string>();

function decodeMessage(message: string): DecodedEvent | undefined {
	// Studio versions in the supported channel have surfaced either the SSE
	// data payload or the complete single-line `data:` frame. The bridge emits
	// one JSON data line per event, so normalize both forms before decoding.
	let payload = message;
	const normalized = message.gsub("\r\n", "\n")[0].gsub("\r", "\n")[0];
	if (normalized.sub(1, 5) === "data:") {
		payload = normalized.sub(6).gsub("^%s+", "")[0].gsub("%s+$", "")[0];
	}
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(payload));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const envelope = decoded as Record<string, unknown>;

	if (envelope.kind === "heartbeat") {
		if (!typeIs(envelope.timestamp, "number")) return undefined;
		return { kind: "heartbeat", timestamp: envelope.timestamp };
	}

	if (envelope.kind === "status") {
		if (!typeIs(envelope.knownInstance, "boolean") || !typeIs(envelope.mcpConnected, "boolean")) {
			return undefined;
		}
		return {
			kind: "status",
			knownInstance: envelope.knownInstance,
			mcpConnected: envelope.mcpConnected,
			serverVersion: typeIs(envelope.serverVersion, "string") ? envelope.serverVersion : undefined,
			pluginVersion: typeIs(envelope.pluginVersion, "string") ? envelope.pluginVersion : undefined,
			pluginVariant: typeIs(envelope.pluginVariant, "string") ? envelope.pluginVariant : undefined,
		};
	}

	if (envelope.kind === "cancel") {
		if (
			!typeIs(envelope.requestId, "string") ||
			(
				envelope.reason !== "timeout" &&
				envelope.reason !== "aborted" &&
				envelope.reason !== "connection_closed"
			)
		) {
			return undefined;
		}
		return {
			kind: "cancel",
			requestId: envelope.requestId,
			reason: envelope.reason,
		};
	}

	if (envelope.kind === "request") {
		if (
			!typeIs(envelope.requestId, "string") ||
			!typeIs(envelope.logicalSessionId, "string") ||
			!typeIs(envelope.target, "string") ||
			!typeIs(envelope.endpoint, "string") ||
			!typeIs(envelope.remainingMs, "number") ||
			envelope.remainingMs < 0
		) {
			return undefined;
		}
		let data: Record<string, unknown> | undefined;
		if (typeIs(envelope.data, "table")) {
			data = envelope.data as Record<string, unknown>;
		}
		return {
			kind: "request",
			requestId: envelope.requestId,
			logicalSessionId: envelope.logicalSessionId,
			target: envelope.target,
			endpoint: envelope.endpoint,
			data,
			remainingMs: envelope.remainingMs,
		};
	}

	return undefined;
}

function closeCurrentStream(): void {
	const current = streamClient;
	streamClient = undefined;
	for (const connection of streamConnections) {
		connection.Disconnect();
	}
	streamConnections = [];
	if (current !== undefined) {
		pcall(() => current.Close());
	}
}

function disconnectSession(currentOptions: StudioEventStreamOptions): void {
	pcall(() =>
		HttpService.RequestAsync({
			Url: `${currentOptions.serverUrl}/disconnect`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode({ pluginSessionId: PluginSession.id, timestamp: tick() }),
		}),
	);
}

function responseRetryDelay(attempt: number): number {
	return math.min(
		INITIAL_RESPONSE_RETRY_DELAY_SECONDS * math.pow(2, math.max(attempt - 1, 0)),
		MAX_RESPONSE_RETRY_DELAY_SECONDS,
	);
}

function parseResponseDisposition(success: boolean, body: string): ResponseDisposition | undefined {
	const [decodeOk, decoded] = pcall(() => HttpService.JSONDecode(body));
	if (!decodeOk || !typeIs(decoded, "table")) return undefined;
	const acknowledgement = decoded as Record<string, unknown>;
	const disposition = acknowledgement.disposition;
	if (
		disposition === "accepted" ||
		disposition === "already_settled" ||
		disposition === "unknown"
	) {
		return disposition;
	}
	if (success && acknowledgement.success === true && disposition === undefined) {
		return "accepted";
	}
	return undefined;
}

function rememberTerminalResponse(requestId: string): void {
	if (terminalResponseIds.has(requestId)) return;
	terminalResponseIds.add(requestId);
	terminalResponseOrder.push(requestId);
	while (terminalResponseOrder.size() > MAX_TERMINAL_RESPONSES) {
		const oldest = terminalResponseOrder.shift();
		if (oldest !== undefined) terminalResponseIds.delete(oldest);
	}
}

function settleResponse(
	requestId: string,
	entry: PendingResponse,
	disposition: ResponseDisposition,
): void {
	if (pendingResponses.get(requestId) !== entry) return;
	pendingResponses.delete(requestId);
	rememberTerminalResponse(requestId);
	if (disposition === "unknown") {
		warn(
			`[robloxstudio-mcp] Server no longer recognizes response ${requestId}; dropping stored result`,
		);
	}
}

function postPendingResponse(requestId: string, entry: PendingResponse): void {
	const currentOptions = options;
	if (
		!active ||
		currentOptions === undefined ||
		pendingResponses.get(requestId) !== entry ||
		entry.posting
	) {
		return;
	}
	entry.posting = true;
	entry.retryToken++;

	task.spawn(() => {
		if (
			!active ||
			options !== currentOptions ||
			pendingResponses.get(requestId) !== entry
		) {
			entry.posting = false;
			return;
		}
		const responseUrl = `${currentOptions.serverUrl}/response`;
		const [requestOk, requestResult] = pcall(() =>
			HttpService.RequestAsync({
				Url: responseUrl,
				Method: "POST",
				Headers: { "Content-Type": "application/json" },
				Body: entry.body,
			}),
		);
		if (pendingResponses.get(requestId) !== entry) return;
		entry.posting = false;

		let failure: string;
		if (!requestOk) {
			failure = HttpDiagnostics.formatRequestFailure(responseUrl, false, requestResult);
		} else {
			const disposition = parseResponseDisposition(requestResult.Success, requestResult.Body);
			if (disposition !== undefined) {
				settleResponse(requestId, entry, disposition);
				return;
			}
			failure = requestResult.Success
				? "Invalid /response acknowledgement"
				: HttpDiagnostics.formatRequestFailure(responseUrl, true, requestResult);
		}

		warn(`[robloxstudio-mcp] Failed to deliver response ${requestId}: ${failure}`);
		entry.retryAttempt++;
		if (!active || pendingResponses.get(requestId) !== entry) return;
		const retryToken = ++entry.retryToken;
		const delay = responseRetryDelay(entry.retryAttempt);
		task.delay(delay, () => {
			if (
				!active ||
				pendingResponses.get(requestId) !== entry ||
				entry.retryToken !== retryToken
			) {
				return;
			}
			postPendingResponse(requestId, entry);
		});
	});
}

function resumePendingResponses(): void {
	for (const [requestId, entry] of pendingResponses) {
		postPendingResponse(requestId, entry);
	}
}

function encodeResponse(requestId: string, response: unknown): string {
	const [encodeOk, encoded] = pcall(() => HttpService.JSONEncode({ requestId, response }));
	if (encodeOk) return encoded;
	warn(`[robloxstudio-mcp] Failed to serialize response ${requestId}: ${tostring(encoded)}`);
	return HttpService.JSONEncode({
		requestId,
		error: `Plugin response serialization failed: ${tostring(encoded)}`,
	});
}

function cancelRequest(event: StudioCancelEvent): void {
	const inFlight = inFlightRequests.get(event.requestId);
	if (inFlight !== undefined) inFlight.cancelled = true;
	const pending = pendingResponses.get(event.requestId);
	if (pending !== undefined) {
		pending.retryToken++;
		pendingResponses.delete(event.requestId);
	}
	rememberTerminalResponse(event.requestId);
}

function dispatchRequest(request: StudioRequestEvent): void {
	if (
		terminalResponseIds.has(request.requestId) ||
		pendingResponses.has(request.requestId) ||
		inFlightRequests.has(request.requestId)
	) {
		return;
	}
	const dispatchOptions = options;
	if (!active || dispatchOptions === undefined) return;
	const inFlight: InFlightRequest = { cancelled: false };
	const context: StudioRequestContext = {
		requestId: request.requestId,
		deadlineAt: os.clock() + request.remainingMs / 1000,
		isCancelled: () => inFlight.cancelled,
	};
	inFlightRequests.set(request.requestId, inFlight);

	task.spawn(() => {
		if (inFlight.cancelled || terminalResponseIds.has(request.requestId)) {
			if (inFlightRequests.get(request.requestId) === inFlight) {
				inFlightRequests.delete(request.requestId);
			}
			return;
		}
		const [dispatchOk, response] = pcall(() => dispatchOptions.dispatchRequest(request, context));
		if (inFlight.cancelled || terminalResponseIds.has(request.requestId)) {
			if (inFlightRequests.get(request.requestId) === inFlight) {
				inFlightRequests.delete(request.requestId);
			}
			return;
		}
		const responseData = dispatchOk ? response : { error: tostring(response) };
		const entry: PendingResponse = {
			body: encodeResponse(request.requestId, responseData),
			retryAttempt: 0,
			posting: false,
			retryToken: 0,
		};
		pendingResponses.set(request.requestId, entry);
		inFlightRequests.delete(request.requestId);
		postPendingResponse(request.requestId, entry);
	});
}

function invokeCallback(name: string, callback: () => void): void {
	const [callbackOk, callbackError] = pcall(callback);
	if (!callbackOk) {
		warn(`[robloxstudio-mcp] ${name} callback failed: ${tostring(callbackError)}`);
	}
}

function reportTransport(update: TransportUpdate): void {
	const currentOptions = options;
	if (active && currentOptions !== undefined) {
		invokeCallback("event stream transport", () => currentOptions.onTransportUpdate(update));
	}
}

function reconnectDelay(attempt: number): number {
	return math.min(INITIAL_RECONNECT_DELAY_SECONDS * math.pow(2, math.max(attempt - 1, 0)), MAX_RECONNECT_DELAY_SECONDS);
}

function connectAfter(delaySeconds: number, expectedGeneration: number): void {
	task.delay(delaySeconds, () => {
		if (!active || generation !== expectedGeneration) return;
		connect(expectedGeneration);
	});
}

function scheduleReconnect(expectedGeneration: number, detail: string, duplicate = false): void {
	if (!active || generation !== expectedGeneration) return;
	generation++;
	closeCurrentStream();
	reconnectAttempt++;
	const delay = duplicate ? 1 : reconnectDelay(reconnectAttempt);
	reportTransport({
		state: duplicate ? "waiting-duplicate" : "retrying",
		attempt: reconnectAttempt,
		retryDelay: delay,
		detail,
	});
	connectAfter(delay, generation);
}

function watchForSilence(expectedGeneration: number, expectedClient: WebStreamClient): void {
	const elapsed = tick() - lastValidEventAt;
	const delay = math.max(STREAM_SILENCE_TIMEOUT_SECONDS - elapsed, 0.1);
	task.delay(delay, () => {
		if (
			!active ||
			generation !== expectedGeneration ||
			streamClient !== expectedClient
		) {
			return;
		}
		const silentFor = tick() - lastValidEventAt;
		if (silentFor >= STREAM_SILENCE_TIMEOUT_SECONDS) {
			scheduleReconnect(
				expectedGeneration,
				`Event stream silent for ${math.floor(silentFor)} seconds`,
			);
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
		value.success !== true ||
		!typeIs(value.assignedRole, "string") ||
		value.assignedRole === "" ||
		!typeIs(value.instanceId, "string") ||
		value.instanceId === "" ||
		!typeIs(value.serverVersion, "string") ||
		value.serverVersion === ""
	) {
		return undefined;
	}
	return {
		success: true,
		assignedRole: value.assignedRole,
		instanceId: value.instanceId,
		serverVersion: value.serverVersion,
	};
}

function connect(expectedGeneration: number): void {
	const currentOptions = options;
	if (!active || generation !== expectedGeneration || currentOptions === undefined) return;
	reportTransport({ state: "connecting", attempt: reconnectAttempt, retryDelay: 0 });

	task.spawn(() => {
		const instanceId = PluginSession.getInstanceId();
		const readyUrl = `${currentOptions.serverUrl}/ready`;
		const physicalRole = PluginSession.getRole();
		const readyPayload = PluginSession.createReadyPayload(PluginSession.id, physicalRole);
		readyPayload.pluginReady = true;
		if (!active || generation !== expectedGeneration || options !== currentOptions) return;
		const [readyOk, readyResult] = pcall(() =>
			HttpService.RequestAsync({
				Url: readyUrl,
				Method: "POST",
				Headers: { "Content-Type": "application/json" },
				Body: HttpService.JSONEncode(readyPayload),
			}),
		);
		if (!active || generation !== expectedGeneration || options !== currentOptions) return;

		const readyLogKey = `${currentOptions.serverUrl}|${instanceId}|${physicalRole}`;
		if (!readyOk) {
			const detail = HttpDiagnostics.formatRequestFailure(readyUrl, false, readyResult);
			if (!readyFailureLogKeys.has(readyLogKey)) {
				readyFailureLogKeys.add(readyLogKey);
				warn(`[robloxstudio-mcp] /ready failed for ${instanceId}/${physicalRole}: ${detail}`);
			}
			scheduleReconnect(expectedGeneration, detail);
			return;
		}
		if (!readyResult.Success) {
			const detail = HttpDiagnostics.formatRequestFailure(readyUrl, true, readyResult);
			if (!readyFailureLogKeys.has(readyLogKey)) {
				readyFailureLogKeys.add(readyLogKey);
				warn(`[robloxstudio-mcp] /ready rejected for ${instanceId}/${physicalRole}: ${detail}`);
			}
			scheduleReconnect(expectedGeneration, detail, readyResult.StatusCode === 409);
			return;
		}

		const readyData = parseReadyResponse(readyResult.Body);
		if (readyData === undefined) {
			scheduleReconnect(
				expectedGeneration,
				"Invalid /ready response: expected the bundled server protocol",
			);
			return;
		}
		if (readyFailureLogKeys.has(readyLogKey)) {
			readyFailureLogKeys.delete(readyLogKey);
			print(
				`[robloxstudio-mcp] /ready connected for ${instanceId}/${readyData.assignedRole} via ${currentOptions.serverUrl}`,
			);
		}
		invokeCallback(
			"event stream ready",
			() => currentOptions.onReady(readyData),
		);

		const [createOk, createdClient] = pcall(() =>
			HttpService.CreateWebStreamClient(Enum.WebStreamClientType.SSE, {
				Url: `${currentOptions.serverUrl}/events?pluginSessionId=${PluginSession.id}`,
				Method: "GET",
				Headers: { Accept: "text/event-stream" },
			}),
		);
		if (!createOk) {
			scheduleReconnect(expectedGeneration, `Failed to create event stream: ${tostring(createdClient)}`);
			return;
		}
		if (!active || generation !== expectedGeneration || options !== currentOptions) {
			pcall(() => createdClient.Close());
			return;
		}

		streamClient = createdClient;
		streamConnections = [
			createdClient.Opened.Connect((statusCode, _headers) => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				lastValidEventAt = tick();
				if (statusCode < 200 || statusCode >= 300) {
					scheduleReconnect(expectedGeneration, `Event stream opened with HTTP ${statusCode}`);
					return;
				}
				reconnectAttempt = 0;
				reportTransport({ state: "open", attempt: 0, retryDelay: 0 });
				resumePendingResponses();
			}),
			createdClient.MessageReceived.Connect((message) => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				const event = decodeMessage(message);
				if (event === undefined) return;
				lastValidEventAt = tick();
				if (event.kind === "heartbeat") {
					invokeCallback(
						"event stream heartbeat",
						() => currentOptions.onHeartbeat(event.timestamp),
					);
					return;
				}
				if (event.kind === "cancel") {
					cancelRequest(event);
					return;
				}
				if (event.kind === "request") {
					dispatchRequest(event);
					return;
				}
				invokeCallback("event stream status", () => currentOptions.onStatus(event));
				if (!event.knownInstance) refresh();
			}),
			createdClient.Error.Connect((statusCode, message) => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				const detail = statusCode === 404
					? `Event stream session is not registered: ${message}`
					: `Event stream error ${statusCode}: ${message}`;
				scheduleReconnect(expectedGeneration, detail);
			}),
			createdClient.Closed.Connect(() => {
				if (!active || generation !== expectedGeneration || streamClient !== createdClient) return;
				scheduleReconnect(expectedGeneration, "Event stream closed");
			}),
		];
		lastValidEventAt = tick();
		watchForSilence(expectedGeneration, createdClient);
	});
}

function start(newOptions: StudioEventStreamOptions): void {
	if (active || shutdownSuspended) stop();
	options = newOptions;
	active = true;
	shutdownSuspended = false;
	reconnectAttempt = 0;
	generation++;
	connect(generation);
}

function refresh(): void {
	if (!active || options === undefined) return;
	generation++;
	closeCurrentStream();
	reconnectAttempt = 0;
	connect(generation);
}

// EndTest can tear down a play DataModel without giving Plugin.Unloading a
// usable execution window. Release the native WebStreamClient before the
// yielding unregister request, but retain local request state and connection
// options so a failed EndTest can register again and reconnect.
function suspendForShutdown(): void {
	const currentOptions = options;
	if (!active || currentOptions === undefined) return;
	active = false;
	shutdownSuspended = true;
	generation++;
	reconnectAttempt = 0;
	closeCurrentStream();
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
	for (const [, inFlight] of inFlightRequests) {
		inFlight.cancelled = true;
	}
	inFlightRequests.clear();
	pendingResponses.clear();
	closeCurrentStream();
	readyFailureLogKeys.clear();
	options = undefined;
	reconnectAttempt = 0;
	if (currentOptions !== undefined) {
		disconnectSession(currentOptions);
	}
}

export = {
	start,
	refresh,
	suspendForShutdown,
	resumeAfterShutdownFailure,
	stop,
};

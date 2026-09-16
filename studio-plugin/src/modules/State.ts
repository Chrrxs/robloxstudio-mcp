import type { Connection, TransportUpdate } from "../types";

const CURRENT_VERSION = "__VERSION__";
const PLUGIN_VARIANT = "__PLUGIN_VARIANT__";
const BASE_PORT = 58741;
const SENSITIVE_DIAGNOSTIC_TERMS = ["token", "authorization", "bearer", "password", "cookie", "secret"];

function createConnection(port: number): Connection {
	return {
		port,
		serverUrl: `http://localhost:${port}`,
		isActive: false,
		consecutiveFailures: 0,
		maxFailuresBeforeError: 50,
		currentRetryDelay: 0.5,
		lastHttpOk: false,
		lastMcpOk: false,
		mcpWaitStartTime: undefined,
		heartbeatConnection: undefined,
	};
}

const connection = createConnection(BASE_PORT);

function getActiveConnection(): Connection {
	return connection;
}

function clearTransportDiagnostics(): void {
	connection.transportState = undefined;
	connection.transportAttempt = undefined;
	connection.transportDetail = undefined;
	connection.lastTransportFailure = undefined;
	connection.nextRetryAt = undefined;
}

function sanitizeTransportDetail(detail: string): string {
	// Transport emits credential-free stage descriptions; also defend the UI
	// against accidental raw errors, URLs, markup, and multiline responses.
	const lower = string.lower(detail);
	for (const sensitive of SENSITIVE_DIAGNOSTIC_TERMS) {
		if (string.find(lower, sensitive, 1, true)[0] !== undefined) {
			return "Connection failed (sensitive details hidden).";
		}
	}
	let [plain] = string.gsub(detail, "%w+://%S+", "[address hidden]");
	[plain] = string.gsub(plain, "%c", " ");
	[plain] = string.gsub(plain, "<[^>]*>", "");
	[plain] = string.gsub(plain, "%s+", " ");
	return plain.size() > 180 ? `${string.sub(plain, 1, 177)}...` : plain;
}

function applyTransportUpdate(update: TransportUpdate, now: number): void {
	if (!connection.isActive) return;
	if (update.state === "open") {
		clearTransportDiagnostics();
		connection.lastHttpOk = true;
		connection.lastMcpOk = false;
		connection.consecutiveFailures = 0;
		connection.currentRetryDelay = 0.5;
		connection.mcpWaitStartTime = now;
		return;
	}
	connection.lastHttpOk = false;
	connection.lastMcpOk = false;
	connection.consecutiveFailures = update.attempt;
	connection.mcpWaitStartTime = undefined;
	const previousState = connection.transportState;
	connection.transportState = update.state;
	connection.transportAttempt = update.attempt;
	if (update.detail !== undefined) {
		connection.transportDetail = sanitizeTransportDetail(update.detail);
	} else if (update.state !== "connecting" || previousState !== "connecting") {
		connection.transportDetail = undefined;
	}
	if (update.state === "retrying" || update.state === "waiting-duplicate") {
		connection.lastTransportFailure = connection.transportDetail ?? "Connection attempt failed.";
		connection.currentRetryDelay = update.retryDelay;
		connection.nextRetryAt = now + update.retryDelay;
	} else {
		connection.nextRetryAt = undefined;
	}
}

function getTransportDiagnostics(now: number): { status: string; detail: string } {
	if (!connection.isActive) return { status: "Disconnected", detail: "" };
	if (connection.lastHttpOk) {
		return connection.lastMcpOk
			? { status: "Connected", detail: "Listener: connected  MCP client: connected" }
			: { status: "Waiting for MCP client", detail: "Listener: connected  MCP client: not connected" };
	}
	const attempt = (connection.transportAttempt ?? 0) + 1;
	const failure = connection.lastTransportFailure;
	if (connection.nextRetryAt !== undefined) {
		const remaining = math.max(0, math.ceil((connection.nextRetryAt - now) * 10) / 10);
		return {
			status: connection.transportState === "waiting-duplicate" ? "Waiting for previous instance" : "Listener disconnected",
			detail: `Retry attempt ${attempt} in ${remaining}s\n${failure ?? "Connection attempt failed."}`,
		};
	}
	const stage = connection.transportDetail ?? "Starting listener connection";
	return {
		status: `Connecting (attempt ${attempt})`,
		detail: failure !== undefined ? `${stage}\nLast failure: ${failure}` : stage,
	};
}

export = {
	CURRENT_VERSION,
	PLUGIN_VARIANT,
	BASE_PORT,
	getActiveConnection,
	clearTransportDiagnostics,
	applyTransportUpdate,
	getTransportDiagnostics,
};

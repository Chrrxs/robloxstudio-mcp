import { Connection } from "../types";

const CURRENT_VERSION = "__VERSION__";
const PLUGIN_VARIANT = "__PLUGIN_VARIANT__";
const BASE_PORT = 58741;
const POLL_REQUEST_TIMEOUT_SECONDS = 20;

function createConnection(port: number): Connection {
	return {
		port,
		serverUrl: `http://localhost:${port}`,
		isActive: false,
		pollInterval: 0.5,
		lastPoll: 0,
		consecutiveFailures: 0,
		maxFailuresBeforeError: 50,
		lastSuccessfulConnection: 0,
		currentRetryDelay: 0.5,
		maxRetryDelay: 5,
		retryBackoffMultiplier: 1.2,
		lastHttpOk: false,
		lastMcpOk: false,
		mcpWaitStartTime: undefined,
		isPolling: false,
		heartbeatConnection: undefined,
	};
}

const connection = createConnection(BASE_PORT);

function getActiveConnection(): Connection {
	return connection;
}

export = {
	CURRENT_VERSION,
	PLUGIN_VARIANT,
	BASE_PORT,
	POLL_REQUEST_TIMEOUT_SECONDS,
	getActiveConnection,
};

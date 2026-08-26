import { Connection } from "../types";

const CURRENT_VERSION = "__VERSION__";
const PLUGIN_VARIANT = "__PLUGIN_VARIANT__";
const BASE_PORT = 58741;

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

export = {
	CURRENT_VERSION,
	PLUGIN_VARIANT,
	BASE_PORT,
	getActiveConnection,
};

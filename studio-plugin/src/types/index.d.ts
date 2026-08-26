/// <reference types="@rbxts/types/plugin" />

export interface Connection {
	port: number;
	serverUrl: string;
	isActive: boolean;
	consecutiveFailures: number;
	maxFailuresBeforeError: number;
	currentRetryDelay: number;
	lastHttpOk: boolean;
	lastMcpOk: boolean;
	mcpWaitStartTime?: number;
	heartbeatConnection?: RBXScriptConnection;
}

export interface RequestData {
	[key: string]: unknown;
}

export interface RequestPayload {
	endpoint: string;
	data?: RequestData;
}

export interface ReadyResponse {
	success: true;
	assignedRole: string;
	instanceId: string;
	serverVersion: string;
}

export interface StudioRequestEvent {
	kind: "request";
	requestId: string;
	logicalSessionId: string;
	target: string;
	endpoint: string;
	data?: RequestData;
}

export interface StudioStatusEvent {
	kind: "status";
	knownInstance: boolean;
	mcpConnected: boolean;
	serverVersion?: string;
	pluginVersion?: string;
	pluginVariant?: string;
}

export interface TransportUpdate {
	state: "connecting" | "open" | "retrying" | "waiting-duplicate";
	attempt: number;
	retryDelay: number;
	detail?: string;
}

declare global {
	function loadstring(code: string): LuaTuple<[(() => unknown) | undefined, string?]>;
}

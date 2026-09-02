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
	peerId: string;
	instanceId: string;
	multiplayerGroupId?: string;
}

export type StudioCancellationReason = "timeout" | "aborted" | "connection_closed";

export interface StudioRequestContext {
	requestId: string;
	deadlineAt: number;
	isCancelled: () => boolean;
}

export interface StudioRequestEvent {
	kind: "request";
	requestId: string;
	peerId: string;
	target: string;
	endpoint: string;
	data?: RequestData;
	remainingMs: number;
}

export interface StudioCancelEvent {
	kind: "cancel";
	requestId: string;
	reason: StudioCancellationReason;
}

export interface StudioStatusEvent {
	kind: "status";
	knownPeer: boolean;
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

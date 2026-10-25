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
	transportState?: TransportUpdate["state"];
	transportAttempt?: number;
	transportDetail?: string;
	lastTransportFailure?: string;
	nextRetryAt?: number;
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
	protocolVersion: 1;
	transportToken: string;
}

export type StudioCancellationReason = "timeout" | "aborted" | "connection_closed";

export type StudioExecutionOutcome = "success" | "error" | "not_executed" | "unknown";

export interface StudioProgressEvent {
	kind: "progress";
	requestId: string;
	phase: "executing" | "response_delivery";
	outcome?: StudioExecutionOutcome;
}

export interface StudioRequestContext {
	requestId: string;
	deadlineAt: number;
	isCancelled: () => boolean;
	// Trusted dispatch observation, never inferred from arbitrary response fields.
	// A broker can end its local wait without observing remote completion.
	executionOutcome?: "unknown" | "not_executed";
}

// Members are function properties, not methods, so plain functions such as
// Utils.getInstancePath can be assigned directly under roblox-ts.
export interface PathTree<T> {
	readonly root: T;
	readonly getParent: (node: T) => T | undefined;
	readonly getChildren: (node: T) => T[];
	readonly getName: (node: T) => string;
	/** The service a root-level segment resolves to, when the segment names one. */
	readonly getService: (segment: string) => T | undefined;
	/** True when node is a root-level service that canonical paths address by class name. */
	readonly isRootService: (node: T) => boolean;
	readonly getPath: (node: T) => string;
}

/** The first path segment that more than one sibling could satisfy. */
export interface PathAmbiguity {
	segment: string;
	parentPath: string;
	matchCount: number;
}

export interface PathResolution<T> {
	instance?: T;
	ambiguity?: PathAmbiguity;
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

export interface StudioAckEvent {
	kind: "ack";
	requestId: string;
	disposition: "accepted" | "already_settled" | "unknown";
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

	// Network simulation properties absent from @rbxts/types.
	interface NetworkSettings {
		InboundNetworkMinDelayMs: number;
		OutboundNetworkMinDelayMs: number;
		InboundNetworkJitterMs: number;
		OutboundNetworkJitterMs: number;
		InboundNetworkLossPercent: number;
		OutboundNetworkLossPercent: number;
	}

	// @rbxts/types gives GlobalSettings no service map, so GetService accepts no name.
	interface GlobalSettings {
		GetService(this: GlobalSettings, className: "NetworkSettings"): NetworkSettings;
	}

	// The read surface of Studio's Device Emulator service, absent from @rbxts/types.
	interface StudioDeviceSimulatorService extends Instance {
		GetDeviceAsync(this: StudioDeviceSimulatorService): string;
		GetDeviceListAsync(this: StudioDeviceSimulatorService): Array<unknown>;
		GetDeviceInfoAsync(this: StudioDeviceSimulatorService, deviceId: string): unknown;
		GetResolutionAsync(this: StudioDeviceSimulatorService): unknown;
		GetPixelDensityAsync(this: StudioDeviceSimulatorService): unknown;
		GetOrientationAsync(this: StudioDeviceSimulatorService): unknown;
		GetScalingModeAsync(this: StudioDeviceSimulatorService): unknown;
	}

	interface Services {
		StudioDeviceSimulatorService: StudioDeviceSimulatorService;
	}
}

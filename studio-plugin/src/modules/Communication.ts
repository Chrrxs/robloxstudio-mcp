import { HttpService, RunService } from "@rbxts/services";
import State from "./State";
import Utils from "./Utils";
import UI from "./UI";
import { cleanupEditBridgeArtifacts } from "./EvalBridges";
import QueryHandlers from "./handlers/QueryHandlers";
import PropertyHandlers from "./handlers/PropertyHandlers";
import ScriptHandlers from "./handlers/ScriptHandlers";
import MetadataHandlers from "./handlers/MetadataHandlers";
import TestHandlers from "./handlers/TestHandlers";
import AssetHandlers from "./handlers/AssetHandlers";
import CaptureHandlers from "./handlers/CaptureHandlers";
import InputHandlers from "./handlers/InputHandlers";
import LogHandlers from "./handlers/LogHandlers";
import SerializationHandlers from "./handlers/SerializationHandlers";
import MemoryHandlers from "./handlers/MemoryHandlers";
import SceneAnalysisHandlers from "./handlers/SceneAnalysisHandlers";
import BreakpointHandlers from "./handlers/BreakpointHandlers";
import ScriptProfilerHandlers from "./handlers/ScriptProfilerHandlers";
import MicroProfilerHandlers from "./handlers/MicroProfilerHandlers";
import GenerateModelHandlers from "./handlers/GenerateModelHandlers";
import EvalRuntimeHandlers from "./handlers/EvalRuntimeHandlers";
import ClientBroker from "./ClientBroker";
import ServerUrlSettings from "./ServerUrlSettings";
import PluginSession from "./PluginSession";
import StudioEventStream from "./StudioEventStream";
import type {
	RequestPayload,
	ReadyResponse,
	StudioRequestContext,
	StudioRequestEvent,
	StudioStatusEvent,
	TransportUpdate,
} from "../types";

let assignedRole: string | undefined;
let lastReadyInstanceId: string | undefined;

const initialRole = PluginSession.getRole();

type Handler = (data: Record<string, unknown>, context: StudioRequestContext) => unknown;

const routeMap: Record<string, Handler> = {

    "/api/file-tree": QueryHandlers.getFileTree,
    "/api/search-files": QueryHandlers.searchFiles,
    "/api/place-info": QueryHandlers.getPlaceInfo,
    "/api/search-objects": QueryHandlers.searchObjects,
    "/api/instance-properties": QueryHandlers.getInstanceProperties,
    "/api/search-by-property": QueryHandlers.searchByProperty,
    "/api/class-info": QueryHandlers.getClassInfo,
    "/api/project-structure": QueryHandlers.getProjectStructure,
    "/api/grep-scripts": QueryHandlers.grepScripts,

    "/api/set-properties": PropertyHandlers.setProperties,

	"/api/get-script-source": ScriptHandlers.getScriptSource,
	"/api/set-script-source": ScriptHandlers.setScriptSource,
	"/api/edit-script-lines": ScriptHandlers.editScriptLines,
	"/api/insert-script-lines": ScriptHandlers.insertScriptLines,
	"/api/delete-script-lines": ScriptHandlers.deleteScriptLines,

	"/api/get-attributes": MetadataHandlers.getAttributes,
	"/api/get-selection": MetadataHandlers.getSelection,
	"/api/set-selection": MetadataHandlers.setSelection,
	"/api/focus-viewport": MetadataHandlers.focusViewport,
	"/api/execute-luau": MetadataHandlers.executeLuau,
	"/api/eval-runtime": EvalRuntimeHandlers.evalRuntime,

	"/api/start-playtest": TestHandlers.startPlaytest,
	"/api/stop-playtest": TestHandlers.stopPlaytest,
	"/api/multiplayer-test-start": TestHandlers.multiplayerTestStart,
	"/api/multiplayer-test-state": TestHandlers.multiplayerTestState,
	"/api/multiplayer-test-add-players": TestHandlers.multiplayerTestAddPlayers,
	"/api/multiplayer-test-leave-client": TestHandlers.multiplayerTestLeaveClient,
	"/api/multiplayer-test-end": TestHandlers.multiplayerTestEnd,

    "/api/insert-asset": AssetHandlers.insertAsset,
	"/api/preview-asset": AssetHandlers.previewAsset,

	"/api/capture-screenshot": CaptureHandlers.captureScreenshot,
	"/api/capture-begin": CaptureHandlers.captureBegin,
	"/api/capture-read": CaptureHandlers.captureRead,
	"/api/simulate-mouse-input": InputHandlers.simulateMouseInput,
	"/api/simulate-keyboard-input": InputHandlers.simulateKeyboardInput,

	"/api/find-and-replace-in-scripts": ScriptHandlers.findAndReplaceInScripts,

	"/api/get-runtime-logs": LogHandlers.getRuntimeLogs,
	"/api/breakpoints": BreakpointHandlers.breakpoints,
	"/api/capture-script-profiler": ScriptProfilerHandlers.captureScriptProfiler,
	"/api/capture-micro-profiler": MicroProfilerHandlers.captureMicroProfiler,
	"/api/generate-model": GenerateModelHandlers.generateModel,

	"/api/export-rbxm": SerializationHandlers.exportRbxm,
	"/api/import-rbxm": SerializationHandlers.importRbxm,

	"/api/get-memory-breakdown": MemoryHandlers.getMemoryBreakdown,
	"/api/get-scene-analysis": SceneAnalysisHandlers.getSceneAnalysis,
};

function processRequest(request: RequestPayload, context: StudioRequestContext): unknown {
	const endpoint = request.endpoint;
	const data = request.data ?? {};

	const handler = routeMap[endpoint];
	if (handler) {
		return handler(data as Record<string, unknown>, context);
	} else {
		return { error: `Unknown endpoint: ${endpoint}` };
	}
}

function getConnectionStatus(): string {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return "disconnected";
	if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) return "error";
	if (conn.lastHttpOk) return "connected";
	return "connecting";
}

function dispatchStreamRequest(request: StudioRequestEvent, context: StudioRequestContext): unknown {
	if (request.logicalSessionId !== PluginSession.id) {
		return ClientBroker.dispatchClientRequest(
			request.logicalSessionId,
			request.target,
			request.endpoint,
			request.data,
		);
	}
	const localRole = assignedRole ?? PluginSession.getRole();
	if (request.target !== localRole) {
		return {
			error: `Physical plugin session is registered as ${localRole}, not ${request.target}.`,
		};
	}
	return processRequest({ endpoint: request.endpoint, data: request.data }, context);
}

function handleReady(response: ReadyResponse): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	assignedRole = response.assignedRole;
	lastReadyInstanceId = response.instanceId;
	ServerUrlSettings.rememberServerUrl(conn.serverUrl);
	ClientBroker.refreshAllLogicalRegistrations();
}

function handleStatus(status: StudioStatusEvent): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	conn.lastHttpOk = true;
	conn.lastMcpOk = status.mcpConnected;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	if (status.mcpConnected) {
		conn.mcpWaitStartTime = undefined;
	} else if (conn.mcpWaitStartTime === undefined) {
		conn.mcpWaitStartTime = tick();
	}


	UI.updateUIState();
	UI.updateToolbarIcon();
}

function handleHeartbeat(_timestamp: number): void {
	if (!State.getActiveConnection().isActive) return;
	UI.updateUIState();
}

function handleTransportUpdate(update: TransportUpdate): void {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;

	if (update.state === "open") {
		conn.lastHttpOk = true;
		conn.lastMcpOk = false;
		conn.consecutiveFailures = 0;
		conn.currentRetryDelay = 0.5;
		conn.mcpWaitStartTime = tick();
	} else {
		conn.lastHttpOk = false;
		conn.lastMcpOk = false;
		conn.consecutiveFailures = update.attempt;
		if (update.retryDelay > 0) conn.currentRetryDelay = update.retryDelay;
		conn.mcpWaitStartTime = undefined;
	}

	UI.updateUIState();
	UI.updateToolbarIcon();
	if (update.state === "waiting-duplicate") {
		const ui = UI.getElements();
		ui.statusLabel.Text = "Waiting for previous instance";
		ui.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
		ui.detailStatusLabel.Text = update.detail ?? "The previous plugin instance is still active.";
		ui.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
	}
}

let nameChangeConn: RBXScriptConnection | undefined;
let placeIdChangeConn: RBXScriptConnection | undefined;

function ensureIdentityWatchers(): void {
	if (!nameChangeConn) {
		const [signalOk, signal] = pcall(() => game.GetPropertyChangedSignal("Name"));
		if (signalOk && signal) {
			nameChangeConn = signal.Connect(() => StudioEventStream.refresh());
		}
	}
	if (!placeIdChangeConn) {
		const [signalOk, signal] = pcall(() => game.GetPropertyChangedSignal("PlaceId"));
		if (signalOk && signal) {
			placeIdChangeConn = signal.Connect(() => {
				PluginSession.invalidatePlaceName();
				lastReadyInstanceId = PluginSession.getInstanceId();
				StudioEventStream.refresh();
			});
		}
	}
}

function disconnectIdentityWatchers(): void {
	if (nameChangeConn) {
		nameChangeConn.Disconnect();
		nameChangeConn = undefined;
	}
	if (placeIdChangeConn) {
		placeIdChangeConn.Disconnect();
		placeIdChangeConn = undefined;
	}
}


function activatePlugin() {
	const conn = State.getActiveConnection();
	if (conn.isActive) return;
	const ui = UI.getElements();

	conn.isActive = true;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	conn.lastHttpOk = false;
	conn.lastMcpOk = false;
	conn.mcpWaitStartTime = undefined;

	const normalizedUrl = ServerUrlSettings.normalizeServerUrl(ui.urlInput.Text);
	conn.serverUrl = normalizedUrl !== "" ? normalizedUrl : conn.serverUrl;
	if (conn.serverUrl === "") conn.serverUrl = ClientBroker.DEFAULT_MCP_URL;
	ui.urlInput.Text = conn.serverUrl;
	const port = ServerUrlSettings.extractPort(conn.serverUrl);
	if (port !== undefined) conn.port = port;
	ClientBroker.setServerUrl(conn.serverUrl);
	lastReadyInstanceId = PluginSession.getInstanceId();
	UI.updateUIState();

	StudioEventStream.start({
		serverUrl: conn.serverUrl,
		dispatchRequest: dispatchStreamRequest,
		onStatus: handleStatus,
		onHeartbeat: handleHeartbeat,
		onReady: handleReady,
		onTransportUpdate: handleTransportUpdate,
	});

	if (!conn.heartbeatConnection) {
		conn.heartbeatConnection = RunService.Heartbeat.Connect(() => {
			if (initialRole === "server" && !RunService.IsRunning()) {
				ClientBroker.disconnectAllProxies();
				deactivatePlugin();
				return;
			}
			const currentInstanceId = PluginSession.getInstanceId();
			if (lastReadyInstanceId !== undefined && currentInstanceId !== lastReadyInstanceId) {
				lastReadyInstanceId = currentInstanceId;
				PluginSession.invalidatePlaceName();
				StudioEventStream.refresh();
			}
		});
	}

	if (!RunService.IsRunning()) {
		task.spawn(cleanupEditBridgeArtifacts);
	}
	ensureIdentityWatchers();
}

function deactivatePlugin() {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	conn.isActive = false;
	conn.lastHttpOk = false;
	conn.lastMcpOk = false;
	conn.mcpWaitStartTime = undefined;

	StudioEventStream.stop();
	disconnectIdentityWatchers();
	if (initialRole === "server") ClientBroker.disconnectAllProxies();
	if (conn.heartbeatConnection) {
		conn.heartbeatConnection.Disconnect();
		conn.heartbeatConnection = undefined;
	}

	lastReadyInstanceId = undefined;
	assignedRole = undefined;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
	UI.updateUIState();
}

function deactivateAll() {
	const conn = State.getActiveConnection();
	if (conn.isActive) {
		deactivatePlugin();
	}
}

function checkForUpdates() {
	task.spawn(() => {
		const [success, result] = pcall(() => {
			return HttpService.RequestAsync({
				Url: "https://registry.npmjs.org/@chrrxs/robloxstudio-mcp/latest",
				Method: "GET",
				Headers: { Accept: "application/json" },
			});
		});

		if (success && result.Success) {
			const [ok, data] = pcall(() => HttpService.JSONDecode(result.Body) as { version?: string });
			if (ok && data?.version) {
				const latestVersion = data.version;
				if (Utils.compareVersions(State.CURRENT_VERSION, latestVersion) < 0) {
					UI.showBanner("update", `v${latestVersion} available - github.com/chrrxs/robloxstudio-mcp`);
				}
			}
		}
	});
}

export = {
	getConnectionStatus,
	activatePlugin,
	deactivatePlugin,
	deactivateAll,
	checkForUpdates,
};

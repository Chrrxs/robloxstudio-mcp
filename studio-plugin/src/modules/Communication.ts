import { HttpService, RunService, ServerStorage } from "@rbxts/services";
import State from "./State";
import Utils from "./Utils";
import UI from "./UI";
import { cleanupLegacyEditBridges } from "./EvalBridges";
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
import HttpDiagnostics from "./HttpDiagnostics";
import { Connection, RequestPayload, PollResponse, ReadyResponse } from "../types";

// Per-plugin-load random GUID. Used as the /poll URL param so the server
// can tell our polls apart from any other plugin's polls. Not user-facing —
// MCP tools and the LLM operate on instanceId (the place identifier).
const pluginSessionId = HttpService.GenerateGUID(false);

// Place-level identifier shared by every plugin running in DataModels of
// the same place file (edit DM + playtest server DM + playtest clients).
// Format: "place:<PlaceId>" when published, "anon:<UUID>" for unpublished
// places where the UUID lives on ServerStorage's __MCPPlaceId attribute
// and travels with the .rbxl.
const MCP_PLACE_ID_ATTRIBUTE = "__MCPPlaceId";

function computeInstanceId(): string {
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	const existing = ServerStorage.GetAttribute(MCP_PLACE_ID_ATTRIBUTE);
	if (typeIs(existing, "string") && existing !== "") {
		return `anon:${existing as string}`;
	}
	const fresh = HttpService.GenerateGUID(false);
	pcall(() => ServerStorage.SetAttribute(MCP_PLACE_ID_ATTRIBUTE, fresh));
	return `anon:${fresh}`;
}

let assignedRole: string | undefined;
let hasVersionMismatch = false;
let lastVersionMismatchWarningKey: string | undefined;
let lastReadyInstanceId: string | undefined;
const readyFailureLogKeys = new Set<string>();
let retryingDuplicateReady = false;

// Cache the published place name from MarketplaceService:GetProductInfo so
// /ready can carry a friendly identifier (e.g. "Natural Disasters") distinct
// from game.Name (the DataModel name, often "Place1" in edit). We only fetch
// once per plugin load; the published name doesn't change mid-session.
let cachedPlaceName: string | undefined;
let cachedPlaceNamePlaceId: number | undefined;

function resolvePlaceName(): string {
	if (cachedPlaceName !== undefined && cachedPlaceNamePlaceId === game.PlaceId) return cachedPlaceName;
	cachedPlaceName = undefined;
	cachedPlaceNamePlaceId = game.PlaceId;
	if (game.PlaceId === 0) {
		cachedPlaceName = game.Name;
		return cachedPlaceName;
	}
	const MarketplaceService = game.GetService("MarketplaceService");
	const [ok, info] = pcall(() => MarketplaceService.GetProductInfo(game.PlaceId));
	if (ok && info !== undefined) {
		const name = (info as { Name?: string }).Name;
		if (typeIs(name, "string") && name !== "") {
			cachedPlaceName = name;
			return cachedPlaceName;
		}
	}
	// Don't cache failures — could be transient (offline, rate-limited).
	// Next /ready will retry. Return game.Name as fallback.
	return game.Name;
}

function detectRole(): string {
	if (!RunService.IsRunning()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
}

const initialRole = detectRole();

type Handler = (data: Record<string, unknown>) => unknown;

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

function processRequest(request: RequestPayload): unknown {
	const endpoint = request.endpoint;
	const data = request.data ?? {};

	const handler = routeMap[endpoint];
	if (handler) {
		return handler(data as Record<string, unknown>);
	} else {
		return { error: `Unknown endpoint: ${endpoint}` };
	}
}

function sendResponse(conn: Connection, requestId: string, responseData: unknown) {
	const responseUrl = `${conn.serverUrl}/response`;
	const [encodeOk, encoded] = pcall(() => HttpService.JSONEncode({ requestId, response: responseData }));
	const body = encodeOk
		? encoded
		: HttpService.JSONEncode({
			requestId,
			error: `Plugin response serialization failed: ${tostring(encoded)}`,
		});
	if (!encodeOk) {
		warn(`[robloxstudio-mcp] Failed to serialize response ${requestId}: ${tostring(encoded)}`);
	}

	const [requestOk, requestResult] = pcall(() => HttpService.RequestAsync({
		Url: responseUrl,
		Method: "POST",
		Headers: { "Content-Type": "application/json" },
		Body: body,
	}));
	if (!requestOk || !requestResult.Success) {
		warn(`[robloxstudio-mcp] Failed to deliver response ${requestId}: ${HttpDiagnostics.formatRequestFailure(responseUrl, requestOk, requestResult)}`);
	}
}

function getConnectionStatus(): string {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return "disconnected";
	if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) return "error";
	if (conn.lastHttpOk) return "connected";
	return "connecting";
}

// Throttle for re-issuing /ready after the server reports knownInstance=false.
// Without this, every poll during the brief window where the server has just
// restarted but hasn't seen our re-ready yet would fire a duplicate /ready.
let lastReadyPostAt = 0;

// game.Name and game.PlaceId can both settle after plugin load. PlaceId also
// changes when an unpublished file is published while MCP is already active.
// Re-fire /ready so the bridge can migrate anon:<uuid> to place:<PlaceId>.
let nameChangeConn: RBXScriptConnection | undefined;
let placeIdChangeConn: RBXScriptConnection | undefined;
function ensureIdentityWatcher(conn: Connection): void {
	if (!nameChangeConn) {
		const [okSig, signal] = pcall(() => game.GetPropertyChangedSignal("Name"));
		if (okSig && signal) {
			nameChangeConn = signal.Connect(() => {
				// sendReady has its own 2s throttle, so rapid burst changes coalesce.
				sendReady(conn);
			});
		}
	}
	if (!placeIdChangeConn) {
		const [okSig, signal] = pcall(() => game.GetPropertyChangedSignal("PlaceId"));
		if (okSig && signal) {
			placeIdChangeConn = signal.Connect(() => {
				cachedPlaceName = undefined;
				cachedPlaceNamePlaceId = undefined;
				sendReady(conn);
			});
		}
	}
}

function sendReady(conn: Connection): void {
	const now = tick();
	// Normal identity refreshes stay conservatively throttled. Once a stale
	// predecessor causes 409, retry once per second so takeover follows the
	// server's short inactivity lease without another two seconds of jitter.
	const readyInterval = retryingDuplicateReady ? 1 : 2;
	if (now - lastReadyPostAt < readyInterval) return;
	lastReadyPostAt = now;
	const instanceId = computeInstanceId();
	task.spawn(() => {
		const [readyOk, readyResult] = pcall(() => {
			return HttpService.RequestAsync({
				Url: `${conn.serverUrl}/ready`,
				Method: "POST",
				Headers: { "Content-Type": "application/json" },
				Body: HttpService.JSONEncode({
					pluginSessionId,
					instanceId,
					role: detectRole(),
					placeId: game.PlaceId,
					placeName: resolvePlaceName(),
					dataModelName: game.Name,
					isRunning: RunService.IsRunning(),
					pluginVersion: State.CURRENT_VERSION,
					pluginVariant: State.PLUGIN_VARIANT,
					pluginReady: true,
					timestamp: tick(),
				}),
			});
		});
		const readyUrl = `${conn.serverUrl}/ready`;
		const readyRole = detectRole();
		const readyLogKey = `${conn.serverUrl}|${instanceId}|${readyRole}`;
		if (!readyOk) {
			const shouldLog = !readyFailureLogKeys.has(readyLogKey);
			readyFailureLogKeys.add(readyLogKey);
			if (shouldLog) {
				warn(`[robloxstudio-mcp] /ready failed for ${instanceId}/${readyRole}: ${HttpDiagnostics.formatRequestFailure(readyUrl, readyOk, readyResult)}`);
			}
			return;
		}
		if (!readyResult.Success) {
			const reason = HttpDiagnostics.formatRequestFailure(readyUrl, true, readyResult);
			const shouldLog = !readyFailureLogKeys.has(readyLogKey);
			readyFailureLogKeys.add(readyLogKey);
			// A predecessor can remain registered briefly when Studio exits before
			// its asynchronous /disconnect completes. Keep polling and retrying
			// /ready: the server will take us over once the predecessor has stopped
			// polling, while a genuinely active duplicate continues to hold routing.
			if (readyResult.StatusCode === 409) {
				retryingDuplicateReady = true;
				const ui = UI.getElements();
				ui.statusLabel.Text = "Waiting for previous instance";
				ui.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				ui.detailStatusLabel.Text = reason;
				ui.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
				if (shouldLog) {
					warn(`[robloxstudio-mcp] /ready rejected for ${instanceId}/${readyRole}: ${reason}`);
				}
				return;
			}
			if (shouldLog) {
				warn(`[robloxstudio-mcp] /ready rejected for ${instanceId}/${readyRole}: ${reason}`);
			}
			return;
		}
		retryingDuplicateReady = false;
		const [parseOk, readyData] = pcall(
			() => HttpService.JSONDecode(readyResult.Body) as ReadyResponse,
		);
		if (parseOk && readyData.assignedRole) {
			assignedRole = readyData.assignedRole;
		}
		lastReadyInstanceId = parseOk && typeIs(readyData.instanceId, "string") && readyData.instanceId !== ""
			? readyData.instanceId
			: instanceId;
		ServerUrlSettings.rememberServerUrl(conn.serverUrl);
		const connectedRole = assignedRole ?? detectRole();
		if (readyFailureLogKeys.has(readyLogKey)) {
			readyFailureLogKeys.delete(readyLogKey);
			print(`[robloxstudio-mcp] /ready connected for ${instanceId}/${connectedRole} via ${conn.serverUrl}`);
		}
	});
}

function pollForRequests() {
	const conn = State.getActiveConnection();
	if (!conn.isActive) return;
	if (conn.isPolling) return;

	conn.isPolling = true;

	const [success, result] = pcall(() => {
		return HttpService.RequestAsync({
			Url: `${conn.serverUrl}/poll?pluginSessionId=${pluginSessionId}`,
			Method: "GET",
			Headers: { "Content-Type": "application/json" },
		});
	});

	conn.isPolling = false;

	const ui = UI.getElements();
	UI.updateToolbarIcon();

	if (success && (result.Success || result.StatusCode === 503)) {
		conn.consecutiveFailures = 0;
		conn.currentRetryDelay = 0.5;
		conn.lastSuccessfulConnection = tick();

		const data = HttpService.JSONDecode(result.Body) as PollResponse;
		const mcpConnected = data.mcpConnected === true;
		conn.lastHttpOk = true;
		conn.lastMcpOk = mcpConnected;
		const serverVersion = data.serverVersion ?? "unknown";
		if (data.versionMismatch === true) {
			hasVersionMismatch = true;
			const warningKey = `${State.CURRENT_VERSION}:${serverVersion}`;
			if (lastVersionMismatchWarningKey !== warningKey) {
				lastVersionMismatchWarningKey = warningKey;
				warn(`[robloxstudio-mcp] Version mismatch: Studio plugin v${State.CURRENT_VERSION} / MCP v${serverVersion}. Run npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin and restart Studio.`);
			}
			UI.showBanner("version-mismatch", `Plugin v${State.CURRENT_VERSION} / MCP v${serverVersion} mismatch`);
		} else if (hasVersionMismatch) {
			hasVersionMismatch = false;
			UI.hideBanner("version-mismatch");
		}

		// Server tells us when its in-memory instances map doesn't have us
		// (e.g. after an MCP process restart). Re-issue /ready immediately so
		// target=server/client-N start routing again. The throttle inside
		// sendReady() prevents duplicate registrations while the server
		// catches up.
		if (data.knownInstance === false) {
			sendReady(conn);
		}

		const el = ui;
		el.step1Dot.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
		el.step1Label.Text = "HTTP server (OK)";

		if (mcpConnected && !el.statusLabel.Text.find("Connected")[0]) {
			el.statusLabel.Text = "Connected";
			el.statusLabel.TextColor3 = Color3.fromRGB(34, 197, 94);
			el.statusIndicator.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
			el.statusPulse.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
			el.statusText.Text = "ONLINE";
			el.detailStatusLabel.Text = "HTTP: OK  MCP: OK";
			el.detailStatusLabel.TextColor3 = Color3.fromRGB(34, 197, 94);
			el.step2Dot.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
			el.step2Label.Text = "MCP bridge (OK)";
			el.step3Dot.BackgroundColor3 = Color3.fromRGB(34, 197, 94);
			el.step3Label.Text = "Commands (OK)";
			conn.mcpWaitStartTime = undefined;
			el.troubleshootLabel.Visible = false;
			UI.stopPulseAnimation();
		} else if (!mcpConnected) {
			el.statusLabel.Text = "Waiting for MCP server";
			el.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
			el.statusIndicator.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.statusPulse.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.statusText.Text = "WAITING";
			el.detailStatusLabel.Text = "HTTP: OK  MCP: ...";
			el.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
			el.step2Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step2Label.Text = "MCP bridge (waiting...)";
			el.step3Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step3Label.Text = "Commands (waiting...)";
			if (conn.mcpWaitStartTime === undefined) {
				conn.mcpWaitStartTime = tick();
			}
			const elapsed = tick() - (conn.mcpWaitStartTime ?? tick());
			el.troubleshootLabel.Visible = elapsed > 8;
			UI.startPulseAnimation();
		}

		if (data.request && mcpConnected) {
			task.spawn(() => {
				const [ok, response] = pcall(() => processRequest(data.request!));
				if (ok) {
					sendResponse(conn, data.requestId!, response);
				} else {
					sendResponse(conn, data.requestId!, { error: tostring(response) });
				}
			});
		}
	} else if (conn.isActive) {
		conn.consecutiveFailures++;

		if (conn.consecutiveFailures > 1) {
			conn.currentRetryDelay = math.min(
				conn.currentRetryDelay * conn.retryBackoffMultiplier,
				conn.maxRetryDelay,
			);
		}


		const el = ui;
		if (conn.consecutiveFailures >= conn.maxFailuresBeforeError) {
			el.statusLabel.Text = "Server unavailable";
			el.statusLabel.TextColor3 = Color3.fromRGB(239, 68, 68);
			el.statusIndicator.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
			el.statusPulse.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
			el.statusText.Text = "ERROR";
			el.detailStatusLabel.Text = "HTTP: X  MCP: X";
			el.detailStatusLabel.TextColor3 = Color3.fromRGB(239, 68, 68);
			el.step1Dot.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
			el.step1Label.Text = "HTTP server (error)";
			el.step2Dot.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
			el.step2Label.Text = "MCP bridge (error)";
			el.step3Dot.BackgroundColor3 = Color3.fromRGB(239, 68, 68);
			el.step3Label.Text = "Commands (error)";
			conn.mcpWaitStartTime = undefined;
			el.troubleshootLabel.Visible = false;
			UI.stopPulseAnimation();
		} else if (conn.consecutiveFailures > 5) {
			const waitTime = math.ceil(conn.currentRetryDelay);
			el.statusLabel.Text = `Retrying (${waitTime}s)`;
			el.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
			el.statusIndicator.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.statusPulse.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.statusText.Text = "RETRY";
			el.detailStatusLabel.Text = "HTTP: ...  MCP: ...";
			el.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
			el.step1Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step1Label.Text = "HTTP server (retrying...)";
			el.step2Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step2Label.Text = "MCP bridge (retrying...)";
			el.step3Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step3Label.Text = "Commands (retrying...)";
			conn.mcpWaitStartTime = undefined;
			el.troubleshootLabel.Visible = false;
			UI.startPulseAnimation();
		} else if (conn.consecutiveFailures > 1) {
			el.statusLabel.Text = `Connecting (attempt ${conn.consecutiveFailures})`;
			el.statusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
			el.statusIndicator.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.statusPulse.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.statusText.Text = "CONNECTING";
			el.detailStatusLabel.Text = "HTTP: ...  MCP: ...";
			el.detailStatusLabel.TextColor3 = Color3.fromRGB(245, 158, 11);
			el.step1Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step1Label.Text = "HTTP server (connecting...)";
			el.step2Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step2Label.Text = "MCP bridge (connecting...)";
			el.step3Dot.BackgroundColor3 = Color3.fromRGB(245, 158, 11);
			el.step3Label.Text = "Commands (connecting...)";
			conn.mcpWaitStartTime = undefined;
			el.troubleshootLabel.Visible = false;
			UI.startPulseAnimation();
		}
	}
}


function activatePlugin() {
	const conn = State.getActiveConnection();
	const ui = UI.getElements();

	conn.isActive = true;
	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;

	const normalizedUrl = ServerUrlSettings.normalizeServerUrl(ui.urlInput.Text);
	conn.serverUrl = normalizedUrl !== "" ? normalizedUrl : conn.serverUrl;
	if (conn.serverUrl === "") conn.serverUrl = ClientBroker.DEFAULT_MCP_URL;
	ui.urlInput.Text = conn.serverUrl;
	const port = ServerUrlSettings.extractPort(conn.serverUrl);
	if (port !== undefined) conn.port = port;
	UI.updateUIState();

	if (!conn.heartbeatConnection) {
		conn.heartbeatConnection = RunService.Heartbeat.Connect(() => {
			const now = tick();
			if (initialRole === "server" && !RunService.IsRunning()) {
				ClientBroker.disconnectAllProxies();
				deactivatePlugin();
				return;
			}
			const currentInstanceId = computeInstanceId();
			if (lastReadyInstanceId !== undefined && currentInstanceId !== lastReadyInstanceId) {
				cachedPlaceName = undefined;
				cachedPlaceNamePlaceId = undefined;
				sendReady(conn);
			}
			const currentInterval = conn.consecutiveFailures > 5 ? conn.currentRetryDelay : conn.pollInterval;
			if (now - conn.lastPoll > currentInterval) {
				conn.lastPoll = now;
				pollForRequests();
			}
		});
	}

	// Initial /ready; pollForRequests will also re-fire ready if the server
	// later reports knownInstance=false (process restart, etc).
	sendReady(conn);

	// Remove legacy edit-mode eval bridge scripts from older plugin builds.
	// Current bridges are created only in running play DataModels.
	if (!RunService.IsRunning()) {
		task.spawn(cleanupLegacyEditBridges);
	}

	// Watch identity fields so stale name or anon instance ids are refreshed.
	ensureIdentityWatcher(conn);
}

function deactivatePlugin() {
	const conn = State.getActiveConnection();
	conn.isActive = false;
	conn.lastMcpOk = false;

	UI.updateUIState();

	pcall(() => {
		HttpService.RequestAsync({
			Url: `${conn.serverUrl}/disconnect`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode({ pluginSessionId, timestamp: tick() }),
		});
	});

	if (conn.heartbeatConnection) {
		conn.heartbeatConnection.Disconnect();
		conn.heartbeatConnection = undefined;
	}

	conn.consecutiveFailures = 0;
	conn.currentRetryDelay = 0.5;
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
					if (!hasVersionMismatch) {
						UI.showBanner("update", `v${latestVersion} available - github.com/chrrxs/robloxstudio-mcp`);
					}
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

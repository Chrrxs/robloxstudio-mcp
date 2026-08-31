import State from "../modules/State";
import UI from "../modules/UI";
import Communication from "../modules/Communication";
import ClientBroker from "../modules/ClientBroker";
import ServerUrlSettings from "../modules/ServerUrlSettings";
import { cleanupEditBridgeArtifacts, ensureRuntimeBridgeInstalled } from "../modules/EvalBridges";
import RuntimeLogBuffer from "../modules/RuntimeLogBuffer";
import StopPlayMonitor from "../modules/StopPlayMonitor";
import StudioEventStream from "../modules/StudioEventStream";
import BreakpointHandlers from "../modules/handlers/BreakpointHandlers";
import * as RenderMonitor from "../modules/RenderMonitor";

// Track render-loop liveness so input/screenshot tools can report "window
// minimized / not rendering" instead of silently no-op'ing. No-op in the
// server DM (RenderStepped can't connect there).
RenderMonitor.start();

// Attach the per-peer LogService.MessageOut listener as early as possible so
// boot-time prints from the user's place scripts are captured. Powers the
// get_runtime_logs MCP tool. Idempotent; safe to call before UI.init().
RuntimeLogBuffer.install();

// Share the plugin reference with the stop-play signaling module so both the
// edit DM (write the flag) and the play-server DM (read+act on the flag) can
// access plugin:SetSetting/GetSetting.
StopPlayMonitor.init(plugin);
BreakpointHandlers.init(plugin);
ServerUrlSettings.init(plugin);

const startupRole = ClientBroker.forkRole();

function applyRememberedServerUrl(): void {
	if (startupRole === "client") return;

	const rememberedServerUrl = ServerUrlSettings.readServerUrl();
	if (rememberedServerUrl === undefined) return;

	const conn = State.getActiveConnection();
	conn.serverUrl = rememberedServerUrl;
	const port = ServerUrlSettings.extractPort(rememberedServerUrl);
	if (port !== undefined) conn.port = port;
	ClientBroker.setServerUrl(rememberedServerUrl);
}

applyRememberedServerUrl();

// Play DataModels do not reliably fire Plugin.Unloading before Studio tears
// down their VM. Close the persistent WebStreamClient while BindToClose still
// gives this server peer a live execution context; otherwise each play cycle
// can retain one native event stream until Studio itself is restarted. The
// transport releases that native stream before yielding to unregister the
// logical server peer.
if (startupRole === "server") {
	game.BindToClose(StudioEventStream.suspendForShutdown);
}

UI.init(plugin);
const elements = UI.getElements();


const ICON_DISCONNECTED = "rbxassetid://__BUTTON_ICON_DISCONNECTED__";
const ICON_CONNECTING = "rbxassetid://__BUTTON_ICON_CONNECTING__";
const ICON_CONNECTED = "rbxassetid://__BUTTON_ICON_CONNECTED__";
const TOOLBAR_REGISTRATION_DELAY_SECONDS = 1;

let toolbarButtonRegistered = false;

function registerToolbarButton() {
	if (toolbarButtonRegistered) {
		return;
	}
	toolbarButtonRegistered = true;

	const toolbar = plugin.CreateToolbar("__TOOLBAR_NAME__");
	const button = toolbar.CreateButton("__BUTTON_TITLE__", "__BUTTON_TOOLTIP__", ICON_DISCONNECTED);
	UI.setToolbarButton(button, { disconnected: ICON_DISCONNECTED, connecting: ICON_CONNECTING, connected: ICON_CONNECTED });

	button.Click.Connect(() => {
		elements.screenGui.Enabled = !elements.screenGui.Enabled;
	});
}


elements.connectButton.Activated.Connect(() => {
	const conn = State.getActiveConnection();
	if (conn && conn.isActive) {
		Communication.deactivatePlugin();
	} else {
		Communication.activatePlugin();
	}
});


plugin.Unloading.Connect(() => {
	Communication.deactivateAll();
});


UI.updateUIState();
Communication.checkForUpdates();
task.delay(TOOLBAR_REGISTRATION_DELAY_SECONDS, registerToolbarButton);

// Auto-activate per peer. The boshyxd plugin only registers with MCP when the
// user clicks Connect in its UI, but that UI is invisible in play DMs - so
// play peers' plugin instances load without ever registering. Run after a
// short delay so the UI/State have a chance to initialize first.
task.delay(2, () => {
	const role = startupRole;
	if (role === "edit") {
		cleanupEditBridgeArtifacts();
	} else {
		const result = ensureRuntimeBridgeInstalled();
		if (!result.installed) {
			warn(`[robloxstudio-mcp] Runtime eval bridge install failed: ${result.error}`);
		}
	}
	if (role === "edit" || role === "server") {
		pcall(() => {
			const conn = State.getActiveConnection();
			if (!conn.isActive) {
				if (role === "server") {
					const inheritedServerUrl = ServerUrlSettings.readServerUrl() ?? ClientBroker.DEFAULT_MCP_URL;
					conn.serverUrl = ServerUrlSettings.normalizeServerUrl(inheritedServerUrl);
					elements.urlInput.Text = conn.serverUrl;
					const port = ServerUrlSettings.extractPort(conn.serverUrl);
					if (port !== undefined) conn.port = port;
					ClientBroker.setServerUrl(conn.serverUrl);
				}
				// Defensive default: in invisible play-DM UIs, the input field
				// may not be populated by the time we activate.
				if (conn.serverUrl === undefined || conn.serverUrl === "") {
					conn.serverUrl = ClientBroker.DEFAULT_MCP_URL;
					elements.urlInput.Text = conn.serverUrl;
				}
				Communication.activatePlugin();
			}
		});
	}
	if (role === "server") {
		ClientBroker.setupServerBroker();
		// The play-server DM is the only one where StudioTestService:EndTest is
		// legal, so the stop-play monitor lives here. It consumes tokenized
		// stop requests from plugin settings and acknowledges EndTest results.
		StopPlayMonitor.startMonitor({
			beforeEndTest: StudioEventStream.suspendForShutdown,
			afterEndTestFailure: StudioEventStream.resumeAfterShutdownFailure,
		});
	} else if (role === "client") {
		ClientBroker.setupClientBroker();
	}
});

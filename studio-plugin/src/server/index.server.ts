import { RunService } from "@rbxts/services";
import State from "../modules/State";
import UI from "../modules/UI";
import Communication from "../modules/Communication";
import ClientBroker from "../modules/ClientBroker";
import ServerUrlSettings from "../modules/ServerUrlSettings";
import { cleanupLegacyEditBridges, ensureRuntimeBridgeInstalled } from "../modules/EvalBridges";
import RuntimeLogBuffer from "../modules/RuntimeLogBuffer";
import StopPlayMonitor from "../modules/StopPlayMonitor";
import { ensureNavCommandListener } from "../modules/NavCommandListener";
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
		Communication.deactivatePlugin(State.getActiveTabIndex());
	} else {
		Communication.activatePlugin(State.getActiveTabIndex());
	}
});


plugin.Unloading.Connect(() => {
	Communication.deactivateAll();
});


UI.updateUIState();
Communication.checkForUpdates();
task.delay(TOOLBAR_REGISTRATION_DELAY_SECONDS, registerToolbarButton);

if (RunService.IsRunning() && RunService.IsServer()) {
	ensureNavCommandListener();
}

// Auto-activate per peer. The boshyxd plugin only registers with MCP when the
// user clicks Connect in its UI, but that UI is invisible in play DMs - so
// play peers' plugin instances load without ever registering. Run after a
// short delay so the UI/State have a chance to initialize first.
task.delay(2, () => {
	const role = ClientBroker.forkRole();
	if (role === "edit") {
		cleanupLegacyEditBridges();
	} else {
		const result = ensureRuntimeBridgeInstalled();
		if (!result.installed) {
			warn(`[robloxstudio-mcp] Runtime eval bridge install failed: ${result.error}`);
		}
	}
	if (role === "edit" || role === "server") {
		pcall(() => {
			const idx = State.getActiveTabIndex();
			const conn = State.getConnection(idx);
			if (conn && !conn.isActive) {
				if (role === "server") {
					const inheritedServerUrl = ServerUrlSettings.readServerUrl() ?? ClientBroker.DEFAULT_MCP_URL;
					conn.serverUrl = inheritedServerUrl;
					elements.urlInput.Text = inheritedServerUrl;
					const [portStr] = conn.serverUrl.match(":(%d+)$");
					if (portStr) conn.port = tonumber(portStr) ?? conn.port;
					ClientBroker.setServerUrl(inheritedServerUrl);
				}
				// Defensive default: in invisible play-DM UIs, the input field
				// may not be populated by the time we activate.
				if (conn.serverUrl === undefined || conn.serverUrl === "") {
					conn.serverUrl = ClientBroker.DEFAULT_MCP_URL;
					elements.urlInput.Text = conn.serverUrl;
				}
				Communication.activatePlugin(idx);
			}
		});
	}
	if (role === "server") {
		ensureNavCommandListener();
		ClientBroker.setupServerBroker();
		// The play-server DM is the only one where StudioTestService:EndTest is
		// legal, so the stop-play monitor lives here. It consumes tokenized
		// stop requests from plugin settings and acknowledges EndTest results.
		StopPlayMonitor.startMonitor();
	} else if (role === "client") {
		ClientBroker.setupClientBroker();
	}
});

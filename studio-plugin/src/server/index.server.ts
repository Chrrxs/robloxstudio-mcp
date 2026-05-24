import State from "../modules/State";
import UI from "../modules/UI";
import Communication from "../modules/Communication";
import ClientBroker from "../modules/ClientBroker";
import RuntimeLogBuffer from "../modules/RuntimeLogBuffer";

// Attach the per-peer LogService.MessageOut listener as early as possible so
// boot-time prints from the user's place scripts are captured. Powers the
// get_runtime_logs MCP tool. Idempotent; safe to call before UI.init().
RuntimeLogBuffer.install();

UI.init(plugin);
const elements = UI.getElements();


const ICON_DISCONNECTED = "rbxassetid://__BUTTON_ICON_DISCONNECTED__";
const ICON_CONNECTING = "rbxassetid://__BUTTON_ICON_CONNECTING__";
const ICON_CONNECTED = "rbxassetid://__BUTTON_ICON_CONNECTED__";

const toolbar = plugin.CreateToolbar("__TOOLBAR_NAME__");
const button = toolbar.CreateButton("__BUTTON_TITLE__", "__BUTTON_TOOLTIP__", ICON_DISCONNECTED);
UI.setToolbarButton(button, { disconnected: ICON_DISCONNECTED, connecting: ICON_CONNECTING, connected: ICON_CONNECTED });


elements.connectButton.Activated.Connect(() => {
	const conn = State.getActiveConnection();
	if (conn && conn.isActive) {
		Communication.deactivatePlugin(State.getActiveTabIndex());
	} else {
		Communication.activatePlugin(State.getActiveTabIndex());
	}
});


button.Click.Connect(() => {
	elements.screenGui.Enabled = !elements.screenGui.Enabled;
});


plugin.Unloading.Connect(() => {
	Communication.deactivateAll();
});


UI.updateUIState();
Communication.checkForUpdates();

// Auto-activate per peer. The boshyxd plugin only registers with MCP when the
// user clicks Connect in its UI, but that UI is invisible in play DMs - so
// play peers' plugin instances load without ever registering. Run after a
// short delay so the UI/State have a chance to initialize first.
task.delay(2, () => {
	const role = ClientBroker.forkRole();
	if (role === "edit" || role === "server") {
		pcall(() => {
			const idx = State.getActiveTabIndex();
			const conn = State.getConnection(idx);
			if (conn && !conn.isActive) {
				// Defensive default: in invisible play-DM UIs, the input field
				// may not be populated by the time we activate.
				if (conn.serverUrl === undefined || conn.serverUrl === "") {
					conn.serverUrl = ClientBroker.MCP_URL;
				}
				Communication.activatePlugin(idx);
			}
		});
	}
	if (role === "server") {
		ClientBroker.setupServerBroker();
	} else if (role === "client") {
		ClientBroker.setupClientBroker();
	}
});

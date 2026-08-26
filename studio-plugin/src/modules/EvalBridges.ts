// Game-VM eval bridges, ported from chrrxs/roblox-mcp-primitives.
//
// Our standard `execute_luau target=server/client-N` runs in the plugin VM
// with a fresh ModuleScript per call. That gives a clean sandbox but means
// `require(SomeModule)` returns a fresh copy, not the one the running game
// scripts hold. So runtime-mutated module state is invisible to probes.
//
// These bridges fix that by living inside the user's game scripts. Both
// peers use the same symmetric shape:
//   - Server: a Script in ServerScriptService that creates a BindableFunction.
//     Plugin (server peer) invokes it with a fresh ModuleScript payload;
//     require() runs inside the Script VM so it shares the running server's
//     require cache.
//   - Client: a LocalScript in StarterPlayer.StarterPlayerScripts that
//     creates a BindableFunction. Plugin invokes it with a fresh ModuleScript
//     payload; require() runs inside the LocalScript VM so it shares the
//     game's require cache.
//
// Why ModuleScript+require on both sides (no loadstring): require'd modules
// run with the security level they were created at and don't need
// ServerScriptService.LoadStringEnabled, so eval_server_runtime works even
// when LoadStringEnabled=false (the default in fresh places).
//
// Lifecycle: bridge scripts are created only in running play DataModels.
// The server plugin peer creates the Script in runtime ServerScriptService;
// each client plugin peer creates its LocalScript in that client's
// PlayerScripts. Nothing is installed into the edit DataModel anymore.
// Runtime-created scripts disappear naturally when the playtest stops.

import { Players, ReplicatedStorage, RunService, ServerScriptService, StarterPlayer } from "@rbxts/services";

const ScriptEditorService = game.GetService("ScriptEditorService");

function getStarterPlayerScripts(): Instance | undefined {
	return StarterPlayer.FindFirstChild("StarterPlayerScripts");
}

const SERVER_SCRIPT_NAME = "__MCP_ServerEvalBridge";
const CLIENT_SCRIPT_NAME = "__MCP_ClientEvalBridge";

// Public so the eval_*_runtime tool wrappers can reference the same names.
export const BRIDGE_NAMES = {
	serverScript: SERVER_SCRIPT_NAME,
	clientScript: CLIENT_SCRIPT_NAME,
	serverLocal: "__MCP_ServerEvalLocal",
	clientLocal: "__MCP_ClientEvalBridge",
} as const;

// Embedded Luau. The double `${...}` references our exported names so a
// rename here propagates to both the script source and the tool wrappers.
const SERVER_BRIDGE_SOURCE = `
-- Installed by @chrrxs/robloxstudio-mcp to power the eval_server_runtime MCP
-- tool (shared-require-cache eval on the server during playtests). Inert
-- outside Studio (no-ops in live games); safe to leave in place.

local ServerScriptService = game:GetService("ServerScriptService")
local RunService = game:GetService("RunService")

if not RunService:IsStudio() then
	return
end

local prevBf = ServerScriptService:FindFirstChild("${BRIDGE_NAMES.serverLocal}")
if prevBf then prevBf:Destroy() end

local bf = Instance.new("BindableFunction")
bf.Name = "${BRIDGE_NAMES.serverLocal}"
bf.Archivable = false
bf.Parent = ServerScriptService
bf.OnInvoke = function(payload)
	if typeof(payload) ~= "Instance" or not payload:IsA("ModuleScript") then
		return { ok = false, value = "payload must be a ModuleScript instance" }
	end
	local ok, value = pcall(require, payload)
	return { ok = ok, value = value }
end
`;

const CLIENT_BRIDGE_SOURCE = `
-- Installed by @chrrxs/robloxstudio-mcp to power the eval_client_runtime MCP
-- tool (shared-require-cache eval on the client during playtests). Inert
-- outside Studio (no-ops in live games); safe to leave in place.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

if not RunService:IsStudio() then
	return
end

local prevBf = ReplicatedStorage:FindFirstChild("${BRIDGE_NAMES.clientLocal}")
if prevBf then prevBf:Destroy() end

local bf = Instance.new("BindableFunction")
bf.Name = "${BRIDGE_NAMES.clientLocal}"
bf.Archivable = false
bf.Parent = ReplicatedStorage
bf.OnInvoke = function(payload)
	if typeof(payload) ~= "Instance" or not payload:IsA("ModuleScript") then
		return { ok = false, value = "payload must be a ModuleScript instance" }
	end
	local ok, value = pcall(require, payload)
	return { ok = ok, value = value }
end
`;

// Stamp written onto each installed bridge Script so we can tell whether the
// runtime bridge currently in the play DM was produced by THIS plugin build.
// It's a djb2 hash of the actual bridge source plus the plugin version, so ANY
// change to the source (or a version bump) yields a new stamp and triggers a
// runtime refresh instead of keeping a stale bridge.
const STAMP_ATTR = "__MCPBridgeStamp";

function computeBridgeStamp(): string {
	const combined = `${SERVER_BRIDGE_SOURCE}|${CLIENT_BRIDGE_SOURCE}`;
	let h = 5381;
	for (let i = 1; i <= combined.size(); i++) {
		h = (h * 33 + string.byte(combined, i)[0]) % 2147483647;
	}
	// "__VERSION__" is replaced with the package version at package time
	// (scripts/build-plugin.mjs injectVersion), so a release bump also restamps.
	return `${tostring(h)}-__VERSION__`;
}

const BRIDGE_STAMP = computeBridgeStamp();

function setSource(scriptInst: Script | LocalScript, source: string): void {
	// ScriptEditorService is the cleaner API and integrates with Studio's
	// edit history; fall back to direct Source mutation (allowed in plugin
	// context with PluginSecurity) if the edit service rejects the call.
	const [seOk] = pcall(() => {
		ScriptEditorService.UpdateSourceAsync(scriptInst, () => source);
	});
	if (!seOk) {
		(scriptInst as unknown as { Source: string }).Source = source;
	}
}

interface InstallResult {
	installed: boolean;
	error?: string;
}

function findEditBridgeArtifacts(): { server?: Instance; client?: Instance } {
	const sps = getStarterPlayerScripts();
	return {
		server: ServerScriptService.FindFirstChild(SERVER_SCRIPT_NAME),
		client: sps ? sps.FindFirstChild(CLIENT_SCRIPT_NAME) : undefined,
	};
}

function destroyIfPresent(parent: Instance, name: string): void {
	const existing = parent.FindFirstChild(name);
	if (existing) {
		pcall(() => existing.Destroy());
	}
}

export function cleanupEditBridgeArtifacts(): void {
	if (RunService.IsRunning()) return;
	const { server, client } = findEditBridgeArtifacts();
	if (server) {
		pcall(() => server.Destroy());
	}
	if (client) {
		pcall(() => client.Destroy());
	}
}

function serverRuntimeBridgeReady(): boolean {
	const scriptInst = ServerScriptService.FindFirstChild(SERVER_SCRIPT_NAME);
	const bindable = ServerScriptService.FindFirstChild(BRIDGE_NAMES.serverLocal);
	return scriptInst !== undefined &&
		scriptInst.GetAttribute(STAMP_ATTR) === BRIDGE_STAMP &&
		bindable !== undefined &&
		bindable.IsA("BindableFunction");
}

function getPlayerScripts(): Instance | undefined {
	const localPlayer = Players.LocalPlayer;
	if (!localPlayer) return undefined;
	let playerScripts = localPlayer.FindFirstChild("PlayerScripts");
	if (!playerScripts) {
		playerScripts = localPlayer.WaitForChild("PlayerScripts", 5);
	}
	return playerScripts;
}

function clientRuntimeBridgeReady(): boolean {
	const playerScripts = getPlayerScripts();
	if (!playerScripts) return false;
	const scriptInst = playerScripts.FindFirstChild(CLIENT_SCRIPT_NAME);
	const bindable = ReplicatedStorage.FindFirstChild(BRIDGE_NAMES.clientLocal);
	return scriptInst !== undefined &&
		scriptInst.GetAttribute(STAMP_ATTR) === BRIDGE_STAMP &&
		bindable !== undefined &&
		bindable.IsA("BindableFunction");
}

function installServerRuntimeBridge(): InstallResult {
	if (serverRuntimeBridgeReady()) return { installed: true };

	const [ok, err] = pcall(() => {
		destroyIfPresent(ServerScriptService, SERVER_SCRIPT_NAME);
		destroyIfPresent(ServerScriptService, BRIDGE_NAMES.serverLocal);

		const serverScript = new Instance("Script");
		serverScript.Name = SERVER_SCRIPT_NAME;
		serverScript.Archivable = false;
		setSource(serverScript, SERVER_BRIDGE_SOURCE);
		serverScript.SetAttribute(STAMP_ATTR, BRIDGE_STAMP);
		serverScript.Parent = ServerScriptService;
	});

	if (!ok) {
		return { installed: false, error: tostring(err) };
	}
	return { installed: true };
}

function installClientRuntimeBridge(): InstallResult {
	if (clientRuntimeBridgeReady()) return { installed: true };

	const playerScripts = getPlayerScripts();
	if (!playerScripts) {
		return { installed: false, error: "Players.LocalPlayer.PlayerScripts not found - cannot install client eval bridge" };
	}

	const [ok, err] = pcall(() => {
		destroyIfPresent(playerScripts, CLIENT_SCRIPT_NAME);
		destroyIfPresent(ReplicatedStorage, BRIDGE_NAMES.clientLocal);

		const clientScript = new Instance("LocalScript");
		clientScript.Name = CLIENT_SCRIPT_NAME;
		clientScript.Archivable = false;
		setSource(clientScript, CLIENT_BRIDGE_SOURCE);
		clientScript.SetAttribute(STAMP_ATTR, BRIDGE_STAMP);
		clientScript.Parent = playerScripts;
	});

	if (!ok) {
		return { installed: false, error: tostring(err) };
	}
	return { installed: true };
}

export function ensureRuntimeBridgeInstalled(): InstallResult {
	if (!RunService.IsRunning()) {
		return { installed: false, error: "Eval bridges are installed only in running play DataModels" };
	}
	if (RunService.IsServer()) {
		return installServerRuntimeBridge();
	}
	return installClientRuntimeBridge();
}

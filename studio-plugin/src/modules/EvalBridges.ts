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
// Lifecycle: TestHandlers.startPlaytest inserts both scripts into the EDIT
// DM right before ExecutePlayModeAsync. ExecutePlayModeAsync clones the
// DataModel into the play DMs, so the scripts come along and run there.
// TestHandlers cleans them up from the edit DM when ExecutePlayModeAsync
// returns (test ended for any reason: stop_playtest, manual close, EndTest).
//
// Archivable handling: ExecutePlayModeAsync's deep-clone SKIPS instances
// with Archivable=false (verified empirically in v2.9.0 testing - bridges
// never reached the play DMs because we'd set them to false). We now keep
// Archivable=true so the clone works, and rely on cleanupBridges() to
// remove the scripts from the edit DM when the test ends. The only failure
// mode is the user saving DURING an active playtest, which would persist
// the bridges to the .rbxl - that's a no-op next session because
// installBridges() always calls cleanupBridges() first to clear stale
// instances. The RemoteFunction/BindableFunction that the bridge scripts
// CREATE at runtime stay Archivable=false (they're runtime-only and should
// never appear in a save).

import { ServerScriptService, StarterPlayer } from "@rbxts/services";

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
-- Auto-installed by @chrrxs/robloxstudio-mcp at start_playtest, removed at
-- stop_playtest. Provides shared-require-cache eval on the server peer for
-- the eval_server_runtime MCP tool.

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
		return false, "payload must be a ModuleScript instance"
	end
	return pcall(require, payload)
end
`;

const CLIENT_BRIDGE_SOURCE = `
-- Auto-installed by @chrrxs/robloxstudio-mcp at start_playtest, removed at
-- stop_playtest. Provides shared-require-cache eval on the client peer for
-- the eval_client_runtime MCP tool.

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
		return false, "payload must be a ModuleScript instance"
	end
	return pcall(require, payload)
end
`;

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

function findBridges(): { server?: Instance; client?: Instance } {
	const sps = getStarterPlayerScripts();
	return {
		server: ServerScriptService.FindFirstChild(SERVER_SCRIPT_NAME),
		client: sps ? sps.FindFirstChild(CLIENT_SCRIPT_NAME) : undefined,
	};
}

export function cleanupBridges(): void {
	const { server, client } = findBridges();
	if (server) {
		pcall(() => server.Destroy());
	}
	if (client) {
		pcall(() => client.Destroy());
	}
}

export function installBridges(): { installed: boolean; error?: string } {
	// Defensive: clear any stale bridges from a prior unclean exit before
	// inserting fresh. The injected script also self-cleans its
	// ReplicatedStorage/ServerScriptService children at startup, but the
	// containing Script/LocalScript objects themselves we must clear here.
	cleanupBridges();

	const [ok, err] = pcall(() => {
		const serverScript = new Instance("Script");
		serverScript.Name = SERVER_SCRIPT_NAME;
		// Archivable=true so ExecutePlayModeAsync's deep-clone includes the
		// script. cleanupBridges() removes it from the edit DM when the
		// playtest ends.
		setSource(serverScript, SERVER_BRIDGE_SOURCE);
		serverScript.Parent = ServerScriptService;

		const sps = getStarterPlayerScripts();
		if (!sps) {
			error("StarterPlayer.StarterPlayerScripts not found - cannot install client eval bridge");
		}
		const clientScript = new Instance("LocalScript");
		clientScript.Name = CLIENT_SCRIPT_NAME;
		setSource(clientScript, CLIENT_BRIDGE_SOURCE);
		clientScript.Parent = sps;
	});

	if (!ok) {
		return { installed: false, error: tostring(err) };
	}
	return { installed: true };
}


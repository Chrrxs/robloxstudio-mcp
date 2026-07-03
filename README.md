# Roblox Studio MCP Server

**An MCP server for Roblox Studio runtime debugging, playtest automation, and bulk place editing from Claude, Cursor, Codex, or Gemini.**

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

## Why this server

Use this when you want your agent to debug and operate a live Roblox Studio session with precise runtime control:

- `edit`, `server`, and `client-N` targeting for live playtests.
- Game-VM eval on the server or a specific client, sharing the same `require` cache as your scripts.
- Studio log breakpoints that let agents instrument live code without stopping the playtest.
- Script Profiler captures for server/client CPU hotspots, debug labels, and microsecond timing summaries.
- `solo_playtest` and `multiplayer_playtest` lifecycle tools for starting, stopping, inspecting, and ending playtests without hidden companion-tool discovery.
- `manage_instance` for launching Studio windows, closing explicit connected instances, and listing place versions for revision launches.
- Runtime log capture buffers, plus Stats memory and Scene Analysis attribution per peer.
- Viewport screenshots plus virtual mouse, keyboard, and UI interaction.
- Bulk property/script/attribute/tag operations for large places.
- `.rbxm` import/export through `SerializationService`.
- A read-only inspector package for safer review/debugging sessions.

77 advertised tools, including file tree inspection, mass reads/writes, script search-and-replace, asset insertion, build import/export, screenshot capture, log breakpoints, Script Profiler captures, runtime eval, memory tools, Scene Analysis, instance management, and playtest control.

## Setup

1. Enable **Allow HTTP Requests** in Game Settings → Security
2. Wire up your AI. `@latest` floats the server package to the newest npm release, and `--auto-install-plugin` copies the matching Studio plugin into Roblox Studio's Plugins folder when the server starts:

```bash
# Claude Code
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Codex CLI
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Gemini CLI
gemini mcp add robloxstudio npx --trust -- -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

Fully close and reopen Studio after the plugin is first installed or updated. Plugin shows "Connected" when ready.

Prefer manual plugin install? Run `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin`.

> **Custom Plugins folder?** Set `MCP_PLUGINS_DIR` before `--auto-install-plugin` or `--install-plugin`. Works on Windows, macOS, and WSL.

For multiple open Studio places, connect each plugin to the same MCP server URL. The MCP server tracks every connected place; call `get_connected_instances` and pass the returned `instance_id` to route a tool call to a specific game. Per-place port tabs such as `58742` are not the supported routing model.

If the Studio plugin and MCP server versions differ, the plugin stays connected but shows a yellow warning banner. `get_connected_instances`, `/health`, and `/status` also report `pluginVersion`, `serverVersion`, and `versionMismatch`.

<details>
<summary>Other MCP clients (Claude Desktop, Cursor, etc.)</summary>

```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "@chrrxs/robloxstudio-mcp@latest", "--auto-install-plugin"]
    }
  }
}
```

On Windows, wrap with `cmd /c` if `npx` doesn't resolve:
```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@chrrxs/robloxstudio-mcp@latest", "--auto-install-plugin"]
    }
  }
}
```
</details>

## What you can ask

> *"What's the structure of this game?"*
> *"Find scripts using deprecated APIs and rewrite them."*
> *"Start a multiplayer test with 2 clients, read the server log, and tell me why the round never starts."*
> *"Evaluate `MatchService.activeMatches` on the server while a match is running."*
> *"Set a log breakpoint on the damage function, reproduce the hit, then read the breakpoint logs."*
> *"Capture a server Script Profiler sample while the wave spawns and rank the hottest functions."*
> *"List recent versions for this place, then open version 3134 in a managed Studio window."*
> *"Spawn 50 NPCs in a 10x5 grid for stress testing."*

## Deprecated API

The split playtest tools are still callable by exact name for existing integrations, but they are no longer advertised through `tools/list`. New integrations should use `solo_playtest` and `multiplayer_playtest`.

Deprecated names: `start_playtest`, `stop_playtest`, `multiplayer_test_start`, `multiplayer_test_state`, `multiplayer_test_add_players`, `multiplayer_test_leave_client`, `multiplayer_test_end`.

## Inspector edition (read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

Same plugin family, different `.rbxmx`. 36 read-only tools — no writes, no script edits, no creation/deletion. Safe for browsing, code review, and debugging without risk of accidental changes.

Install only one variant at a time. Do not leave both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in the Studio Plugins folder; Studio loads both and they can register duplicate runtime peers. The CLI installers remove the other variant before installing:

```bash
npx -y @chrrxs/robloxstudio-mcp-inspector@latest --install-plugin

# Claude / Codex / Gemini — same shape, different package name
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
codex mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
gemini mcp add robloxstudio-inspector npx --trust -- -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

---

<!-- VERSION_LINE -->
**v2.20.0**

## Building from source

```bash
npm install && cd studio-plugin && npm install && cd ..
npm run build                                            # node packages
cd studio-plugin && npm run build && cd ..               # plugin TS → Luau
node scripts/build-plugin.mjs                            # → MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector        # → MCPInspectorPlugin.rbxmx
```

On WSL the `.rbxmx` is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`, and the local build script removes the other plugin variant from that folder. Set `MCP_PLUGINS_DIR` to override. **Fully close and reopen Studio** after a plugin rebuild, and verify only the one variant you intend to test remains in the Plugins folder.

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) · MIT Licensed · Based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0

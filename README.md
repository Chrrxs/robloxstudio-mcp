# Roblox Studio MCP

[![MCP Toplist](https://mcptoplist.com/badge/pulsemcp%2Fchrrxs-roblox-studio.svg)](https://mcptoplist.com/server/pulsemcp%2Fchrrxs-roblox-studio)

Connects MCP clients to Roblox Studio's edit context and live server/client
VMs. Agents can modify places, run Luau inside active playtests with the same
module state as game scripts, automate solo and multiplayer sessions, and
collect per-peer logs, screenshots, and profiler data.

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

## Tool overview

**Runtime debugging**

- `eval_server_runtime` / `eval_client_runtime`: run Luau in a server or client game VM with the same `require` cache as game scripts.
- `breakpoints`: instrument live code and record execution without pausing the playtest.
- `get_runtime_logs`: capture logs per peer (`edit`, `server`, `client-N`), including boot-time output and structured `LogService` data.

**Playtest automation**

- `solo_playtest` / `multiplayer_playtest`: start, inspect, and stop solo or multi-client playtests.
- `manage_instance`: launch, inspect, and close Studio windows for baseplates, local files, published places, or place revisions.

**Profiling & performance**

- `capture_script_profiler` / `capture_micro_profiler`: capture CPU timings on the server or a client.
- `get_memory_breakdown` / `get_scene_analysis`: report memory and scene attribution per peer.

**Editing**

- `execute_luau`: run Luau in Studio's edit context and return its output.
- `mass_set_property`, `bulk_set_attributes`, `find_and_replace_in_scripts`: update properties, attributes, or script text in bulk.
- `capture_screenshot` and input tools: capture the viewport and send mouse or keyboard input.

**Creator Store asset workflow**

- `search_assets`: search public assets; use `get_asset_details` to retrieve full metadata.
- `preview_asset`: inspect an unparented asset's hierarchy, media metadata, and security scan.
- `insert_asset`: remove scripts and package links, verify the result, and parent it in Studio.

**Agent guidance**

- `get_roblox_docs`: fetch official engine API documentation as Markdown.
- `get_roblox_skills`: list and retrieve Roblox-authored skills.

...and much more. [Review all tools here](packages/core/src/tools/definitions.ts).

## Setup

1. Wire up your AI. `--auto-install-plugin` installs the matching Studio plugin automatically:

```bash
# Claude Code
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Codex CLI
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin

# Gemini CLI
gemini mcp add robloxstudio npx --trust -- -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

2. Fully close and reopen Studio after the plugin is first installed or updated. The plugin shows **Connected** when ready.

Multiple open places connect to the same server; call `get_connected_instances` and pass `instance_id` to route tool calls. Custom Plugins folder: set `MCP_PLUGINS_DIR`. Manual plugin install: `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin`.

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

## Inspector edition (read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

39 read-only tools: no writes, no script edits. Safe for browsing, code review, and debugging without risk of accidental changes. Install only one variant at a time (the installers remove the other automatically):

```bash
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

## More

- [Configuration and HTTP bridge](docs/configuration.md)
- [Creator Store asset workflow](docs/creator-store-assets.md)
- [Report a security vulnerability](SECURITY.md)
- [Building from source](docs/building-from-source.md)
- [Deprecated tool names](docs/deprecated-api.md)

---

<!-- VERSION_LINE -->
**v2.23.1**

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) · MIT Licensed · Based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0

# Roblox Studio MCP

Connect your coding agent directly to Roblox Studio. It can edit places, run Luau
in live server and client contexts, start and stop playtests, and collect logs,
screenshots, memory reports, and profiler captures from each peer.

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp)

## What it can do

### Debug a running game
- Run Luau with `eval_server_runtime` or `eval_client_runtime`. Both execute in live context using the game's `require` cache.
- Instrument live code with `breakpoints` without pausing the playtest.
- Read output from edit mode, server, or specific clients with `get_runtime_logs`.

### Automate playtests

- Start, inspect, and stop solo or multi-client sessions with `solo_playtest` and `multiplayer_playtest`.
- Open or close Studio windows with `manage_instance`. It can launch a baseplate, a local place file, a published place, or an older place revision.

### Find performance problems

- Record server or client CPU timings with `capture_script_profiler` and `capture_micro_profiler`.
- Break down memory use with `get_memory_breakdown` or attribute scene cost with `get_scene_analysis`.

### Work in edit mode

- Run Luau in Studio's edit context with `execute_luau`.
- Use `set_properties` for instance properties and `find_and_replace_in_scripts` for script text. For project-specific bulk edits, use `execute_luau`.
- Use `selection` to inspect or update Studio selection and frame a part or model before capturing the viewport.
- Capture the viewport with `capture_screenshot`, then send mouse or keyboard input.

### Inspect Creator Store assets

- Find public assets with `search_assets`, then read the full catalog metadata with `get_asset_details`.
- Check an asset's hierarchy, media metadata, and security scan with `preview_asset` before adding it to the place.
- Add an asset with `insert_asset`. The tool removes scripts and package links, verifies the cleaned result, and then parents it in Studio.

### Look up Roblox APIs

- Fetch official engine API documentation as Markdown with `get_roblox_docs`.
- List and retrieve Roblox-authored skills with `get_roblox_skills`.

See the [complete tool list](packages/core/src/tools/definitions.ts).

## Setup

1. Add the server to your MCP client (`--auto-install-plugin` installs the matching Studio plugin):

```bash
# Claude Code / Codex CLI
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

For JSON-configured clients (Cursor, Antigravity, Claude Desktop, Windsurf, VS Code):

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

2. Fully close and reopen Studio after installation. The plugin shows **Connected** when ready.

- Pass `instance_id` to route calls when multiple places are open.
- Set `MCP_PLUGINS_DIR` for custom plugin paths, or run `npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin` to install manually.

## Inspector edition (DataModel read-only)

[![NPM Version](https://img.shields.io/npm/v/@chrrxs/robloxstudio-mcp-inspector)](https://www.npmjs.com/package/@chrrxs/robloxstudio-mcp-inspector)

24 Studio-safe inspection tools: no DataModel or script edits. The selection
tool can change editor selection and camera framing; export and profiler tools
can write files only to explicit local paths. Install only one variant at a time
(the installers remove the other automatically):

```bash
claude mcp add robloxstudio-inspector -- npx -y @chrrxs/robloxstudio-mcp-inspector@latest --auto-install-plugin
```

## More

- [Configuration and HTTP bridge](docs/configuration.md)
- [Creator Store asset workflow](docs/creator-store-assets.md)
- [Report a security vulnerability](SECURITY.md)
- [Building from source](docs/building-from-source.md)
- [3.0 tool removals and replacements](docs/deprecated-api.md)
- [Token-efficiency contract and budget](docs/token-efficiency.md)

---

<!-- VERSION_LINE -->
**v3.0.1**

[Report Issues](https://github.com/chrrxs/robloxstudio-mcp/issues) · MIT Licensed · Based on [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) v2.7.0

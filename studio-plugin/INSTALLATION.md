# Roblox Studio MCP Plugin Installation Guide

## Quick Installation

### Method 1: Roblox Creator Store (Easiest)
1. Visit: https://create.roblox.com/store/asset/132985143757536
2. Click **"Install"**. The plugin appears immediately in your toolbar.

### Method 2: CLI Installer
Use the `--install-plugin` flag with `npx` to automatically download and install the plugin locally:
```bash
npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin
```

### Method 3: Direct Download
1. Download [MCPPlugin.rbxmx](https://github.com/chrrxs/robloxstudio-mcp/releases/latest/download/MCPPlugin.rbxmx).
2. Save to your local plugins folder:
   - **Windows**: `%LOCALAPPDATA%/Roblox/Plugins/`
   - **macOS**: `~/Documents/Roblox/Plugins/`
   - **Note:** Keep only one MCP variant (standard or inspector) in this folder.
3. Restart Roblox Studio.

## Setup & Configuration

### 1. Allow third-party Creator Store assets (Optional)
To insert public Creator Store assets, enable **"Allow Loading Third Party Assets"** under **Game Settings > Security**.

### 2. Activate the Plugin
In the Plugins toolbar, click the **"MCP Server"** button.
- **Green** = Connected
- **Red** = Disconnected (Waiting for MCP server)

### 3. Install MCP Server

**Claude Code / Codex CLI:**
```bash
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

**Claude Desktop / Gemini / Others (`mcp_config.json`):**
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

> **Windows Note:** If `npx` fails, use `"command": "cmd"` and `"args": ["/c", "npx", ...]`

## Troubleshooting

- **Missing from Toolbar:** Verify the file is in the correct folder and restart Studio.
- **Disconnected:** Ensure the MCP server is running and click the plugin button to activate.
- **Connection Issues:** Check Windows Firewall isn't blocking `localhost:58741`. See the Output window for logs.
- **Version Mismatch:** If Studio shows a version mismatch banner, restart the MCP server with `--auto-install-plugin` and fully restart Studio.

## Security & Advanced Usage
- Connects locally to `http://localhost:58741`.
- For read-only access, install the Inspector edition instead.
- For multiple open places, they all connect to the same server. Use `get_connected_instances` and `instance_id` to route commands.
- See [Configuration Guide](../docs/configuration.md) for auth details.

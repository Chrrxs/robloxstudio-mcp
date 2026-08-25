# Roblox Studio MCP Plugin Installation Guide

Complete your AI assistant integration with this easy-to-install Studio plugin. Works with Claude Code, Claude Desktop, and any MCP-compatible AI.

## Quick Installation

### Method 1: Roblox Creator Store (Easiest)
1. **Install from Creator Store:**
   - Visit: https://create.roblox.com/store/asset/132985143757536
   - Click **"Install"** button
   - Plugin automatically opens in Studio

2. **No restart needed** - Plugin appears immediately in toolbar!

### Method 2: CLI Installer
Run the installer bundled with the latest server package:

```bash
npx -y @chrrxs/robloxstudio-mcp@latest --install-plugin
```

Fully close and reopen Roblox Studio after the plugin is installed or updated.

### Method 3: Direct Download
1. Download [MCPPlugin.rbxmx](https://github.com/chrrxs/robloxstudio-mcp/releases/latest/download/MCPPlugin.rbxmx).
2. Save it to the Studio Plugins folder:
   - **Windows**: `%LOCALAPPDATA%/Roblox/Plugins/`
   - **macOS**: `~/Documents/Roblox/Plugins/`
   - **From Studio**: Open **Plugins > Plugins Folder**, then copy the file there.
   - Keep only one MCP variant in this folder. Remove `MCPInspectorPlugin.rbxmx` when installing `MCPPlugin.rbxmx`.
3. Fully close and reopen Roblox Studio.

## Setup & Configuration

### Optional: Allow third-party Creator Store assets

To preview or insert public Creator Store assets that you do not own, enable
**"Allow Loading Third Party Assets"** under
**Game Settings** > **Security**.
Roblox disables this setting by default.

### 1. Activate the Plugin
**Plugins toolbar** > Click **"MCP Server"** button
- **Green status** = Connected and ready
- **Red status** = Disconnected (normal until MCP server runs)

### 2. Install MCP Server
Choose your AI assistant:

**For Claude Code:**
```bash
claude mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

**For Codex CLI:**
```bash
codex mcp add robloxstudio -- npx -y @chrrxs/robloxstudio-mcp@latest --auto-install-plugin
```

**For Claude Desktop/Others:**
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

`@latest` floats the server package to the newest npm release. `--auto-install-plugin` copies the matching `.rbxmx` bundled with that package into Studio's Plugins folder when the server starts.

If Studio shows a yellow plugin/server version mismatch banner, the connection remains usable. Restart the MCP server with `--auto-install-plugin`, then fully close and reopen Studio so it loads the matching plugin file.

<details>
<summary>Note for native Windows users</summary>
If you encounter issues, you may need to run it through `cmd`. Update your configuration like this:

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

## How It Works

1. **AI calls tool** > MCP server queues request
2. **Plugin polls** every 500ms for work
3. **Plugin executes** Studio API calls
4. **Plugin responds** with extracted data
5. **AI receives** comprehensive Studio information

**Available Tools:** 37+ specialized tools for file trees, scripts, properties, attributes, tags, and more!

## Troubleshooting

### Plugin Missing from Toolbar
- Verify file saved to correct plugins folder
- Restart Roblox Studio completely
- Check Output window for error messages

### Plugin Shows "Disconnected"
- **Normal behavior** when MCP server isn't running
- Click "MCP Server" button to activate
- Install MCP server using commands above

### Connection Issues
- Check Windows Firewall isn't blocking localhost:58741
- Restart both Studio and your AI assistant
- Check Studio Output window for detailed error messages

## Security & Privacy

- **Local bridge by default**: The plugin connects to `http://localhost:58741`
  unless you explicitly configure another server URL.
- **Explicit tool access**: The full plugin can modify a place when a write tool
  is called. Install the Inspector edition when you need read-only access.
- **Provider boundary**: Tool results pass through your configured MCP client.
  Your AI provider's data-handling policy applies to content sent by that
  client.

See the repository's
[configuration guide](../docs/configuration.md) for HTTP bridge authentication
and network settings. Report suspected vulnerabilities through the
[security policy](../SECURITY.md), not a public issue.

## Advanced Usage

### Plugin Features
- **Real-time status**: Visual connection indicators
- **Smart polling**: Exponential backoff for failed connections
- **Error recovery**: Automatic retry with timeout handling
- **Debug friendly**: Comprehensive logging in Output window

### Customization
- **Server URL**: Modify the single plugin URL field (default: http://localhost:58741)
- **Multiple Studio places**: Connect every place to the same MCP server, then use `get_connected_instances` and `instance_id` to choose the target game
- **Poll interval**: 500ms default (editable in code)
- **Timeout settings**: 30-second request timeouts

### Development Mode
```lua
-- Enable debug logging in plugin code:
local DEBUG_MODE = true
```

## Pro Tips

- **Keep Studio open** while using AI assistants
- **Plugin auto-connects** when MCP server starts
- **Monitor status** via the dock widget
- **Use AI tools** to explore game architecture, find bugs, analyze dependencies
- **Perfect for** code reviews, debugging, and understanding complex projects!

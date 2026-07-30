# Roblox Studio MCP Plugin Installation Guide

Complete your AI assistant integration with this easy-to-install Studio plugin. Works with Claude Code, Claude Desktop, and any MCP-compatible AI.

## Quick Installation

### Method 1: Roblox Creator Store (Easiest)
1. **Install from Creator Store:**
   - Visit: https://create.roblox.com/store/asset/132985143757536
   - Click **"Install"** button
   - Plugin automatically opens in Studio

2. **No restart needed** - Plugin appears immediately in toolbar!

### Method 2: Direct Download
1. **Download the plugin:**
   - **GitHub Release**: [Download MCPPlugin.rbxmx](https://github.com/chrrxs/robloxstudio-mcp/releases/latest/download/MCPPlugin.rbxmx)
   - **CLI installer**: `npx -y github:Akramle/robloxstudio-mcp --install-plugin`
   - This is the official Roblox plugin format

2. **Install to plugins folder:**
   - **Windows**: Save to `%LOCALAPPDATA%/Roblox/Plugins/`
   - **macOS**: Save to `~/Documents/Roblox/Plugins/`
   - **Or use Studio**: Plugins tab > Plugins Folder > drop the file
   - Keep only one MCP variant in this folder. Remove `MCPInspectorPlugin.rbxmx` if installing `MCPPlugin.rbxmx`, and remove `MCPPlugin.rbxmx` if installing the inspector variant.

3. **Restart Roblox Studio** - Plugin appears automatically!

### Method 3: Save as Local Plugin
1. **Copy the plugin code:**
   - Open [studio-plugin/src/server/index.server.ts](https://github.com/chrrxs/robloxstudio-mcp/blob/main/studio-plugin/src/server/index.server.ts) on GitHub (or build locally - see project README)
   - Copy all the code (Ctrl+A, Ctrl+C)

2. **Create in Studio:**
   - Open Roblox Studio with any place
   - Create a new Script in ServerScriptService
   - Paste the plugin code
   - **Right-click script** > **"Save as Local Plugin..."**
   - Name it "Roblox Studio MCP"

3. **Plugin appears immediately** in your toolbar!

## Setup & Configuration

### 1. Enable HTTP Requests (Required)
**Game Settings** > **Security** > **"Allow HTTP Requests"**

### 2. Activate the Plugin
**Plugins toolbar** > Click **"MCP Server"** button
- **Green status** = Connected and ready
- **Red status** = Disconnected (normal until MCP server runs)

### 3. Install MCP Server
Choose your AI assistant:

**For Claude Code:**
```bash
claude mcp add robloxstudio -- npx -y github:Akramle/robloxstudio-mcp --auto-install-plugin
```

**For Codex CLI:**
```bash
codex mcp add robloxstudio -- npx -y github:Akramle/robloxstudio-mcp --auto-install-plugin
```

**For Claude Desktop/Others:**
```json
{
  "mcpServers": {
    "robloxstudio-mcp": {
      "command": "npx",
      "args": ["-y", "github:Akramle/robloxstudio-mcp", "--auto-install-plugin"]
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
      "args": ["/c", "npx", "-y", "github:Akramle/robloxstudio-mcp", "--auto-install-plugin"]
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

### "HTTP 403 Forbidden" Errors
- Enable "Allow HTTP Requests" in Game Settings > Security
- Verify MCP server is running (status should show connected)

### Plugin Shows "Disconnected"
- **Normal behavior** when MCP server isn't running
- Click "MCP Server" button to activate
- Install MCP server using commands above

### Connection Issues
- Check Windows Firewall isn't blocking localhost:58741
- Restart both Studio and your AI assistant
- Check Studio Output window for detailed error messages

## Security & Privacy

- **Local-only**: All communication stays on your machine
- **No external servers**: Plugin only talks to localhost
- **Read-only access**: Plugin extracts data but never modifies your place
- **No data collection**: Your projects remain private

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

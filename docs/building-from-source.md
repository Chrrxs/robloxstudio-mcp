# Building from source

```bash
npm install && cd studio-plugin && npm install && cd ..
npm run build                                            # node packages
cd studio-plugin && npm run build && cd ..               # plugin TS → Luau
node scripts/build-plugin.mjs                            # → MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector        # → MCPInspectorPlugin.rbxmx
```

On WSL the `.rbxmx` is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`, and the local build script removes the other plugin variant from that folder. Set `MCP_PLUGINS_DIR` to override. **Fully close and reopen Studio** after a plugin rebuild, and verify only the one variant you intend to test remains in the Plugins folder.

Do not leave both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in the Studio Plugins folder; Studio loads both and they can register duplicate runtime peers.

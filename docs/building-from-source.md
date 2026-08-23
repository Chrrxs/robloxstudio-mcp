# Building from source

Node.js 20 or newer is required.

```bash
npm install && cd studio-plugin && npm install && cd ..
npm run build                                            # node packages
cd studio-plugin && npm run build && cd ..               # plugin TS → Luau
node scripts/build-plugin.mjs                            # → MCPPlugin.rbxmx
node scripts/build-plugin.mjs --variant inspector        # → MCPInspectorPlugin.rbxmx
```

On WSL the `.rbxmx` is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`, and the local build script removes the other plugin variant from that folder. Set `MCP_PLUGINS_DIR` to override. **Fully close and reopen Studio** after a plugin rebuild, and verify only the one variant you intend to test remains in the Plugins folder.

Do not leave both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in the Studio Plugins folder; Studio loads both and they can register duplicate runtime peers.

## Feature completion gate

A feature is not complete until the short live Studio gate passes:

```bash
npm run test:e2e
```

This checks representative edit-mode, playtest, server, and client behavior.
Run the targeted E2E for any specialized subsystem the feature changes. The
auto-install, full functional, lifecycle, and parallel-isolation suites are
reserved for relevant changes and the release gate:

```bash
npm run test:e2e:full
```

See [`tests/README.md`](../tests/README.md) for the selection guide and
individual commands.

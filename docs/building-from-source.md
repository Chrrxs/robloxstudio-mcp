# Building from Source

Requires **Node.js 20+**.

## 1. Install Dependencies
```bash
npm install
cd studio-plugin && npm install && cd ..
```

## 2. Compile
Compile Node packages and transpile the plugin from TypeScript to Luau:
```bash
npm run build
cd studio-plugin && npm run build && cd ..
```

## 3. Build the Plugin Model
Generate the `.rbxmx` plugin file.

**Warning:** Do not install both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` simultaneously. It will duplicate peers and break connections.

```bash
# Standard plugin
node scripts/build-plugin.mjs

# Inspector variant
node scripts/build-plugin.mjs --variant inspector
```

> **WSL Users:** The script automatically installs to `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/` and removes competing variants. Override via `MCP_PLUGINS_DIR`. **Restart Studio** after rebuilding.

---

## Testing

Features must pass the E2E gate.

### Standard E2E
Checks edit-mode, playtest, server, and client behavior:
```bash
npm run test:e2e
```

### Full Release Gate
Run for large architectural changes or release preparation:
```bash
npm run test:e2e:full
```

See [Tests Documentation](../tests/README.md) for details.

# Building from source

Node.js 22 or newer is required. The main plugin also needs the story renderer
submodule, pnpm 10, and `patch` and `tar` on PATH. The pinned lockfile uses
version 9; the verified build used pnpm 10.24.0.

```bash
git submodule update --init vendor/ui-renderer
npm install && cd studio-plugin && npm install && cd ..
npm run build                                            # node packages
cd studio-plugin && npm run build && cd ..               # plugin TS → Luau
node scripts/build-plugin.mjs --variant inspector        # → MCPInspectorPlugin.rbxmx (no renderer)
node scripts/build-ui-renderer.mjs                       # → .local/ui-renderer-build (renderer + adapter)
node scripts/build-plugin.mjs                            # → MCPPlugin.rbxmx
node scripts/build-source-archive.mjs                    # → MCPPlugin-source.tar.gz
```

`npm run build:plugin`, `build:plugin:artifact`, and `build:plugins` run these
steps in order.

## Story renderer (main plugin only)

The main plugin bundles a story renderer (`vendor/ui-renderer`) so `preview_ui`
can render story modules (`*.story`). `scripts/build-ui-renderer.mjs` never
modifies `vendor/ui-renderer`; it refuses a dirty checkout, copies the pinned
source, patches, configs, and `pnpm-lock.yaml` into `.local/ui-renderer-build`,
copies the maintained adapter files from `studio-plugin/ui-renderer/` into
`src/` (`Preview.tsx` becomes `McpPreview.tsx`, any other `X.ts(x)` becomes
`McpX.ts(x)`), applies `studio-plugin/ui-renderer/upstream.patch` with
`patch -p1` when present, then runs `pnpm install --frozen-lockfile` and
`pnpm exec rbxtsc`. `build-plugin.mjs` packages the compiled `out/` as the
plugin's `UIRenderer` folder, with `include/node_modules/@rbxts` and
`@rbxts-js` laid out like the upstream `default.project.json`. The upstream
toolbar plugin script is not bundled, so no extra toolbar appears; the plugin
requires `UIRenderer.McpPreview` on demand. The inspector variant contains no
renderer.

## Previewing UI with `preview_ui`

`preview_ui` keeps one preview per Studio edit DataModel, so story controls and
UI state persist between calls:

```json
{ "action": "mount", "target": "game.ReplicatedStorage.UI[\"Shop.story\"]", "controls": { "Coins": 250 }, "instance_id": "instance:abc-123" }
{ "action": "set_controls", "controls": { "Theme": "Dark", "Accent": "#FF8800" } }
{ "action": "inspect" }
{ "action": "click", "element": "Shop/Buy" }
{ "action": "type", "element": "Search", "text": "sword", "submit": true }
{ "action": "unmount" }
```

- `mount` takes a story module, a ScreenGui, or a GuiObject. Stories render
  through the bundled renderer from their current source. ScreenGuis and
  GuiObjects are cloned; the originals are never changed, and scripts inside
  them do not run in edit mode. The result lists the story's controls (name,
  type, value, options or limits).
- The preview lives in a non-archivable `__MCPUiPreview_*` ScreenGui under
  StarterGui with a very high DisplayOrder and a neutral backdrop
  (`backdrop: false` shows the game UI and 3D view behind it). StarterGui keeps
  it out of saves and playtests, and virtual clicks reach it in edit mode
  (clicks over CoreGui UI are rejected by Studio). If
  `StarterGui.ShowDevelopmentGui` is off, the preview turns it on and restores
  it on unmount.
- `click` targets an element's centre (or `x`/`y` read off the last
  `preview_ui` screenshot) through `UserInputService:CreateVirtualInput()`.
  `type` focuses a TextBox, sends the text, and presses Return when `submit`
  is true.
- `mount`, `set_controls`, `click`, `type`, and `screenshot` wait
  `settle_seconds` (0–5, default 0.25) and return a screenshot; `inspect`
  returns the GuiObject tree (paths, classes, visibility, screen rects,
  Text/Image, button and TextBox flags), capped at 300 nodes.
- The preview unmounts on `unmount`, after 10 idle minutes, when a playtest
  starts, and when the plugin unloads. `preview_ui` refuses active playtests and
  never touches a separately installed renderer plugin.

The corresponding-source archive rebuilds without a Git checkout. Its copy of
`vendor/ui-renderer/UPSTREAM_COMMIT` records the source pin.

## Licensing

The story renderer is GPL-3.0, so `MCPPlugin.rbxmx` and the
`@chrrxs/robloxstudio-mcp` package are distributed as a combined work under
GPL-3.0-only; attribution is in `packages/robloxstudio-mcp/NOTICE`. The
original MCP server and plugin source is MIT (root `LICENSE`); the vendored
renderer, the preview adapter in `studio-plugin/ui-renderer/`, and its
`upstream.patch` overlay are GPL-3.0. The original MIT notice ships as
`LICENSE-MIT` alongside `LICENSE` (GPL-3.0) and `NOTICE`. Prepack stages those files plus
`studio-plugin/MCPPlugin-source.tar.gz`, the complete corresponding source
(MCP plugin source and build scripts, pinned renderer source/patches/configs/
lockfile, the adapter, bundled Luau package sources and licenses, and
`BUILDING.txt` rebuild instructions). Postpack removes them. The inspector
package remains MIT.

On WSL the `.rbxmx` is auto-installed into `/mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/`, and the local build script removes the other plugin variant from that folder. Set `MCP_PLUGINS_DIR` to override. **Fully close and reopen Studio** after a plugin rebuild, and verify only the one variant you intend to test remains in the Plugins folder.

Do not leave both `MCPPlugin.rbxmx` and `MCPInspectorPlugin.rbxmx` in the Studio Plugins folder; Studio loads both and they can register duplicate runtime peers.

## Feature completion gate

A feature is not complete until the short live Studio gate passes:

```bash
npm run test:e2e
```

This checks representative edit-mode, playtest, server, and client behavior.
Before launching Studio, the gate recompiles and assembles
`studio-plugin/MCPPlugin.rbxmx` from the current worktree, then installs that
exact file into its isolated plugin directory. The artifact-only build does
not alter your normal Studio plugin folder, and the installer never falls back
to a published release.
Run the targeted E2E for any specialized subsystem the feature changes. The
auto-install, full functional, lifecycle, and parallel-isolation suites are
reserved for relevant changes and the release gate:

```bash
npm run test:e2e:full
```

See [`tests/README.md`](../tests/README.md) for the selection guide and
individual commands.

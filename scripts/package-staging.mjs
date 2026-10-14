/**
 * Files copied into each publishable package by prepack.mjs and removed by
 * postpack.mjs. Paths in packageFiles are relative to the repo root (from) and
 * the package directory (to).
 */
export const PACKAGE_STAGING = {
  // Bundles the GPL-3.0 story renderer: ship the combined-work license, the
  // original MIT notice, and the corresponding-source archive.
  '@chrrxs/robloxstudio-mcp': {
    pluginAssets: ['MCPPlugin.rbxmx', 'MCPPlugin-source.tar.gz'],
    packageFiles: [
      { from: 'vendor/ui-renderer/LICENSE', to: 'LICENSE' },
      { from: 'LICENSE', to: 'LICENSE-MIT' },
    ],
  },
  '@chrrxs/robloxstudio-mcp-inspector': {
    pluginAssets: ['MCPInspectorPlugin.rbxmx'],
    packageFiles: [],
  },
};

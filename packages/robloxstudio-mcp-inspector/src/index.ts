import { RobloxStudioMCPServer, getReadOnlyTools } from '@chrrxs/robloxstudio-mcp-core';
import { createRequire } from 'module';
import { installBundledPlugin, installPlugin } from './install-plugin.js';

const installBundledOnly = process.argv.includes('--install-bundled-plugin');
const installWithFallback = process.argv.includes('--install-plugin');
const pluginPathIndex = process.argv.indexOf('--plugin-path');
const pluginPath = pluginPathIndex !== -1 && pluginPathIndex + 1 < process.argv.length
  ? process.argv[pluginPathIndex + 1]
  : undefined;

if (installBundledOnly || installWithFallback) {
  const install = installBundledOnly
    ? installBundledPlugin
    : installPlugin;
  await install({ sourcePath: pluginPath }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  const autoInstallPlugin = process.argv.includes('--auto-install-plugin');

  const require = createRequire(import.meta.url);
  const { version: VERSION } = require('../package.json');

  const server = new RobloxStudioMCPServer({
    name: 'robloxstudio-mcp-inspector',
    version: VERSION,
    tools: getReadOnlyTools(),
    installStudioPlugin: autoInstallPlugin
      ? () => installBundledPlugin({
        sourcePath: pluginPath,
        log: (message) => console.error(`[install-plugin] ${message}`),
        warn: (message) => console.error(message),
      })
      : undefined,
  });

  server.run().catch((error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}

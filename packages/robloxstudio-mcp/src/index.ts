import { RobloxStudioMCPServer, getAllTools } from '@chrrxs/robloxstudio-mcp-core';
import { createRequire } from 'module';
import { installBundledPlugin, installPlugin } from './install-plugin.js';

const flagValue = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
};

const installBundledOnly = process.argv.includes('--install-bundled-plugin');
const installWithFallback = process.argv.includes('--install-plugin');

if (installBundledOnly || installWithFallback) {
  const install = installBundledOnly
    ? installBundledPlugin
    : installPlugin;
  await install({ sourcePath: flagValue('--plugin-path') }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  if (process.argv.includes('--auto-install-plugin')) {
    await installBundledPlugin({
      sourcePath: flagValue('--plugin-path'),
      log: (message) => console.error(`[install-plugin] ${message}`),
      warn: (message) => console.error(message),
    }).catch((err) => {
      console.error(
        `[install-plugin] Auto-install skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  const openCloudKey = flagValue('--open-cloud-key');
  const creatorId = flagValue('--creator-id');
  const creatorGroupId = flagValue('--creator-group-id');

  if (openCloudKey) process.env.ROBLOX_OPEN_CLOUD_API_KEY = openCloudKey;
  if (creatorId) process.env.ROBLOX_CREATOR_USER_ID = creatorId;
  if (creatorGroupId) process.env.ROBLOX_CREATOR_GROUP_ID = creatorGroupId;

  const require = createRequire(import.meta.url);
  const { version: VERSION } = require('../package.json');

  const server = new RobloxStudioMCPServer({
    name: 'robloxstudio-mcp',
    version: VERSION,
    tools: getAllTools(),
  });

  server.run().catch((error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}

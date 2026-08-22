import { RobloxStudioMCPServer, getReadOnlyTools } from '@chrrxs/robloxstudio-mcp-core';
import { createRequire } from 'module';

if (process.argv.includes('--install-plugin')) {
  const { installPlugin } = await import('./install-plugin.js');
  await installPlugin().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
} else {
  if (process.argv.includes('--auto-install-plugin')) {
    const { installBundledPlugin } = await import('./install-plugin.js');
    await installBundledPlugin({
      log: (message) => console.error(`[install-plugin] ${message}`),
      warn: (message) => console.error(message),
    }).catch((err) => {
      console.error(
        `[install-plugin] Auto-install skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  const require = createRequire(import.meta.url);
  const { version: VERSION } = require('../package.json');

  const server = new RobloxStudioMCPServer({
    name: 'robloxstudio-mcp-inspector',
    version: VERSION,
    tools: getReadOnlyTools(),
  });

  server.run().catch((error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}

import { createPluginInstaller } from '@chrrxs/robloxstudio-mcp-core';
import type { PluginInstallOptions } from '@chrrxs/robloxstudio-mcp-core';

interface InstallOptions extends PluginInstallOptions {
  dev?: boolean;
}

const installer = createPluginInstaller(import.meta.url, 'main');

export async function installBundledPlugin(options: InstallOptions = {}): Promise<void> {
  await installer.installBundledPlugin(options);
}

export async function installPlugin(options: InstallOptions = {}): Promise<void> {
  await installer.installPlugin(options, options.dev ?? process.argv.includes('--dev'));
}

import { createPluginInstaller } from '@chrrxs/robloxstudio-mcp-core';
import type { PluginInstallOptions } from '@chrrxs/robloxstudio-mcp-core';

const installer = createPluginInstaller(import.meta.url, 'inspector');

export async function installBundledPlugin(options: PluginInstallOptions = {}): Promise<void> {
  await installer.installBundledPlugin(options);
}

export async function installPlugin(options: PluginInstallOptions = {}): Promise<void> {
  await installer.installPlugin(options);
}

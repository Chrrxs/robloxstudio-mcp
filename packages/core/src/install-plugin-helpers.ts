import { existsSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { getStudioPlatformCapabilities } from './studio-platform.js';

// Shared helpers for the per-package install-plugin.ts in
// @chrrxs/robloxstudio-mcp and @chrrxs/robloxstudio-mcp-inspector. Bundled
// into both via tsup's noExternal at publish time, so changes here ship in
// both packages on the next publish.
const DEFAULT_PLUGIN_PORT = 58741;
const SERVER_URL_SETTING_KEY_PATTERN =
  /MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1|MCP_LAST_SUCCESSFUL_SERVER_URL_|MCP_SERVER_URL_/g;

/**
 * The bundled plugin is XML, so a custom bridge port can be embedded without
 * rebuilding it. Port-specific setting keys prevent a remembered default URL
 * from overriding the custom URL when Studio starts.
 */
export function configurePluginAssetForPort(
  source: Buffer,
  rawPort: string | undefined = process.env.ROBLOX_STUDIO_PORT,
): Buffer {
  if (rawPort === undefined || rawPort === '') return source;
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`ROBLOX_STUDIO_PORT must be an integer from 1 to 65535; received ${JSON.stringify(rawPort)}`);
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ROBLOX_STUDIO_PORT must be an integer from 1 to 65535; received ${JSON.stringify(rawPort)}`);
  }
  if (port === DEFAULT_PLUGIN_PORT) return source;

  const defaultPort = String(DEFAULT_PLUGIN_PORT);
  const configuredPort = String(port);
  const defaultUrl = `http://localhost:${defaultPort}`;
  const defaultBasePort = `BASE_PORT = ${defaultPort}`;
  const original = source.toString('utf8');
  if (!original.includes(defaultUrl) || !original.includes(defaultBasePort)) {
    throw new Error(`Bundled Studio plugin does not contain the expected default port ${defaultPort}`);
  }

  const configured = original
    .replaceAll(defaultUrl, `http://localhost:${configuredPort}`)
    .replaceAll(defaultBasePort, `BASE_PORT = ${configuredPort}`)
    .replace(
      SERVER_URL_SETTING_KEY_PATTERN,
      (key) => key.endsWith('_')
        ? `${key}PORT_${configuredPort}_`
        : `${key}_PORT_${configuredPort}`,
    );
  return Buffer.from(configured, 'utf8');
}

export function isWSL(): boolean {
  return getStudioPlatformCapabilities().isWsl;
}

function getWindowsUserPluginsDir(): string | null {
  // Resolve Windows %LOCALAPPDATA% from the WSL side and translate it via
  // wslpath. cmd.exe spams a "UNC paths are not supported" warning to stderr
  // when the CWD is on the Linux side - silence it with stdio: 'ignore'.
  try {
    const localAppData = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!localAppData || localAppData.includes('%')) return null;
    const linuxPath = execFileSync('wslpath', ['-u', localAppData], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (!linuxPath) return null;
    return join(linuxPath, 'Roblox', 'Plugins');
  } catch {
    return null;
  }
}

export function getPluginsFolder(): string {
  // MCP_PLUGINS_DIR is the highest-priority override on every platform.
  // Useful for custom Studio installs, network shares, or CI.
  if (process.env.MCP_PLUGINS_DIR) return process.env.MCP_PLUGINS_DIR;

  if (process.platform === 'win32') {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
      'Roblox',
      'Plugins',
    );
  }

  if (isWSL()) {
    const win = getWindowsUserPluginsDir();
    if (win) return win;
    console.warn(
      '[install-plugin] WSL detected but could not resolve Windows %LOCALAPPDATA%. ' +
        'Falling back to ~/Documents/Roblox/Plugins/ - you will likely need to copy the rbxmx ' +
        'to /mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/ manually. ' +
        'Set MCP_PLUGINS_DIR to skip detection.',
    );
  }

  return join(homedir(), 'Documents', 'Roblox', 'Plugins');
}

export interface VariantConflictOptions {
  pluginsFolder: string;
  otherAssetName: string;
  replace: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function handleVariantConflict({
  pluginsFolder,
  otherAssetName,
  replace,
  log = console.log,
  warn = console.warn,
}: VariantConflictOptions): void {
  const otherDest = join(pluginsFolder, otherAssetName);
  if (!existsSync(otherDest)) return;

  if (replace) {
    try {
      unlinkSync(otherDest);
      log(`Removed conflicting ${otherAssetName}.`);
    } catch (err) {
      warn(`[install-plugin] Could not remove ${otherDest}: ${err}. Continuing.`);
    }
    return;
  }

  warn(
    `\n[install-plugin] WARNING: ${otherAssetName} is already present in ${pluginsFolder}.\n` +
      `Only one MCP plugin variant should be present. If both variants are in the Studio ` +
      `Plugins folder, Studio loads both and runtime routing can become unpredictable.\n` +
      `Delete ${otherAssetName} manually or use the default CLI installer behavior to replace it.\n`,
  );
}

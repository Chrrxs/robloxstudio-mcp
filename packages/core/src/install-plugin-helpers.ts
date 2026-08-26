import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { basename, join } from 'path';
import { homedir } from 'os';
import { isUtf8 } from 'buffer';
import { SaxesParser } from 'saxes';
import { getStudioPlatformCapabilities } from './studio-platform.js';

// Shared helpers for the per-package install-plugin.ts in
// @chrrxs/robloxstudio-mcp and @chrrxs/robloxstudio-mcp-inspector. Bundled
// into both via tsup's noExternal at publish time, so changes here ship in
// both packages on the next publish.
const DEFAULT_PLUGIN_PORT = 58741;
const SERVER_URL_SETTING_KEY_PATTERN =
  /MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1|MCP_LAST_SUCCESSFUL_SERVER_URL_/g;

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
    const localAppData = execSync('cmd.exe /c "echo %LOCALAPPDATA%"', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!localAppData || localAppData.includes('%')) return null;
    const linuxPath = execSync(`wslpath -u '${localAppData.replace(/'/g, "'\\''")}'`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
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

export type PluginVariant = 'main' | 'inspector';

export interface InstallPluginAssetOptions {
  pluginsFolder: string;
  assetName: string;
  otherAssetName: string;
  source: Buffer;
  expectedVersion: string;
  expectedVariant: PluginVariant;
  rawPort?: string;
  replaceVariant?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface PluginInstallResult {
  destination: string;
  installed: boolean;
}

const PLUGIN_INSTALL_LOCK_NAME = '.robloxstudio-mcp-plugin-install.lock';

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function acquirePluginInstallLock(
  pluginsFolder: string,
  warn: (message: string) => void,
): () => void {
  const lockPath = join(pluginsFolder, PLUGIN_INSTALL_LOCK_NAME);
  const ownerPath = join(lockPath, 'owner.json');
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };

  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    throw new Error(
      `Another Studio plugin installation is already in progress: ${lockPath}. ` +
        'If no installer is running, remove that lock directory and retry.',
    );
  }

  try {
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch (cleanupError) {
      warn(`[install-plugin] Could not clean failed install lock ${lockPath}: ${cleanupError}`);
    }
    throw error;
  }

  return () => {
    try {
      const currentOwner = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
        pid?: unknown;
        token?: unknown;
      };
      if (currentOwner.pid === owner.pid && currentOwner.token === owner.token) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        warn(`[install-plugin] Could not release install lock ${lockPath}: ${error}`);
      }
    }
  };
}

function assertAssetFileName(name: string, field: string): void {
  if (name === '' || basename(name) !== name) {
    throw new Error(`${field} must be a file name, received ${JSON.stringify(name)}`);
  }
}

function embeddedPluginValue(
  source: string,
  name: 'CURRENT_VERSION' | 'PLUGIN_VARIANT',
  assetName: string,
): string {
  const pattern = new RegExp(`\\blocal\\s+${name}\\s*=\\s*"([^"]+)"\\s*;?`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${assetName} must contain exactly one embedded ${name}; found ${matches.length}.`,
    );
  }
  return matches[0][1];
}

interface ParsedPluginElement {
  name: string;
  attributes: Record<string, string>;
}

const PLUGIN_SOURCE_CLASSES: Record<string, true> = {
  Script: true,
  ModuleScript: true,
  LocalScript: true,
};

function parsePluginScriptSources(source: Buffer, assetName: string): string[] {
  if (!isUtf8(source)) {
    throw new Error(`${assetName} is not valid UTF-8 Roblox XML.`);
  }

  const text = source.toString('utf8');
  const elementStack: ParsedPluginElement[] = [];
  const scriptSources: string[] = [];
  let rootName: string | undefined;
  let currentSource: { depth: number; text: string } | undefined;
  const parser = new SaxesParser({ fragment: false, xmlns: false });

  parser.on('doctype', () => {
    throw new Error('DOCTYPE declarations are not allowed in plugin artifacts.');
  });
  parser.on('opentag', (tag) => {
    if (elementStack.length === 0) rootName = tag.name;

    if (
      currentSource === undefined &&
      tag.name === 'string' &&
      tag.attributes.name === 'Source'
    ) {
      const nearestItem = [...elementStack]
        .reverse()
        .find((element) => element.name === 'Item');
      const sourceClass = nearestItem?.attributes.class;
      if (
        sourceClass !== undefined &&
        PLUGIN_SOURCE_CLASSES[sourceClass] === true
      ) {
        currentSource = { depth: elementStack.length, text: '' };
      }
    }

    elementStack.push({ name: tag.name, attributes: tag.attributes });
  });
  parser.on('text', (value) => {
    if (currentSource !== undefined) currentSource.text += value;
  });
  parser.on('cdata', (value) => {
    if (currentSource !== undefined) currentSource.text += value;
  });
  parser.on('closetag', (tag) => {
    if (
      currentSource !== undefined &&
      tag.name === 'string' &&
      elementStack.length === currentSource.depth + 1
    ) {
      scriptSources.push(currentSource.text);
      currentSource = undefined;
    }
    elementStack.pop();
  });

  try {
    parser.write(text).close();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${assetName} is not well-formed Roblox XML: ${detail}`, {
      cause: error,
    });
  }

  if (rootName !== 'roblox' || scriptSources.length === 0) {
    throw new Error(
      `${assetName} is not a Roblox XML model containing a Script source.`,
    );
  }
  return scriptSources;
}

function assertPluginAssetIdentity(
  source: Buffer,
  assetName: string,
  expectedVersion: string,
  expectedVariant: PluginVariant,
): void {
  const pluginSource = parsePluginScriptSources(source, assetName).join('\n');
  const actualVersion = embeddedPluginValue(
    pluginSource,
    'CURRENT_VERSION',
    assetName,
  );
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${assetName} embeds version ${actualVersion}; expected ${expectedVersion}.`,
    );
  }

  const actualVariant = embeddedPluginValue(pluginSource, 'PLUGIN_VARIANT', assetName);
  if (actualVariant !== expectedVariant) {
    throw new Error(
      `${assetName} embeds variant ${actualVariant}; expected ${expectedVariant}.`,
    );
  }
}

function installedFileMatches(source: Buffer, destination: string): boolean {
  if (!existsSync(destination)) return false;
  if (!lstatSync(destination).isFile()) return false;
  const installed = readFileSync(destination);
  return installed.length === source.length && installed.equals(source);
}

/**
 * Configures, validates, and commits a plugin artifact without exposing a
 * partially written live file. The conflicting variant is touched only after
 * the requested target is known to be valid and present.
 */
export function installPluginAsset({
  pluginsFolder,
  assetName,
  otherAssetName,
  source,
  expectedVersion,
  expectedVariant,
  rawPort,
  replaceVariant = true,
  log = console.log,
  warn = console.warn,
}: InstallPluginAssetOptions): PluginInstallResult {
  assertAssetFileName(assetName, 'assetName');
  assertAssetFileName(otherAssetName, 'otherAssetName');
  if (assetName === otherAssetName) {
    throw new Error('assetName and otherAssetName must identify different files.');
  }

  const configured = configurePluginAssetForPort(source, rawPort);
  assertPluginAssetIdentity(configured, assetName, expectedVersion, expectedVariant);

  mkdirSync(pluginsFolder, { recursive: true });
  const destination = join(pluginsFolder, assetName);
  const releaseLock = acquirePluginInstallLock(pluginsFolder, warn);

  try {
    let installed = false;

    if (!installedFileMatches(configured, destination)) {
      const staged = join(
        pluginsFolder,
        `.${assetName}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        writeFileSync(staged, configured, { flag: 'wx' });
        renameSync(staged, destination);
        installed = true;
      } finally {
        try {
          unlinkSync(staged);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            warn(`[install-plugin] Could not remove staging file ${staged}: ${error}`);
          }
        }
      }
    }

    handleVariantConflict({
      pluginsFolder,
      otherAssetName,
      replace: replaceVariant,
      log,
      warn,
    });

    return { destination, installed };
  } finally {
    releaseLock();
  }
}

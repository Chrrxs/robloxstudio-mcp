import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

interface WindowsUserLocalAppData {
  linuxPath: string;
  windowsPath: string;
}

function getWindowsUserLocalAppData(): WindowsUserLocalAppData | null {
  // Resolve Windows %LOCALAPPDATA% from the WSL side and translate it via
  // wslpath. cmd.exe spams a "UNC paths are not supported" warning to stderr
  // when the CWD is on the Linux side - silence it with stdio: 'ignore'.
  try {
    const windowsPath = execSync('cmd.exe /c "echo %LOCALAPPDATA%"', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!windowsPath || windowsPath.includes('%')) return null;
    const linuxPath = execSync(`wslpath -u '${windowsPath.replace(/'/g, "'\\''")}'`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!linuxPath) return null;
    return { linuxPath, windowsPath };
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
    const localAppData = getWindowsUserLocalAppData();
    if (localAppData) return join(localAppData.linuxPath, 'Roblox', 'Plugins');
    console.warn(
      '[install-plugin] WSL detected but could not resolve Windows %LOCALAPPDATA%. ' +
        'Falling back to ~/Documents/Roblox/Plugins/ - you will likely need to copy the rbxmx ' +
        'to /mnt/c/Users/<you>/AppData/Local/Roblox/Plugins/ manually. ' +
        'Set MCP_PLUGINS_DIR to skip detection.',
    );
  }

  return join(homedir(), 'Documents', 'Roblox', 'Plugins');
}

const STALE_TEST_PLUGINS_DIRECTORY = 'RsmcpIsolatedPlugins';

function pluginDirectorySettingPattern(): RegExp {
  return /(<QDir\b[^>]*\bname="PluginsDir"[^>]*>)([\s\S]*?)(<\/QDir>)/gu;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export interface RepairStaleStudioPluginDirectoryOptions {
  settingsPath: string;
  studioPluginsDirectory: string;
}

/**
 * Repairs the relative PluginsDir sentinel used by the live test harness.
 * Other custom Studio plugin directories are user-owned and remain untouched.
 */
export function repairStaleStudioPluginDirectorySetting({
  settingsPath,
  studioPluginsDirectory,
}: RepairStaleStudioPluginDirectoryOptions): boolean {
  if (!existsSync(settingsPath)) return false;
  if (studioPluginsDirectory === '') {
    throw new Error('studioPluginsDirectory must be a non-empty path.');
  }

  const contents = readFileSync(settingsPath, 'utf8');
  const matches = [...contents.matchAll(pluginDirectorySettingPattern())];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Studio.PluginsDir QDir in ${settingsPath}; found ${matches.length}.`,
    );
  }
  if (matches[0][2] !== STALE_TEST_PLUGINS_DIRECTORY) return false;

  const studioPath = escapeXmlText(studioPluginsDirectory);
  const updated = contents.replace(
    pluginDirectorySettingPattern(),
    (_match, open, _value, close) => `${open}${studioPath}${close}`,
  );
  const temporaryPath = `${settingsPath}.rsmcp-install-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, updated, {
      encoding: 'utf8',
      mode: statSync(settingsPath).mode,
    });
    renameSync(temporaryPath, settingsPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return true;
}

function repairDefaultStudioPluginDirectorySetting(
  pluginsFolder: string,
  log: (message: string) => void,
): void {
  // Explicit overrides pair with an isolated Studio working directory. The
  // caller owns that relationship, so never rewrite the global Studio setting.
  if (process.env.MCP_PLUGINS_DIR) return;

  let settingsPath: string;
  let defaultPluginsFolder: string;
  let studioPluginsDirectory: string;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    defaultPluginsFolder = join(localAppData, 'Roblox', 'Plugins');
    settingsPath = join(localAppData, 'Roblox', 'GlobalSettings_13.xml');
    studioPluginsDirectory = defaultPluginsFolder.replaceAll('\\', '/');
  } else if (isWSL()) {
    const localAppData = getWindowsUserLocalAppData();
    if (!localAppData) return;
    defaultPluginsFolder = join(localAppData.linuxPath, 'Roblox', 'Plugins');
    settingsPath = join(localAppData.linuxPath, 'Roblox', 'GlobalSettings_13.xml');
    studioPluginsDirectory = [
      localAppData.windowsPath.replace(/[\\/]+$/u, ''),
      'Roblox',
      'Plugins',
    ].join('/').replaceAll('\\', '/');
  } else {
    return;
  }

  if (pluginsFolder !== defaultPluginsFolder) return;
  if (repairStaleStudioPluginDirectorySetting({ settingsPath, studioPluginsDirectory })) {
    log(`Restored Studio PluginsDir to ${studioPluginsDirectory}.`);
  }
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

    repairDefaultStudioPluginDirectorySetting(pluginsFolder, log);

    return { destination, installed };
  } finally {
    releaseLock();
  }
}

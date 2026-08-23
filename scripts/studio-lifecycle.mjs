#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';

const STUDIO_PROCESS = 'RobloxStudioBeta';
const DEFAULT_MCP_PORT = Number.parseInt(process.env.ROBLOX_STUDIO_PORT ?? '58741', 10);
export const ISOLATED_STUDIO_PLUGINS_DIR_NAME = 'RsmcpIsolatedPlugins';
const STUDIO_WORKER_ROOT_NAME = 'robloxstudio-mcp-workers';

export function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function powershell(script) {
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'powershell.exe';
  return run(exe, ['-NoProfile', '-Command', script], {
    cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
  });
}

export function windowsLocalAppData() {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA;
  if (!isWsl()) return undefined;
  try {
    return run('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], {
      cwd: existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
    });
  } catch {
    return undefined;
  }
}

function toWslPath(windowsPath) {
  if (!windowsPath || process.platform === 'win32') return windowsPath;
  if (!isWsl()) return windowsPath;
  return run('wslpath', ['-u', windowsPath]);
}

function toStudioLaunchArg(arg) {
  if (!isWsl() || !path.isAbsolute(arg) || !existsSync(arg)) return arg;
  return run('wslpath', ['-w', arg]);
}

export function resolveStudioGlobalSettingsPath() {
  const localAppData = windowsLocalAppData();
  if (!localAppData) {
    throw new Error('Studio directory isolation is supported only on Windows and WSL.');
  }
  return path.join(toWslPath(localAppData), 'Roblox', 'GlobalSettings_13.xml');
}

export function resolveStudioLogsDir() {
  const localAppData = windowsLocalAppData();
  if (!localAppData) {
    throw new Error('Roblox Studio Windows logs are available only on Windows and WSL.');
  }
  return path.join(toWslPath(localAppData), 'Roblox', 'logs');
}

function pluginDirectorySettingPattern() {
  return /(<QDir\b[^>]*\bname="PluginsDir"[^>]*>)([\s\S]*?)(<\/QDir>)/gu;
}

export function readStudioPluginDirectorySetting(
  settingsPath = resolveStudioGlobalSettingsPath(),
) {
  if (!existsSync(settingsPath)) {
    throw new Error(
      `Roblox Studio settings were not found at ${settingsPath}. Launch and close Studio once, then retry.`,
    );
  }
  const contents = readFileSync(settingsPath, 'utf8');
  const matches = [...contents.matchAll(pluginDirectorySettingPattern())];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Studio.PluginsDir QDir in ${settingsPath}; found ${matches.length}.`,
    );
  }
  return {
    settingsPath,
    value: matches[0][2],
    configured: matches[0][2] === ISOLATED_STUDIO_PLUGINS_DIR_NAME,
  };
}

export async function configureStudioDirectoryIsolation({
  settingsPath = resolveStudioGlobalSettingsPath(),
  relativePluginsDirectory = ISOLATED_STUDIO_PLUGINS_DIR_NAME,
  requireStudioClosed = true,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(relativePluginsDirectory)) {
    throw new Error('relativePluginsDirectory must be one relative directory name.');
  }
  const releaseSettingsLock = await lockfile.lock(settingsPath, {
    realpath: true,
    stale: 30000,
    retries: {
      retries: 600,
      factor: 1,
      minTimeout: 50,
      maxTimeout: 50,
    },
  });
  try {
    const current = readStudioPluginDirectorySetting(settingsPath);
    if (current.value === relativePluginsDirectory) {
      return { ...current, configured: true, changed: false };
    }
    const running = requireStudioClosed ? listStudioProcesses({ strict: true }) : [];
    if (running.length > 0) {
      throw new Error(
        `Close Roblox Studio before configuring directory isolation; running processes: ${JSON.stringify(running)}`,
      );
    }

    const contents = readFileSync(settingsPath, 'utf8');
    const updated = contents.replace(
      pluginDirectorySettingPattern(),
      (_match, open, _value, close) => `${open}${relativePluginsDirectory}${close}`,
    );
    const temporaryPath = `${settingsPath}.rsmcp-${process.pid}-${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, updated, {
        encoding: 'utf8',
        mode: statSync(settingsPath).mode,
      });
      renameSync(temporaryPath, settingsPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }

    const configured = readStudioPluginDirectorySetting(settingsPath);
    if (configured.value !== relativePluginsDirectory) {
      throw new Error(`Studio.PluginsDir remained ${JSON.stringify(configured.value)} after configuration.`);
    }
    return { ...configured, configured: true, changed: true };
  } finally {
    await releaseSettingsLock();
  }
}

export function createIsolatedStudioDirectory({ prefix = 'worker' } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(prefix)) {
    throw new Error('Studio worker prefix must contain only letters, numbers, dot, underscore, or dash.');
  }
  const localAppData = windowsLocalAppData();
  if (!localAppData) {
    throw new Error('Studio directory isolation is supported only on Windows and WSL.');
  }
  const parent = path.join(toWslPath(localAppData), 'Temp', STUDIO_WORKER_ROOT_NAME);
  mkdirSync(parent, { recursive: true });
  const workingDirectory = mkdtempSync(path.join(parent, `${prefix}-`));
  const pluginsDirectory = path.join(workingDirectory, ISOLATED_STUDIO_PLUGINS_DIR_NAME);
  mkdirSync(pluginsDirectory);
  let cleaned = false;
  return {
    workingDirectory,
    pluginsDirectory,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(workingDirectory, { recursive: true, force: true });
    },
  };
}

export function resolvePluginsDir() {
  if (process.env.MCP_PLUGINS_DIR) return process.env.MCP_PLUGINS_DIR;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Roblox', 'Plugins');
  }
  if (isWsl()) {
    const localAppData = windowsLocalAppData();
    if (localAppData) return path.join(toWslPath(localAppData), 'Roblox', 'Plugins');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
  return path.join(os.homedir(), 'Documents', 'Roblox', 'Plugins');
}

export function resolveStudioExe() {
  if (process.env.ROBLOX_STUDIO_EXE) return process.env.ROBLOX_STUDIO_EXE;

  if (process.platform === 'darwin') {
    return '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
  }

  const localAppData = windowsLocalAppData();
  const root = localAppData
    ? path.join(toWslPath(localAppData), 'Roblox', 'Versions')
    : path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Versions');
  if (!existsSync(root)) {
    throw new Error(`Roblox Studio Versions folder not found: ${root}. Set ROBLOX_STUDIO_EXE.`);
  }

  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('version-'))
    .map((name) => path.join(root, name, 'RobloxStudioBeta.exe'))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`RobloxStudioBeta.exe not found under ${root}. Set ROBLOX_STUDIO_EXE.`);
  }
  return candidates[0];
}

export function listStudioProcesses({ strict = false } = {}) {
  if (process.platform === 'darwin') {
    let out = '';
    try {
      out = run('pgrep', ['-fl', 'RobloxStudio']);
    } catch (error) {
      if (error?.status === 1) return [];
      if (strict) {
        throw new Error('Unable to enumerate Roblox Studio processes.', { cause: error });
      }
      return [];
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, ...rest] = line.trim().split(/\s+/);
        return { Id: Number(pid), Path: rest.join(' '), MainWindowTitle: '' };
      });
  }

  try {
    const out = powershell([
      "$ErrorActionPreference = 'Stop'",
      `$studio = @(); try { $studio = @(Get-Process ${STUDIO_PROCESS} -ErrorAction Stop) } catch { if ($_.FullyQualifiedErrorId -notlike "NoProcessFoundForGivenName,*") { throw } }`,
      '$studio | Select-Object Id,Path,MainWindowTitle | ConvertTo-Json -Compress',
    ].join('; '));
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    if (strict) {
      throw new Error('Unable to enumerate Roblox Studio processes.', { cause: error });
    }
    return [];
  }
}

export async function closeStudioProcess({
  processId,
  startedAtFileTime,
  timeoutMs = 30000,
}) {
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error('Studio processId must be a positive integer.');
  }
  if (!/^[1-9]\d*$/u.test(String(startedAtFileTime))) {
    throw new Error('Studio startedAtFileTime must be a positive FILETIME string.');
  }
  const expected = `[long]${startedAtFileTime}`;
  const result = powershell([
    `$studio = Get-Process -Id ${processId} -ErrorAction SilentlyContinue`,
    'if ($null -eq $studio) { "NOT_FOUND"; return }',
    `$expected = ${expected}`,
    '$actual = $studio.StartTime.ToUniversalTime().ToFileTimeUtc()',
    'if ($actual -ne $expected) { "IDENTITY_MISMATCH"; return }',
    '$studio.Kill()',
    '$studio.WaitForExit()',
    '"STOPPED"',
  ].join('; '));
  if (result.includes('IDENTITY_MISMATCH')) {
    throw new Error(`Studio process ${processId} no longer has the expected creation identity.`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listStudioProcesses({ strict: true }).some((process) => process.Id === processId)) {
      return { status: result.includes('STOPPED') ? 'stopped' : 'already_stopped', processId };
    }
    await delay(250);
  }
  throw new Error(`Studio process ${processId} remained alive after exact close.`);
}

export async function closeAllStudio({ requireEnv = true, timeoutMs = 30000 } = {}) {
  if (requireEnv && process.env.RSMCP_E2E_CLOSE_ALL_STUDIO !== '1') {
    throw new Error('Refusing to close Studio. Set RSMCP_E2E_CLOSE_ALL_STUDIO=1.');
  }

  if (process.platform === 'darwin') {
    try {
      run('pkill', ['-f', 'RobloxStudio']);
    } catch {
      // No matching process.
    }
  } else {
    try {
      powershell(`Get-Process ${STUDIO_PROCESS} -ErrorAction SilentlyContinue | Stop-Process -Force`);
    } catch {
      // No matching process.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listStudioProcesses().length === 0) return;
    await delay(500);
  }
  throw new Error(`Studio processes still running: ${JSON.stringify(listStudioProcesses())}`);
}

export function launchStudio(args = [], { workingDirectory } = {}) {
  const exe = resolveStudioExe();
  const studioArgs = args.map(toStudioLaunchArg);
  const cwd = workingDirectory ?? process.env.RSMCP_STUDIO_WORKING_DIRECTORY ??
    (isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd());
  const proc = spawn(exe, studioArgs, {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  return { pid: proc.pid, exe, args: studioArgs, workingDirectory: cwd };
}

function readHealth(port = DEFAULT_MCP_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('health timeout')));
  });
}

export async function waitConnected({ timeoutMs = 120000, variant, version } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const health = await readHealth();
      last = health;
      const instances = Array.isArray(health.instances) ? health.instances : [];
      const edit = instances.find((inst) => inst.role === 'edit');
      if (edit) {
        if (variant && edit.pluginVariant !== variant) {
          throw new Error(`Connected plugin variant ${edit.pluginVariant}, expected ${variant}`);
        }
        if (version && edit.pluginVersion !== version) {
          throw new Error(`Connected plugin version ${edit.pluginVersion}, expected ${version}`);
        }
        return health;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(1000);
  }
  throw new Error(`Studio did not connect within ${timeoutMs}ms. Last health: ${JSON.stringify(last)}`);
}

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

async function main() {
  const command = process.argv[2] ?? 'status';
  if (command === 'status') {
    let studioExe;
    try {
      studioExe = resolveStudioExe();
    } catch {
      studioExe = undefined;
    }
    console.log(JSON.stringify({
      processes: listStudioProcesses(),
      pluginsDir: resolvePluginsDir(),
      studioExe: studioExe && existsSync(studioExe) ? studioExe : undefined,
      pluginDirectorySetting: (() => {
        try {
          return readStudioPluginDirectorySetting();
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      })(),
    }, null, 2));
    return;
  }
  if (command === 'close-all') {
    await closeAllStudio();
    console.log(JSON.stringify({ processes: listStudioProcesses() }, null, 2));
    return;
  }
  if (command === 'configure-plugin-isolation') {
    console.log(JSON.stringify(await configureStudioDirectoryIsolation(), null, 2));
    return;
  }
  if (command === 'launch') {
    console.log(JSON.stringify(launchStudio(process.argv.slice(3)), null, 2));
    return;
  }
  if (command === 'wait-connected') {
    const timeoutMs = Number(argValue('--timeout-ms', '120000'));
    const variant = argValue('--variant', undefined);
    const version = argValue('--version', undefined);
    console.log(JSON.stringify(await waitConnected({ timeoutMs, variant, version }), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

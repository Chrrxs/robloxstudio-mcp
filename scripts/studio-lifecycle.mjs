#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
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
import { rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { SaxesParser } from 'saxes';
import { withStudioTestLaunch } from './studio-test-safety.mjs';
import { createStudioWorkerJob, launchInStudioWorkerJob, STUDIO_WORKER_JOB_ENV } from './studio-worker-job.mjs';

const STUDIO_PROCESS = 'RobloxStudioBeta';
const DEFAULT_MCP_PORT = Number.parseInt(process.env.ROBLOX_STUDIO_PORT ?? '58741', 10);
export const ISOLATED_STUDIO_PLUGINS_DIR_NAME = 'RsmcpIsolatedPlugins';
const STUDIO_WORKER_ROOT_NAME = 'robloxstudio-mcp-workers';
const TEST_PROFILE_MARKER_NAME = 'studio-test-profile.json';
const TEST_PROFILE_SETUP = 'node scripts/studio-test-profile.mjs setup --user MACHINE\\StudioTests';

function normalizedWindowsPath(value) {
  return typeof value === 'string' && /^[A-Za-z]:[\\/]/u.test(value)
    ? path.win32.normalize(value).replace(/[\\/]$/u, '').toLowerCase()
    : undefined;
}

export function probeWindowsStudioIdentity() {
  if (process.platform !== 'win32' && !isWsl()) {
    throw new Error('Studio test profiles require Windows, or WSL with Windows PowerShell available.');
  }
  const result = powershell([
    "$ErrorActionPreference = 'Stop'",
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sid = $identity.User.Value',
    '$profile = (Get-ItemProperty -LiteralPath ("Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\" + $sid) -Name ProfileImagePath).ProfileImagePath',
    '$machineEnvironment = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")',
    '$userEnvironment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")',
    '$machinePath = $machineEnvironment.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '$userPath = if ($null -ne $userEnvironment) { $userEnvironment.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { "" }',
    '[pscustomobject]@{ sid = $sid; accountName = $identity.Name; profileDirectory = [Environment]::ExpandEnvironmentVariables($profile); localAppData = [Environment]::GetFolderPath("LocalApplicationData"); roamingAppData = [Environment]::GetFolderPath("ApplicationData"); machinePath = $machinePath; userPath = $userPath; environmentProfileDirectory = $env:USERPROFILE; environmentLocalAppData = $env:LOCALAPPDATA; profileLoaded = (Test-Path -LiteralPath ("Registry::HKEY_USERS\\" + $sid)); interactiveSession = ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0) } | ConvertTo-Json -Compress',
  ].join('; '));
  return JSON.parse(result);
}

function assertWindowsStudioIdentity(identity) {
  if (!identity || !/^S-1-5-21-(?:\d+-){3}\d+$/u.test(identity.sid ?? '')) {
    throw new Error('Studio tests require an ordinary dedicated Windows local/domain user, not a service identity.');
  }
  const profile = normalizedWindowsPath(identity.profileDirectory);
  const localAppData = normalizedWindowsPath(identity.localAppData);
  if (!identity.profileLoaded || !identity.interactiveSession) {
    throw new Error('Studio tests need a loaded Windows user profile in an interactive desktop session. Sign in as the dedicated test user once; do not run Studio as a service.');
  }
  if (!profile || !localAppData || !localAppData.startsWith(`${profile}\\`) ||
      normalizedWindowsPath(identity.environmentProfileDirectory) !== profile ||
      normalizedWindowsPath(identity.environmentLocalAppData) !== localAppData) {
    throw new Error('Windows identity/profile paths disagree or are redirected outside the actual profile. Run the entire harness through scripts/studio-test-profile.mjs; environment-only profile redirection is not supported.');
  }
}

function testProfileMarkerPath(identity) {
  return path.join(toWslPath(identity.localAppData), 'robloxstudio-mcp', TEST_PROFILE_MARKER_NAME);
}

function readTestProfileEnrollment(identity) {
  const markerPath = testProfileMarkerPath(identity);
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new Error(`No readable Studio test-profile enrollment at ${markerPath}. Authorize automated setup for the dedicated Windows account: ${TEST_PROFILE_SETUP}`, { cause: error });
  }
}

export function assertStudioTestProfile({
  identityProbe = probeWindowsStudioIdentity,
  readEnrollment = readTestProfileEnrollment,
} = {}) {
  const identity = identityProbe();
  assertWindowsStudioIdentity(identity);
  const enrollment = readEnrollment(identity);
  if (!enrollment || enrollment.version !== 1 || enrollment.dedicatedTestProfile !== true ||
      enrollment.sid !== identity.sid ||
      !/^S-1-5-21-(?:\d+-){3}\d+$/u.test(enrollment.sourceSid ?? '') ||
      enrollment.sourceSid === identity.sid ||
      normalizedWindowsPath(enrollment.profileDirectory) !== normalizedWindowsPath(identity.profileDirectory) ||
      normalizedWindowsPath(enrollment.localAppData) !== normalizedWindowsPath(identity.localAppData)) {
    throw new Error(`Studio test-profile enrollment does not match this Windows SID/profile, or reuses the personal/source identity. Run from a separate personal account: ${TEST_PROFILE_SETUP}`);
  }
  return identity;
}

async function enrollStudioTestProfile({ sourceSid, confirmDedicatedProfile }) {
  if (!confirmDedicatedProfile) {
    throw new Error(`Enrollment requires explicit --confirm-dedicated-profile. Use: ${TEST_PROFILE_SETUP}`);
  }
  const identity = probeWindowsStudioIdentity();
  assertWindowsStudioIdentity(identity);
  if (!/^S-1-5-21-(?:\d+-){3}\d+$/u.test(sourceSid ?? '') || sourceSid === identity.sid) {
    throw new Error('Enrollment must execute under a different Windows SID from the personal/source account. Use scripts/studio-test-profile.mjs enroll --user MACHINE\\StudioTests --confirm-dedicated-profile.');
  }
  const settings = await configureStudioDirectoryIsolation({ initializeIfMissing: true, freezeSettings: true });
  const markerPath = testProfileMarkerPath(identity);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify({
    version: 1,
    dedicatedTestProfile: true,
    sid: identity.sid,
    sourceSid,
    profileDirectory: identity.profileDirectory,
    localAppData: identity.localAppData,
  }, null, 2)}\n`, { mode: 0o600 });
  return { identity: assertStudioTestProfile(), settings, markerPath };
}

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

export function windowsPowerShellEnvironment(inherited = process.env) {
  // PowerShell 7's module paths break Windows PowerShell autoloading when Node
  // sits between the two shells. Let the new engine build its own module path.
  return Object.fromEntries(Object.entries(inherited).filter(
    ([key]) => !/^(?:PSModulePath|WinPSModulePath)$/iu.test(key),
  ));
}

function powershell(script) {
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'powershell.exe';
  return run(exe, ['-NoProfile', '-Command', script], {
    cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
    env: windowsPowerShellEnvironment(),
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

function missingStudioSettingsError(settingsPath) {
  return new Error(`Roblox Studio settings were not found at ${settingsPath}. Routine startup never creates settings. Enroll the dedicated test account to initialize isolated settings: ${TEST_PROFILE_SETUP}`);
}

function parseStudioSettings(contents, settingsPath) {
  const parser = new SaxesParser();
  const stack = [];
  const studioItems = [];
  let root;
  let openingStart;
  parser.on('doctype', () => {
    throw new Error('DOCTYPE is not supported in Studio settings.');
  });
  parser.on('opentagstart', () => {
    openingStart = contents.lastIndexOf('<', parser.position - 1);
  });
  parser.on('opentag', (tag) => {
    const parent = stack.at(-1);
    const node = {
      name: tag.name,
      attributes: tag.attributes,
      start: openingStart,
      contentStart: parser.position,
      selfClosing: tag.isSelfClosing,
      children: [],
      text: '',
    };
    if (parent) parent.children.push(node);
    else root = node;
    if (tag.name === 'Item' && tag.attributes.class === 'Studio') {
      if (parent !== root) throw new Error('Studio Item must be a direct child of roblox.');
      studioItems.push(node);
    }
    stack.push(node);
  });
  const appendText = (text) => {
    const node = stack.at(-1);
    if (node) node.text += text;
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    const node = stack.pop();
    node.end = parser.position;
    node.contentEnd = node.selfClosing ? node.contentStart : contents.lastIndexOf('</', node.end - 1);
  });
  try {
    parser.write(contents).close();
    if (root?.name !== 'roblox' || root.attributes.version !== '4') {
      throw new Error('Expected a roblox version="4" settings document.');
    }
    if (studioItems.length !== 1) {
      throw new Error(`Expected exactly one Studio Item; found ${studioItems.length}.`);
    }
    const propertiesNodes = studioItems[0].children.filter((node) => node.name === 'Properties');
    if (propertiesNodes.length !== 1) {
      throw new Error(`Expected exactly one Studio Properties element; found ${propertiesNodes.length}.`);
    }
    const properties = propertiesNodes[0];
    const plugins = properties.children.filter((node) => node.attributes.name === 'PluginsDir');
    if (plugins.length > 1) {
      throw new Error(`Expected at most one Studio.PluginsDir property; found ${plugins.length}.`);
    }
    const plugin = plugins[0];
    if (plugin && (plugin.name !== 'QDir' || plugin.children.length > 0)) {
      throw new Error('Studio.PluginsDir must be a text-only QDir element.');
    }
    return { properties, plugin };
  } catch (error) {
    throw new Error(`Invalid Roblox Studio settings at ${settingsPath}: ${error.message}`, { cause: error });
  }
}

export function readStudioPluginDirectorySetting(
  settingsPath = resolveStudioGlobalSettingsPath(),
) {
  if (!existsSync(settingsPath)) throw missingStudioSettingsError(settingsPath);
  const { plugin } = parseStudioSettings(readFileSync(settingsPath, 'utf8'), settingsPath);
  return {
    settingsPath,
    value: plugin?.text ?? null,
    configured: plugin?.text === ISOLATED_STUDIO_PLUGINS_DIR_NAME,
    readOnly: (statSync(settingsPath).mode & 0o222) === 0,
  };
}

export function assertStudioDirectoryIsolation({
  settingsPath = resolveStudioGlobalSettingsPath(),
  requireReadOnly = true,
} = {}) {
  const current = readStudioPluginDirectorySetting(settingsPath);
  if (!current.configured) {
    throw new Error(`Studio.PluginsDir in ${settingsPath} must be ${JSON.stringify(ISOLATED_STUDIO_PLUGINS_DIR_NAME)}, not ${JSON.stringify(current.value)}. Routine startup never edits settings. Close Studio and explicitly enroll the dedicated test account: ${TEST_PROFILE_SETUP}`);
  }
  if (requireReadOnly && !current.readOnly) {
    throw new Error(`Studio settings at ${settingsPath} must be read-only so Studio cannot rewrite the isolated PluginsDir. Routine startup never edits settings or permissions. Close Studio and explicitly enroll the dedicated test account: ${TEST_PROFILE_SETUP}`);
  }
  return current;
}

export async function configureStudioDirectoryIsolation({
  settingsPath = resolveStudioGlobalSettingsPath(),
  relativePluginsDirectory = ISOLATED_STUDIO_PLUGINS_DIR_NAME,
  requireStudioClosed = true,
  initializeIfMissing = false,
  freezeSettings = false,
  processProbe = listStudioProcesses,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(relativePluginsDirectory)) {
    throw new Error('relativePluginsDirectory must be one relative directory name.');
  }
  const assertStudioClosed = () => {
    const running = requireStudioClosed ? processProbe({ strict: true, currentUserOnly: true }) : [];
    if (running.length > 0) {
      throw new Error(`Close Roblox Studio in the current test profile before configuring directory isolation; running processes: ${JSON.stringify(running)}`);
    }
  };
  if (!existsSync(settingsPath)) {
    if (!initializeIfMissing) throw missingStudioSettingsError(settingsPath);
    assertStudioClosed();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  const releaseSettingsLock = await lockfile.lock(settingsPath, {
    realpath: false,
    stale: 30000,
    retries: {
      retries: 600,
      factor: 1,
      minTimeout: 50,
      maxTimeout: 50,
    },
  });
  try {
    const created = !existsSync(settingsPath);
    if (created && !initializeIfMissing) throw missingStudioSettingsError(settingsPath);
    const contents = created ? undefined : readFileSync(settingsPath, 'utf8');
    const document = created ? undefined : parseStudioSettings(contents, settingsPath);
    const originalMode = created ? undefined : statSync(settingsPath).mode & 0o7777;
    const readOnly = !created && (originalMode & 0o222) === 0;
    if (document?.plugin?.text === relativePluginsDirectory) {
      if (freezeSettings && !readOnly) {
        assertStudioClosed();
        chmodSync(settingsPath, originalMode & ~0o222);
        return { ...readStudioPluginDirectorySetting(settingsPath), configured: true, created: false, changed: true };
      }
      return { settingsPath, value: relativePluginsDirectory, configured: true, readOnly, created: false, changed: false };
    }
    assertStudioClosed();

    let updated;
    if (created) {
      updated = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<roblox xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
        '  <Item class="Studio" referent="RBX0">',
        '    <Properties>',
        `      <QDir name="PluginsDir">${relativePluginsDirectory}</QDir>`,
        '    </Properties>',
        '  </Item>',
        '</roblox>',
        '',
      ].join('\n');
    } else {
      const { plugin, properties } = document;
      const node = plugin ?? properties;
      if (node.selfClosing) {
        const opening = contents.slice(node.start, node.contentStart - 2);
        const value = plugin ? relativePluginsDirectory : `<QDir name="PluginsDir">${relativePluginsDirectory}</QDir>`;
        updated = `${contents.slice(0, node.start)}${opening}>${value}</${node.name}>${contents.slice(node.end)}`;
      } else if (plugin) {
        updated = `${contents.slice(0, plugin.contentStart)}${relativePluginsDirectory}${contents.slice(plugin.contentEnd)}`;
      } else {
        const property = `<QDir name="PluginsDir">${relativePluginsDirectory}</QDir>`;
        updated = `${contents.slice(0, properties.contentEnd)}${property}${contents.slice(properties.contentEnd)}`;
      }
    }
    const temporaryPath = `${settingsPath}.rsmcp-${process.pid}-${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, updated, {
        encoding: 'utf8',
        mode: created ? 0o600 : originalMode | 0o200,
        flag: 'wx',
      });
      const temporaryMode = created ? statSync(temporaryPath).mode & 0o7777 : originalMode;
      if (freezeSettings || !created) {
        chmodSync(temporaryPath, freezeSettings ? temporaryMode & ~0o222 : temporaryMode);
      }
      try {
        renameSync(temporaryPath, settingsPath);
      } catch (error) {
        if (process.platform !== 'win32' || !readOnly || !['EPERM', 'EACCES'].includes(error.code)) {
          throw error;
        }
        // Windows refuses to replace a ReadOnly destination. Keep the replacement
        // protected, and restore the original protection if replacement fails.
        chmodSync(settingsPath, originalMode | 0o200);
        try {
          renameSync(temporaryPath, settingsPath);
        } catch (replacementError) {
          chmodSync(settingsPath, originalMode);
          throw replacementError;
        }
      }
    } finally {
      if (process.platform === 'win32' && existsSync(temporaryPath)) {
        const mode = statSync(temporaryPath).mode;
        if ((mode & 0o222) === 0) chmodSync(temporaryPath, mode | 0o200);
      }
      rmSync(temporaryPath, { force: true });
    }

    const configured = readStudioPluginDirectorySetting(settingsPath);
    if (configured.value !== relativePluginsDirectory) {
      throw new Error(`Studio.PluginsDir remained ${JSON.stringify(configured.value)} after configuration.`);
    }
    return { ...configured, configured: true, created, changed: true };
  } finally {
    await releaseSettingsLock();
  }
}

export function createStudioWorkerCleanup(directory, { drain, removeDirectory = rm } = {}) {
  if (typeof drain !== 'function') throw new Error('Studio worker cleanup requires retained job ownership.');
  let cleaned = false;
  let pending;
  return async () => {
    if (cleaned) return;
    if (!pending) {
      pending = (async () => {
        await drain();
        await removeDirectory(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        cleaned = true;
      })();
    }
    try { await pending; }
    finally { pending = undefined; }
  };
}

export async function createIsolatedStudioDirectory({ prefix = 'worker', env = process.env } = {}) {
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
  const managedInstanceRegistryDirectory = path.join(workingDirectory, 'managed-instances');
  mkdirSync(managedInstanceRegistryDirectory);
  let lifetime;
  try {
    lifetime = await createStudioWorkerJob(workerJobOptions(env));
  } catch (error) {
    // No launch was possible before the broker acknowledged its new job.
    await rm(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
  return {
    workingDirectory,
    pluginsDirectory,
    managedInstanceRegistryDirectory,
    environment: lifetime.environment,
    cleanup: createStudioWorkerCleanup(workingDirectory, { drain: () => lifetime.drain() }),
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

export function selectInstalledStudioExecutable(root) {
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
  const newest = candidates[0];
  const directory = path.dirname(newest);
  const settings = path.join(directory, 'AppSettings.xml');
  const settingsInfo = statSync(settings, { throwIfNoEntry: false });
  if (readdirSync(directory).some((name) => /\.crdownload$/i.test(name)) ||
      !settingsInfo?.isFile() || settingsInfo.size === 0) {
    throw new Error(`Roblox Studio installation/update is incomplete at ${directory}: unfinished download or missing/empty AppSettings.xml. Complete or repair Studio under its owning account before launching; refusing to fall back to an older version.`);
  }
  return newest;
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
  return selectInstalledStudioExecutable(root);
}

export function listStudioProcesses({ strict = false, currentUserOnly = false } = {}) {
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
      ...(currentUserOnly ? [
        '$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$studio = @($studio | Where-Object { $candidate = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $_.Id); if ($null -eq $candidate) { throw "A Studio process disappeared while checking ownership; retry setup." }; $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid; if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { throw "Cannot determine Studio process ownership; refusing to configure settings." }; $owner.Sid -eq $currentSid })',
      ] : []),
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

function workerJobOptions(env) {
  return {
    env: windowsPowerShellEnvironment(env),
    cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
    toWindowsPath: toStudioLaunchArg,
  };
}

export async function launchStudio(args = [], { workingDirectory, env = process.env } = {}, {
  assertProfile = assertStudioTestProfile,
  assertIsolation = assertStudioDirectoryIsolation,
  resolveExecutable = resolveStudioExe,
  spawnProcess = spawn,
  launchOwnedProcess = launchInStudioWorkerJob,
} = {}) {
  assertProfile();
  assertIsolation();
  if (!env.RSMCP_STUDIO_TEST_SAFETY_DIR) {
    throw new Error('Direct test launches require the guarded dedicated-profile runner: node scripts/studio-test-profile.mjs run -- scripts/studio-lifecycle.mjs launch');
  }
  return withStudioTestLaunch(env, 1, async () => {
    const exe = resolveExecutable();
    const studioArgs = args.map(toStudioLaunchArg);
    const cwd = workingDirectory ?? env.RSMCP_STUDIO_WORKING_DIRECTORY ??
      (isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd());
    if (env[STUDIO_WORKER_JOB_ENV] !== undefined) {
      const pid = await launchOwnedProcess(exe, studioArgs, cwd, workerJobOptions(env));
      return { pid, exe, args: studioArgs, workingDirectory: cwd };
    }
    const proc = spawnProcess(exe, studioArgs, { cwd, env, detached: true, stdio: 'ignore' });
    await once(proc, 'spawn');
    proc.unref();
    return { pid: proc.pid, exe, args: studioArgs, workingDirectory: cwd };
  });
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
    assertStudioTestProfile();
    console.log(JSON.stringify(await configureStudioDirectoryIsolation(), null, 2));
    return;
  }
  if (command === 'enroll-test-profile') {
    console.log(JSON.stringify(await enrollStudioTestProfile({
      sourceSid: argValue('--source-sid', undefined),
      confirmDedicatedProfile: process.argv.includes('--confirm-dedicated-profile'),
    }), null, 2));
    return;
  }
  if (command === 'assert-test-profile') {
    console.log(JSON.stringify({
      identity: assertStudioTestProfile(),
      settings: assertStudioDirectoryIsolation(),
    }, null, 2));
    return;
  }
  if (command === 'launch') {
    console.log(JSON.stringify(await launchStudio(process.argv.slice(3)), null, 2));
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

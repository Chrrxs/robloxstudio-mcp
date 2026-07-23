import { execFile, execFileSync, spawn } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  ManagedInstanceRegistry,
  type ManagedProcessObservation,
  type ManagedInstanceLifecycleState,
  type ManagedInstanceRegistryRecord,
  type RegistrySweepOptions,
} from './managed-instance-registry.js';

export type StudioLaunchSource = 'baseplate' | 'local_file' | 'published_place' | 'place_revision';

export interface StudioProcessEnvironmentPatch {
  set?: Record<string, string>;
  remove?: string[];
}

export interface StudioLaunchOptions {
  source: StudioLaunchSource;
  localPlaceFile?: string;
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
  connectionTimeoutMs?: number;
  studioExecutable?: string;
  processEnvironment?: StudioProcessEnvironmentPatch;
}

export type StudioLaunchState = ManagedInstanceLifecycleState;

export interface ManagedStudioInstance {
  recordId?: string;
  source: StudioLaunchSource;
  instanceId?: string;
  nativeProcessId?: number;
  nativeProcessStartedAt?: string;
  spawnPid?: number;
  exe: string;
  args: string[];
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
  localPlaceFile?: string;
  launchedAt: number;
  connectionDeadlineAt?: number;
  state: StudioLaunchState;
  connectedAt?: number;
  failedAt?: number;
  exitedAt?: number;
  exitCode?: number;
  failureReason?: string;
  closedAt?: number;
  ownerPid?: number;
  bootId?: string;
  deleteLocalPlaceFileOnClose?: boolean;
  processObservationStatus?: 'running' | 'not_running' | 'unknown';
  lastProcessObservationAt?: number;
  lastSuccessfulProcessObservationAt?: number;
  lastProcessObservationError?: string;
  consecutiveConfirmedMisses?: number;
  firstConfirmedMissAt?: number;
}

export interface StudioProcessInfo {
  Id: number;
  Name?: string;
  Path?: string;
  MainWindowTitle?: string;
  CommandLine?: string;
  StartTimeUtcFileTime?: string;
}

export type StudioProcessSnapshot =
  | { status: 'ok'; observedAt: number; processes: StudioProcessInfo[] }
  | { status: 'error'; observedAt: number; error: string };

const BASEPLATE_TEMP_DIR = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
const BASEPLATE_TEMP_NAME = /^Baseplate-\d+-\d+\.rbxl$/;
const BASEPLATE_TEMPLATE_NAME = 'Baseplate.rbxl';

export interface ConnectedStudioInstance {
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
}

type StudioChildProcess = {
  pid?: number;
  nativePid?: number;
  nativeStartedAt?: string;
  unref: () => void;
  onExit?: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  onError?: (listener: (error: Error) => void) => void;
};

export interface StudioProcessAdapter {
  observeStudioProcesses?: () => StudioProcessSnapshot | Promise<StudioProcessSnapshot>;
  listStudioProcesses?: () => StudioProcessInfo[] | Promise<StudioProcessInfo[]>;
  stopProcess?: (processId: number) => unknown | Promise<unknown>;
  resolveStudioExe?: () => string | Promise<string>;
  spawnStudio?: (exe: string, args: string[], options: Parameters<typeof spawn>[2]) => StudioChildProcess | Promise<StudioChildProcess>;
  currentBootId?: () => string | Promise<string>;
}

export interface StudioInstanceManagerOptions {
  registryDir?: string;
  registry?: ManagedInstanceRegistry;
  processAdapter?: StudioProcessAdapter;
  confirmedExitMisses?: number;
  confirmedExitGraceMs?: number;
  snapshotCacheMs?: number;
}

export type ManagedStudioCloseResult =
  | { status: 'closed'; launchId?: string; instanceId?: string }
  | { status: 'already_closed'; launchId?: string; instanceId?: string }
  | { status: 'not_found'; launchId?: string; instanceId?: string };

function run(command: string, args: string[], options: Record<string, unknown> = {}): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

const execFileAsync = promisify(execFile);

async function runAsync(command: string, args: string[], options: Record<string, unknown> = {}): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000,
    killSignal: 'SIGKILL',
    ...options,
  });
  return `${result.stdout}`.trim();
}

export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (!process.env.WSL_INTEROP && !process.env.WSL_DISTRO_NAME) return false;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function powershell(script: string): string {
  return run('powershell.exe', ['-NoProfile', '-Command', script], {
    cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
  });
}

async function powershellAsync(script: string): Promise<string> {
  return runAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
  });
}

function windowsLocalAppData(): string | undefined {
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

async function windowsLocalAppDataAsync(): Promise<string | undefined> {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA;
  if (!isWsl()) return undefined;
  try {
    return await runAsync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], {
      cwd: existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
    });
  } catch {
    return undefined;
  }
}

function toWslPath(windowsPath: string): string {
  if (!isWsl()) return windowsPath;
  return run('wslpath', ['-u', windowsPath]);
}

async function toWslPathAsync(windowsPath: string): Promise<string> {
  if (!isWsl()) return windowsPath;
  return runAsync('wslpath', ['-u', windowsPath]);
}

function toStudioLaunchArg(arg: string): string {
  if (!isWsl() || !path.isAbsolute(arg) || !existsSync(arg)) return arg;
  return run('wslpath', ['-w', arg]);
}

async function toStudioLaunchArgAsync(arg: string): Promise<string> {
  if (!isWsl() || !path.isAbsolute(arg) || !existsSync(arg)) return arg;
  return runAsync('wslpath', ['-w', arg]);
}

function powershellStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function parseStudioProcessEnvironmentPatch(value: unknown): StudioProcessEnvironmentPatch | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('process_environment must be an object when provided.');
  }

  const raw = value as Record<string, unknown>;
  const unsupported = Object.keys(raw).filter((key) => key !== 'set' && key !== 'remove');
  if (unsupported.length > 0) {
    throw new Error(`process_environment contains unsupported field(s): ${unsupported.join(', ')}.`);
  }

  let set: Record<string, string> | undefined;
  if (raw.set !== undefined) {
    if (raw.set === null || typeof raw.set !== 'object' || Array.isArray(raw.set)) {
      throw new Error('process_environment.set must be an object mapping names to string values.');
    }
    set = {};
    for (const [name, setting] of Object.entries(raw.set as Record<string, unknown>)) {
      if (!ENVIRONMENT_VARIABLE_NAME.test(name)) {
        throw new Error(`Invalid process environment variable name "${name}".`);
      }
      if (typeof setting !== 'string') {
        throw new Error(`process_environment.set.${name} must be a string.`);
      }
      if (setting.includes('\0')) {
        throw new Error(`process_environment.set.${name} must not contain a null character.`);
      }
      set[name] = setting;
    }
  }

  let remove: string[] | undefined;
  if (raw.remove !== undefined) {
    if (!Array.isArray(raw.remove) || raw.remove.some((name) => typeof name !== 'string')) {
      throw new Error('process_environment.remove must be an array of environment variable names.');
    }
    remove = [...new Set(raw.remove as string[])];
    for (const name of remove) {
      if (!ENVIRONMENT_VARIABLE_NAME.test(name)) {
        throw new Error(`Invalid process environment variable name "${name}".`);
      }
    }
  }

  return { set, remove };
}

function patchedProcessEnvironment(patch: StudioProcessEnvironmentPatch): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of patch.remove ?? []) delete environment[name];
  for (const [name, value] of Object.entries(patch.set ?? {})) environment[name] = value;
  return environment;
}

function powershellEnvironmentPatchStatements(patch: StudioProcessEnvironmentPatch): string[] {
  const target = '[EnvironmentVariableTarget]::Process';
  return [
    ...(patch.remove ?? []).map((name) =>
      `[Environment]::SetEnvironmentVariable(${powershellStringLiteral(name)}, $null, ${target})`),
    ...Object.entries(patch.set ?? {}).map(([name, value]) =>
      `[Environment]::SetEnvironmentVariable(${powershellStringLiteral(name)}, ${powershellStringLiteral(value)}, ${target})`),
  ];
}

// Implements the quoting rules consumed by CommandLineToArgvW. PowerShell's
// ProcessStartInfo.Arguments is a single command-line string, so paths with
// spaces and trailing backslashes must be escaped before Studio receives them.
export function quoteWindowsCommandLineArg(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

export function buildWindowsStudioStartScript(
  exe: string,
  args: string[],
  processEnvironment?: StudioProcessEnvironmentPatch,
): string {
  return buildWindowsStudioStartScriptFromConvertedExe(toStudioLaunchArg(exe), args, processEnvironment);
}

function buildWindowsStudioStartScriptFromConvertedExe(
  windowsExe: string,
  args: string[],
  processEnvironment?: StudioProcessEnvironmentPatch,
): string {
  const environmentPatch = parseStudioProcessEnvironmentPatch(processEnvironment);
  const commandLine = args.map(quoteWindowsCommandLineArg).join(' ');
  return [
    ...(environmentPatch ? powershellEnvironmentPatchStatements(environmentPatch) : []),
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${powershellStringLiteral(windowsExe)}`,
    `$psi.Arguments = ${powershellStringLiteral(commandLine)}`,
    // With UseShellExecute=false, Studio inherits the synchronous
    // powershell.exe invocation's stdout/stderr pipe handles under WSL. Those
    // handles keep the PowerShell invocation waiting until Studio exits even though
    // PowerShell already printed the PID. Shell execution prevents that
    // inheritance while Process.Start still returns the native Studio PID.
    '$psi.UseShellExecute = $true',
    '$studio = [System.Diagnostics.Process]::Start($psi)',
    'if ($null -eq $studio) { throw "Roblox Studio process did not start." }',
  ].join('; ');
}

async function spawnWindowsStudioFromWsl(
  exe: string,
  args: string[],
  processEnvironment?: StudioProcessEnvironmentPatch,
): Promise<StudioChildProcess> {
  const windowsExe = await toStudioLaunchArgAsync(exe);
  const script = buildWindowsStudioStartScriptFromConvertedExe(windowsExe, args, processEnvironment);
  const output = await powershellAsync(`${script}; [PSCustomObject]@{ pid = $studio.Id; started = $studio.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } | ConvertTo-Json -Compress`);
  const parsed = JSON.parse(output) as { pid?: unknown; started?: unknown };
  const nativePid = Number(parsed.pid);
  const nativeStartedAt = typeof parsed.started === 'string' && /^\d+$/u.test(parsed.started)
    ? parsed.started
    : undefined;
  if (!Number.isSafeInteger(nativePid) || nativePid <= 0) {
    throw new Error(`Could not determine the Windows Studio process id from: ${nativePid}`);
  }
  return {
    pid: nativePid,
    nativePid,
    nativeStartedAt,
    unref: () => {},
  };
}

function resolveEntrypointDir(): string | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;
  try {
    return path.dirname(realpathSync(entrypoint));
  } catch {
    return path.dirname(path.resolve(entrypoint));
  }
}

function resolveBaseplateTemplatePath(): string {
  const entrypointDir = resolveEntrypointDir();
  const candidates = [
    ...(entrypointDir ? [
      path.join(entrypointDir, 'assets', BASEPLATE_TEMPLATE_NAME),
      path.join(entrypointDir, '..', 'assets', BASEPLATE_TEMPLATE_NAME),
    ] : []),
    path.join(process.cwd(), 'packages', 'core', 'assets', BASEPLATE_TEMPLATE_NAME),
    path.join(process.cwd(), 'packages', 'robloxstudio-mcp', 'dist', 'assets', BASEPLATE_TEMPLATE_NAME),
    path.join(process.cwd(), 'assets', BASEPLATE_TEMPLATE_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Baseplate template not found. Expected ${BASEPLATE_TEMPLATE_NAME} in one of: ${candidates.join(', ')}`);
}

const STALE_BASEPLATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BASEPLATE_TEMP_SWEEP_NAME = /^Baseplate-(\d+)-\d+\.rbxl(\.lock)?$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Close-time deletion is best-effort (Windows can hold the place/.lock handle
// briefly after Studio exits) and never happens if the server dies, so old
// files accumulate — Windows never cleans %TEMP% on its own. Sweep anything
// matching our naming pattern that is older than a day.
export function sweepStaleBaseplateFiles(): void {
  let entries: string[];
  try {
    entries = readdirSync(BASEPLATE_TEMP_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_BASEPLATE_MAX_AGE_MS;
  for (const entry of entries) {
    const match = BASEPLATE_TEMP_SWEEP_NAME.exec(entry);
    if (!match) continue;
    // Owner server still running → its instance may still have the file open
    // (a WSL server can unlink a file Studio holds open across \\wsl.localhost).
    if (Number(match[1]) !== process.pid && isProcessAlive(Number(match[1]))) continue;
    const file = path.join(BASEPLATE_TEMP_DIR, entry);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      // Still locked or already gone; retry on a future sweep.
    }
  }
}

function createBaseplatePlaceFile(): string {
  mkdirSync(BASEPLATE_TEMP_DIR, { recursive: true });
  sweepStaleBaseplateFiles();
  const file = path.join(BASEPLATE_TEMP_DIR, `Baseplate-${process.pid}-${Date.now()}.rbxl`);
  copyFileSync(resolveBaseplateTemplatePath(), file);
  return file;
}

function isGeneratedBaseplatePlaceFile(file: string): boolean {
  const resolvedFile = path.resolve(file);
  return path.dirname(resolvedFile) === path.resolve(BASEPLATE_TEMP_DIR) &&
    BASEPLATE_TEMP_NAME.test(path.basename(resolvedFile));
}

export function cleanupManagedBaseplateFiles(record: Pick<ManagedStudioInstance, 'source' | 'localPlaceFile'>): void {
  if (record.source !== 'baseplate' || !record.localPlaceFile) return;
  if (!isGeneratedBaseplatePlaceFile(record.localPlaceFile)) return;

  // Best effort: on Windows, Studio can hold the place/.lock handle for a
  // moment after close, so rmSync may throw EPERM/EBUSY. A leftover file in
  // the dedicated temp dir is harmless and must not fail the close itself.
  for (const file of [record.localPlaceFile, `${record.localPlaceFile}.lock`]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // Locked by a lingering Studio handle; leave it for the OS temp cleanup.
    }
  }
}

function prepareStudioLaunchOptions(options: StudioLaunchOptions): StudioLaunchOptions {
  if (options.source !== 'baseplate' || options.localPlaceFile) return options;
  return {
    ...options,
    localPlaceFile: createBaseplatePlaceFile(),
  };
}

export function resolveStudioExe(): string {
  if (process.env.ROBLOX_STUDIO_EXE) return process.env.ROBLOX_STUDIO_EXE;

  if (process.platform === 'darwin') {
    return '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
  }

  if (process.platform !== 'win32' && !isWsl()) {
    throw new Error('Roblox Studio executable auto-discovery is only supported on Windows, WSL, and macOS. Set ROBLOX_STUDIO_EXE.');
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

async function resolveStudioExeAsync(): Promise<string> {
  if (process.env.ROBLOX_STUDIO_EXE) return process.env.ROBLOX_STUDIO_EXE;
  if (process.platform === 'darwin') {
    return '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
  }
  if (process.platform !== 'win32' && !isWsl()) {
    throw new Error('Roblox Studio executable auto-discovery is only supported on Windows, WSL, and macOS. Set ROBLOX_STUDIO_EXE.');
  }

  const localAppData = await windowsLocalAppDataAsync();
  const root = localAppData
    ? path.join(await toWslPathAsync(localAppData), 'Roblox', 'Versions')
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

export function listStudioProcesses(): StudioProcessInfo[] {
  if (process.platform === 'darwin') {
    let out = '';
    try {
      out = run('pgrep', ['-fl', 'RobloxStudio']);
    } catch (error) {
      if ((error as { status?: unknown }).status === 1) return [];
      throw new Error(`Could not enumerate Roblox Studio processes: ${error instanceof Error ? error.message : String(error)}`);
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, ...rest] = line.trim().split(/\s+/);
        return { Id: Number(pid), Name: 'RobloxStudio', Path: rest.join(' '), MainWindowTitle: '' };
      })
      .filter((proc) => Number.isFinite(proc.Id));
  }

  if (process.platform !== 'win32' && !isWsl()) return [];

  let out = '';
  try {
    out = powershell(
      'Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { [PSCustomObject]@{ Id = $_.Id; Name = $_.Name; Path = $_.Path; ' +
      'MainWindowTitle = $_.MainWindowTitle; StartTimeUtcFileTime = $_.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } } | ' +
      'ConvertTo-Json -Compress',
    );
  } catch (error) {
    throw new Error(`Could not enumerate Roblox Studio processes: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function observeStudioProcesses(): Promise<StudioProcessSnapshot> {
  const observedAt = Date.now();
  try {
    if (process.platform === 'darwin') {
      let out = '';
      try {
        out = await runAsync('pgrep', ['-fl', 'RobloxStudio']);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (Number(code) === 1) return { status: 'ok', observedAt, processes: [] };
        throw error;
      }
      const processes = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [pid, ...rest] = line.trim().split(/\s+/);
          return { Id: Number(pid), Name: 'RobloxStudio', Path: rest.join(' '), MainWindowTitle: '' };
        })
        .filter((proc) => Number.isFinite(proc.Id));
      return { status: 'ok', observedAt, processes };
    }

    if (process.platform !== 'win32' && !isWsl()) {
      return { status: 'ok', observedAt, processes: [] };
    }

    const out = await powershellAsync(
      'Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { [PSCustomObject]@{ Id = $_.Id; Name = $_.Name; Path = $_.Path; ' +
      'MainWindowTitle = $_.MainWindowTitle; StartTimeUtcFileTime = $_.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } } | ' +
      'ConvertTo-Json -Compress',
    );
    if (!out) return { status: 'ok', observedAt, processes: [] };
    const parsed = JSON.parse(out);
    return { status: 'ok', observedAt, processes: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (error) {
    return {
      status: 'error',
      observedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function currentBootId(): string {
  if (process.platform === 'linux') {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      // Fall through to a stable best-effort value.
    }
  }

  if (process.platform === 'win32' || isWsl()) {
    try {
      return powershell('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")');
    } catch {
      // Fall through to a stable best-effort value.
    }
  }

  if (process.platform === 'darwin') {
    try {
      return run('sysctl', ['-n', 'kern.boottime']);
    } catch {
      // Fall through to a stable best-effort value.
    }
  }

  return `${process.platform}:${os.hostname()}:unknown-boot`;
}

async function currentBootIdAsync(): Promise<string> {
  if (process.platform === 'linux') {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      // Fall through to a stable best-effort value.
    }
  }
  if (process.platform === 'win32' || isWsl()) {
    try {
      return await powershellAsync('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")');
    } catch {
      // Fall through to a stable best-effort value.
    }
  }
  if (process.platform === 'darwin') {
    try {
      return await runAsync('sysctl', ['-n', 'kern.boottime']);
    } catch {
      // Fall through to a stable best-effort value.
    }
  }
  return `${process.platform}:${os.hostname()}:unknown-boot`;
}

export function buildStudioLaunchArgs(options: StudioLaunchOptions): string[] {
  switch (options.source) {
    case 'baseplate':
      return ['--task', 'EditFile', '--localPlaceFile', options.localPlaceFile ?? createBaseplatePlaceFile()];
    case 'local_file':
      if (!options.localPlaceFile) throw new Error('local_place_file is required when source="local_file".');
      return ['--task', 'EditFile', '--localPlaceFile', options.localPlaceFile];
    case 'published_place':
      if (!options.placeId) throw new Error('place_id is required when source="published_place".');
      if (!options.universeId) throw new Error('Derived universe id is required when source="published_place".');
      return ['--task', 'EditPlace', '--placeId', String(options.placeId), '--universeId', String(options.universeId)];
    case 'place_revision':
      if (!options.placeId) throw new Error('place_id is required when source="place_revision".');
      if (!options.universeId) throw new Error('Derived universe id is required when source="place_revision".');
      if (!options.placeVersion) throw new Error('place_version is required when launching source="place_revision".');
      return [
        '--task', 'EditPlaceRevision',
        '--placeId', String(options.placeId),
        '--universeId', String(options.universeId),
        '--placeVersion', String(options.placeVersion),
      ];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basenameAny(filePath: string): string {
  return path.basename(filePath.replace(/\\/g, '/'));
}

export class StudioInstanceManager {
  private managedByInstanceId = new Map<string, ManagedStudioInstance>();
  private pending = new Set<ManagedStudioInstance>();
  private connectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly registry: ManagedInstanceRegistry;
  private readonly processAdapter: StudioProcessAdapter;
  private readonly confirmedExitMisses: number;
  private readonly confirmedExitGraceMs: number;
  private readonly snapshotCacheMs: number;
  private coordinatorTimer?: ReturnType<typeof setInterval>;
  private coordinatorRefresh?: Promise<void>;
  private cachedSnapshot?: StudioProcessSnapshot;
  private snapshotInFlight?: Promise<StudioProcessSnapshot>;
  private launchQueue: Promise<void> = Promise.resolve();

  constructor(options: StudioInstanceManagerOptions = {}) {
    this.registry = options.registry ?? new ManagedInstanceRegistry(options.registryDir);
    this.processAdapter = options.processAdapter ?? {};
    this.confirmedExitMisses = options.confirmedExitMisses ?? 2;
    this.confirmedExitGraceMs = options.confirmedExitGraceMs ?? 5000;
    this.snapshotCacheMs = options.snapshotCacheMs ?? 0;
  }

  async list(): Promise<ManagedStudioInstance[]> {
    const snapshot = await this.getProcessSnapshot();
    await this.sweepRegistry(snapshot);
    for (const record of [...this.managedByInstanceId.values(), ...this.pending]) {
      await this.refresh(record, snapshot);
    }
    const records = [...this.managedByInstanceId.values(), ...this.pending];
    for (const registryRecord of await this.registry.listOpenUnchecked()) {
      const record = this.fromRegistryRecord(registryRecord);
      if (records.some((existing) =>
        (record.recordId && existing.recordId === record.recordId) ||
        (record.instanceId && existing.instanceId === record.instanceId)
      )) {
        continue;
      }
      records.push(record);
    }
    return records
      .filter((record) => record.closedAt === undefined)
      .filter((instance, index, all) => all.indexOf(instance) === index);
  }

  async get(instanceId: string): Promise<ManagedStudioInstance | undefined> {
    const snapshot = await this.getProcessSnapshot();
    await this.sweepRegistry(snapshot);
    const memoryRecord = this.managedByInstanceId.get(instanceId);
    if (memoryRecord) return this.refresh(memoryRecord, snapshot);
    const registryRecord = await this.registry.findAnyByInstanceId(instanceId);
    return registryRecord ? this.refresh(this.fromRegistryRecord(registryRecord), snapshot) : undefined;
  }

  async getByLaunchId(launchId: string): Promise<ManagedStudioInstance | undefined> {
    const snapshot = await this.getProcessSnapshot();
    await this.sweepRegistry(snapshot);
    const memoryRecord = [...this.managedByInstanceId.values(), ...this.pending]
      .find((record) => record.recordId === launchId);
    if (memoryRecord) return this.refresh(memoryRecord, snapshot);
    const registryRecord = await this.registry.findAnyByRecordId(launchId);
    return registryRecord ? this.refresh(this.fromRegistryRecord(registryRecord), snapshot) : undefined;
  }

  async pendingLaunches(): Promise<ManagedStudioInstance[]> {
    const now = Date.now();
    const bootId = await this.getCurrentBootId();
    const records = [...this.pending];
    for (const registryRecord of await this.registry.listOpenUnchecked()) {
      if (registryRecord.bootId !== bootId) continue;
      if (records.some((record) => record.recordId === registryRecord.recordId)) continue;
      records.push(this.fromRegistryRecord(registryRecord));
    }
    return records
      .filter((record) => record.instanceId === undefined)
      .filter((record) => record.state === 'launching')
      .filter((record) => record.connectionDeadlineAt === undefined || record.connectionDeadlineAt > now);
  }

  async attachInstanceId(record: ManagedStudioInstance, instanceId: string): Promise<void> {
    const snapshot = await this.getProcessSnapshot(true);
    await this.reconcileFromPositiveEvidence(record, snapshot);
    if (record.closedAt !== undefined || record.state === 'failed' || record.state === 'exited') return;
    if (record.instanceId && record.instanceId !== instanceId) return;
    record.instanceId = instanceId;
    record.state = 'connected';
    record.connectedAt = record.connectedAt ?? Date.now();
    this.clearConnectionTimer(record);
    this.pending.delete(record);
    this.managedByInstanceId.set(instanceId, record);
    await this.persist(record);
  }

  async markFailed(record: ManagedStudioInstance, reason: string): Promise<ManagedStudioInstance> {
    if (record.closedAt !== undefined || record.state !== 'launching') return record;
    record.state = 'failed';
    record.failedAt = Date.now();
    record.failureReason = reason;
    this.clearConnectionTimer(record);
    await this.persist(record);
    return record;
  }

  async refresh(record: ManagedStudioInstance, providedSnapshot?: StudioProcessSnapshot): Promise<ManagedStudioInstance> {
    if (record.closedAt !== undefined) return record;
    const snapshot = providedSnapshot ?? await this.getProcessSnapshot();
    await this.applyProcessObservation(record, this.observeRecord(record, snapshot));
    if (record.closedAt !== undefined) return record;

    if (
      record.state === 'launching' &&
      record.connectionDeadlineAt !== undefined &&
      Date.now() >= record.connectionDeadlineAt
    ) {
      record.state = 'failed';
      record.failedAt = Date.now();
      record.failureReason = 'Studio launched, but the MCP plugin did not connect before timeout.';
      this.clearConnectionTimer(record);
      await this.persist(record);
    }
    return record;
  }

  async launch(options: StudioLaunchOptions): Promise<ManagedStudioInstance> {
    const previous = this.launchQueue;
    let release!: () => void;
    this.launchQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.launchSerialized(options);
    } finally {
      release();
    }
  }

  private async launchSerialized(options: StudioLaunchOptions): Promise<ManagedStudioInstance> {
    const initialSnapshot = await this.getProcessSnapshot(true);
    await this.sweepRegistry(initialSnapshot);
    const processEnvironment = parseStudioProcessEnvironmentPatch(options.processEnvironment);
    if (
      options.studioExecutable !== undefined &&
      (typeof options.studioExecutable !== 'string' ||
        options.studioExecutable.length === 0 ||
        options.studioExecutable.includes('\0'))
    ) {
      throw new Error('studio_executable must be a non-empty string without null characters.');
    }
    const preparedOptions = prepareStudioLaunchOptions(options);
    const bootId = await this.getCurrentBootId();
    const before = new Set(initialSnapshot.status === 'ok' ? initialSnapshot.processes.map((proc) => proc.Id) : []);
    const exe = preparedOptions.studioExecutable ??
      (this.processAdapter.resolveStudioExe ? await this.processAdapter.resolveStudioExe() : await resolveStudioExeAsync());
    const args = await Promise.all(buildStudioLaunchArgs(preparedOptions).map(toStudioLaunchArgAsync));
    const spawnOptions: Parameters<typeof spawn>[2] = {
      cwd: isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd(),
      detached: true,
      stdio: 'ignore',
      ...(processEnvironment ? { env: patchedProcessEnvironment(processEnvironment) } : {}),
    };
    let proc: StudioChildProcess;
    try {
      if (this.processAdapter.spawnStudio) {
        proc = await this.processAdapter.spawnStudio(exe, args, spawnOptions);
      } else if (isWsl()) {
        proc = await spawnWindowsStudioFromWsl(exe, args, processEnvironment);
      } else {
        const child = spawn(exe, args, spawnOptions);
        proc = {
          pid: child.pid,
          nativePid: child.pid,
          unref: () => child.unref(),
          onExit: (listener) => { child.once('exit', listener); },
          onError: (listener) => { child.once('error', listener); },
        };
      }
    } catch (error) {
      cleanupManagedBaseplateFiles({ source: preparedOptions.source, localPlaceFile: preparedOptions.localPlaceFile });
      throw error;
    }

    const launchedAt = Date.now();
    const record: ManagedStudioInstance = {
      recordId: randomUUID(),
      source: options.source,
      nativeProcessId: proc.nativePid,
      nativeProcessStartedAt: proc.nativeStartedAt,
      spawnPid: proc.pid,
      exe,
      args,
      placeId: preparedOptions.placeId,
      universeId: preparedOptions.universeId,
      placeVersion: preparedOptions.placeVersion,
      localPlaceFile: preparedOptions.localPlaceFile,
      launchedAt,
      connectionDeadlineAt: launchedAt + (options.connectionTimeoutMs ?? 120000),
      state: 'launching',
      ownerPid: process.pid,
      bootId,
      deleteLocalPlaceFileOnClose: options.source === 'baseplate',
      processObservationStatus: 'running',
      lastProcessObservationAt: launchedAt,
      lastSuccessfulProcessObservationAt: launchedAt,
      consecutiveConfirmedMisses: 0,
    };
    this.pending.add(record);
    try {
      // Persist before returning control to the child-process lifecycle. Once
      // Studio exists, callers must always have a durable launch_id with which
      // to inspect or close it.
      await this.persist(record);
    } catch (error) {
      this.pending.delete(record);
      const processId = record.nativeProcessId ?? record.spawnPid;
      let stopError: unknown;
      if (processId) {
        try {
          await this.closeProcess(processId);
        } catch (caught) {
          stopError = caught;
        }
      }
      cleanupManagedBaseplateFiles(record);
      const detail = error instanceof Error ? error.message : String(error);
      const cleanupDetail = stopError
        ? ` The newly launched process could not be stopped: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        : '';
      throw new Error(`Studio launched, but its managed-instance record could not be persisted: ${detail}.${cleanupDetail}`);
    }
    proc.unref();

    proc.onExit?.((code, signal) => {
      this.runInBackground('persisting a Studio process exit', this.markProcessExited(
        record,
        code ?? undefined,
        signal
          ? `Studio process exited from signal ${signal}.`
          : record.instanceId
            ? 'Studio process exited.'
            : 'Studio process exited before the MCP plugin connected.',
      ));
    });
    proc.onError?.((error) => {
      this.runInBackground(
        'persisting a Studio process launch failure',
        this.markFailed(record, `Studio process failed to start: ${error.message}`),
      );
    });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && record.nativeProcessId === undefined) {
      const snapshot = await this.getProcessSnapshot(true);
      const created = snapshot.status === 'ok'
        ? snapshot.processes.find((candidate) => !before.has(candidate.Id))
        : undefined;
      if (created) {
        record.nativeProcessId = created.Id;
        record.nativeProcessStartedAt = created.StartTimeUtcFileTime;
        await this.persist(record);
        break;
      }
      await delay(250);
    }

    if (record.nativeProcessId === undefined && process.platform !== 'win32' && !isWsl()) {
      record.nativeProcessId = proc.pid;
      await this.persist(record);
    }

    if (record.nativeProcessId !== undefined && record.nativeProcessStartedAt === undefined) {
      const snapshot = await this.getProcessSnapshot(true);
      const nativeProcess = snapshot.status === 'ok'
        ? snapshot.processes.find((candidate) => candidate.Id === record.nativeProcessId)
        : undefined;
      if (nativeProcess?.StartTimeUtcFileTime !== undefined) {
        record.nativeProcessStartedAt = nativeProcess.StartTimeUtcFileTime;
        await this.persist(record);
      }
    }

    this.startCoordinator(record);

    return record;
  }

  async closeByLaunchId(launchId: string): Promise<ManagedStudioCloseResult> {
    const record = await this.getByLaunchId(launchId);
    if (!record) return { status: 'not_found', launchId };
    if (record.closedAt !== undefined) {
      return { status: 'already_closed', launchId, instanceId: record.instanceId };
    }
    return this.close(record);
  }

  async closeByInstanceId(instanceId: string): Promise<ManagedStudioCloseResult> {
    const snapshot = await this.getProcessSnapshot(true);
    await this.sweepRegistry(snapshot);
    const memoryRecord = this.managedByInstanceId.get(instanceId);
    if (memoryRecord) return this.close(memoryRecord);

    const registryRecord = await this.registry.findAnyByInstanceId(instanceId);
    if (!registryRecord) {
      return { status: 'not_found', instanceId };
    }

    if (registryRecord.closedAt !== undefined) {
      this.cleanupManagedRecord(registryRecord);
      await this.registry.logEvent({
        event: 'registry_close_already_stopped',
        recordId: registryRecord.recordId,
        instanceId: registryRecord.instanceId,
        source: registryRecord.source,
        reason: 'closed_at_present',
        action: 'retained_terminal_record_and_cleaned_baseplate',
      });
      return { status: 'already_closed', launchId: registryRecord.recordId, instanceId };
    }

    return this.close(this.fromRegistryRecord(registryRecord));
  }

  async close(record: ManagedStudioInstance): Promise<ManagedStudioCloseResult> {
    if (record.closedAt !== undefined) {
      return { status: 'already_closed', launchId: record.recordId, instanceId: record.instanceId };
    }
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) {
      throw new Error(`Cannot close ${record.instanceId ?? 'Studio launch'} because its process id was not detected.`);
    }

    const snapshot = await this.getProcessSnapshot(true);
    const observation = this.observeRecord(record, snapshot);
    if (observation.status === 'unknown') {
      await this.applyProcessObservation(record, observation);
      throw new Error(`Cannot verify the managed Studio process because process observation failed: ${observation.error}`);
    }
    if (observation.status === 'not_running') {
      this.cleanupManagedRecord(record);
      await this.markProcessExited(
        record,
        undefined,
        observation.reason === 'identity_mismatch'
          ? 'Studio process identity changed; the retained PID was not reused.'
          : record.failureReason,
      );
      await this.registry.logEvent({
        event: 'registry_close_already_stopped',
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: observation.reason === 'identity_mismatch' ? 'identity_mismatch' : 'pid_not_running',
        action: 'marked_closed_and_cleaned_baseplate',
      });
      return { status: 'already_closed', launchId: record.recordId, instanceId: record.instanceId };
    }

    try {
      await this.closeProcess(processId);
    } catch (error) {
      const retry = await this.getProcessSnapshot(true);
      const retryObservation = this.observeRecord(record, retry);
      if (retryObservation.status === 'running' || retryObservation.status === 'unknown') throw error;
      await this.registry.logEvent({
        event: 'registry_close_already_stopped',
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: 'stop_raced_with_exit',
        action: 'marked_closed_and_cleaned_baseplate',
      });
      this.cleanupManagedRecord(record);
      await this.markProcessExited(record, undefined, record.failureReason);
      return { status: 'already_closed', launchId: record.recordId, instanceId: record.instanceId };
    }

    const closedAt = Date.now();
    record.closedAt = closedAt;
    record.exitedAt = record.exitedAt ?? closedAt;
    if (record.state !== 'failed') record.state = 'exited';
    record.processObservationStatus = 'not_running';
    record.lastProcessObservationAt = closedAt;
    record.lastSuccessfulProcessObservationAt = closedAt;
    record.lastProcessObservationError = undefined;
    this.cleanupManagedRecord(record);
    this.markClosedInMemory(record);
    await this.persist(record);
    return { status: 'closed', launchId: record.recordId, instanceId: record.instanceId };
  }

  async closeConnectedInstance(instance: ConnectedStudioInstance): Promise<void> {
    const snapshot = await this.getProcessSnapshot(true);
    if (snapshot.status === 'error') {
      throw new Error(`Could not enumerate Studio processes: ${snapshot.error}`);
    }
    const process = this.findProcessForConnectedInstance(instance, snapshot.processes);
    if (!process) {
      throw new Error(`Could not find a Studio process for connected instance "${instance.instanceId}".`);
    }
    await this.closeProcess(process.Id);
  }

  private async closeProcess(processId: number): Promise<void> {
    if (this.processAdapter.stopProcess) {
      await this.processAdapter.stopProcess(processId);
      return;
    }

    if (process.platform === 'win32' || isWsl()) {
      await powershellAsync(`Stop-Process -Id ${Math.trunc(processId)} -Force -ErrorAction Stop`);
    } else {
      try {
        process.kill(processId, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }

  private findProcessForConnectedInstance(
    instance: ConnectedStudioInstance,
    processes: StudioProcessInfo[],
  ): StudioProcessInfo | undefined {
    if (processes.length === 0) return undefined;
    if (processes.length === 1) return processes[0];

    const names = [instance.dataModelName, instance.placeName]
      .map((name) => name.trim())
      .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);

    const candidates = processes.filter((proc) => {
      const title = (proc.MainWindowTitle ?? '').trim();
      if (!title) return false;
      return names.some((name) =>
        title === `${name} - Roblox Studio` ||
        title.startsWith(`${name} - `) ||
        title.startsWith(`${name} (`),
      );
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error(`Multiple Studio processes matched connected instance "${instance.instanceId}".`);
    }
    return undefined;
  }

  private async getProcessSnapshot(force = false): Promise<StudioProcessSnapshot> {
    const now = Date.now();
    if (!force && this.snapshotCacheMs > 0 && this.cachedSnapshot && now - this.cachedSnapshot.observedAt <= this.snapshotCacheMs) {
      return this.cachedSnapshot;
    }
    if (this.snapshotInFlight) return this.snapshotInFlight;
    this.snapshotInFlight = (async () => {
      try {
        let snapshot: StudioProcessSnapshot;
        if (this.processAdapter.observeStudioProcesses) {
          snapshot = await this.processAdapter.observeStudioProcesses();
        } else if (this.processAdapter.listStudioProcesses) {
          const observedAt = Date.now();
          const processes = await this.processAdapter.listStudioProcesses();
          snapshot = { status: 'ok', observedAt, processes };
        } else {
          snapshot = await observeStudioProcesses();
        }
        this.cachedSnapshot = snapshot;
        return snapshot;
      } catch (error) {
        const snapshot: StudioProcessSnapshot = {
          status: 'error',
          observedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
        this.cachedSnapshot = snapshot;
        return snapshot;
      } finally {
        this.snapshotInFlight = undefined;
      }
    })();
    return this.snapshotInFlight;
  }

  private async getCurrentBootId(): Promise<string> {
    return this.processAdapter.currentBootId
      ? await this.processAdapter.currentBootId()
      : currentBootIdAsync();
  }

  private async registrySweepOptions(snapshot: StudioProcessSnapshot): Promise<RegistrySweepOptions> {
    return {
      currentBootId: await this.getCurrentBootId(),
      observeProcess: (record) => this.observeRecord(this.fromRegistryRecord(record), snapshot),
      cleanupRecord: (record) => this.cleanupManagedRecord(record),
      confirmedExitMisses: this.confirmedExitMisses,
      confirmedExitGraceMs: this.confirmedExitGraceMs,
    };
  }

  private async sweepRegistry(snapshot: StudioProcessSnapshot): Promise<void> {
    await this.registry.sweep(await this.registrySweepOptions(snapshot));
  }

  private observeRecord(record: ManagedStudioInstance, snapshot: StudioProcessSnapshot): ManagedProcessObservation {
    if (snapshot.status === 'error') {
      return { status: 'unknown', observedAt: snapshot.observedAt, error: snapshot.error };
    }
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) return { status: 'running', observedAt: snapshot.observedAt };
    const studioProcess = snapshot.processes.find((candidate) => candidate.Id === processId);
    if (!studioProcess) return { status: 'not_running', observedAt: snapshot.observedAt, reason: 'missing' };
    return this.verifyProcessForRecord(record, studioProcess)
      ? { status: 'running', observedAt: snapshot.observedAt }
      : { status: 'not_running', observedAt: snapshot.observedAt, reason: 'identity_mismatch' };
  }

  private verifyProcessForRecord(record: ManagedStudioInstance, studioProcess: StudioProcessInfo): boolean {
    const processName = `${studioProcess.Name ?? ''} ${studioProcess.Path ?? ''}`.toLowerCase();
    if (!processName.includes('robloxstudio')) return false;

    if (
      record.nativeProcessStartedAt !== undefined &&
      studioProcess.StartTimeUtcFileTime !== record.nativeProcessStartedAt
    ) {
      return false;
    }

    const processId = record.nativeProcessId ?? record.spawnPid;
    if (record.spawnPid && record.spawnPid === processId && studioProcess.Id === processId) return true;

    const processPath = studioProcess.Path ? path.normalize(studioProcess.Path).toLowerCase() : '';
    const exePath = record.exe ? path.normalize(record.exe).toLowerCase() : '';
    if (processPath && exePath && (processPath === exePath || basenameAny(processPath) === basenameAny(exePath))) {
      return true;
    }

    const commandLine = studioProcess.CommandLine ?? '';
    if (record.localPlaceFile && commandLine.includes(path.basename(record.localPlaceFile))) return true;
    if (record.placeId !== undefined && commandLine.includes(String(record.placeId))) return true;

    return false;
  }

  private cleanupManagedRecord(record: { source: string; localPlaceFile?: string }) {
    if (record.source !== 'baseplate') return;
    cleanupManagedBaseplateFiles({ source: 'baseplate', localPlaceFile: record.localPlaceFile });
  }

  private markClosedInMemory(record: ManagedStudioInstance) {
    record.closedAt = record.closedAt ?? Date.now();
    if (record.instanceId) this.managedByInstanceId.delete(record.instanceId);
    this.pending.delete(record);
    this.clearConnectionTimer(record);
  }

  private async markProcessExited(
    record: ManagedStudioInstance,
    exitCode?: number,
    reason?: string,
  ): Promise<ManagedStudioInstance> {
    if (record.closedAt !== undefined) return record;
    const exitedAt = Date.now();
    record.exitedAt = exitedAt;
    record.closedAt = exitedAt;
    if (record.state !== 'failed') record.state = 'exited';
    record.processObservationStatus = 'not_running';
    record.lastProcessObservationAt = exitedAt;
    record.lastSuccessfulProcessObservationAt = exitedAt;
    record.lastProcessObservationError = undefined;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (reason) record.failureReason = reason;
    this.cleanupManagedRecord(record);
    this.markClosedInMemory(record);
    await this.persist(record);
    return record;
  }

  private startCoordinator(record: ManagedStudioInstance) {
    if (!record.recordId || record.closedAt !== undefined) return;
    if (record.state === 'launching' && record.connectionDeadlineAt !== undefined) {
      const timeout = setTimeout(() => {
        this.runInBackground(
          'persisting a Studio plugin connection timeout',
          this.markFailed(record, 'Studio launched, but the MCP plugin did not connect before timeout.'),
        );
      }, Math.max(0, record.connectionDeadlineAt - Date.now()));
      if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
      this.connectionTimers.set(record.recordId, timeout);
    }
    if (this.coordinatorTimer) return;
    this.coordinatorTimer = setInterval(() => {
      if (this.coordinatorRefresh) return;
      this.coordinatorRefresh = this.refreshOwnedRecords()
        .catch((error) => {
          this.reportBackgroundFailure('refreshing managed Studio records', error);
        })
        .finally(() => {
          this.coordinatorRefresh = undefined;
        });
    }, 5000);
    if (typeof this.coordinatorTimer === 'object' && 'unref' in this.coordinatorTimer) {
      this.coordinatorTimer.unref();
    }
  }

  private clearConnectionTimer(record: ManagedStudioInstance) {
    if (!record.recordId) return;
    const timer = this.connectionTimers.get(record.recordId);
    if (timer) clearTimeout(timer);
    this.connectionTimers.delete(record.recordId);
  }

  private async refreshOwnedRecords(): Promise<void> {
    const snapshot = await this.getProcessSnapshot(true);
    await this.sweepRegistry(snapshot);
    for (const record of [...this.managedByInstanceId.values(), ...this.pending]) {
      await this.refresh(record, snapshot);
    }
  }

  private runInBackground(context: string, operation: Promise<unknown>): void {
    void operation.catch((error) => this.reportBackgroundFailure(context, error));
  }

  private reportBackgroundFailure(context: string, error: unknown): void {
    console.warn(
      `[robloxstudio-mcp] failed while ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private async applyProcessObservation(
    record: ManagedStudioInstance,
    observation: ManagedProcessObservation,
  ): Promise<void> {
    if (record.closedAt !== undefined) return;
    const previousObservationAt = record.lastProcessObservationAt;
    record.lastProcessObservationAt = observation.observedAt;

    if (observation.status === 'unknown') {
      record.processObservationStatus = 'unknown';
      record.lastProcessObservationError = observation.error;
      record.consecutiveConfirmedMisses = 0;
      record.firstConfirmedMissAt = undefined;
      await this.persist(record);
      return;
    }

    record.lastSuccessfulProcessObservationAt = observation.observedAt;
    record.lastProcessObservationError = undefined;
    if (observation.status === 'running') {
      record.processObservationStatus = 'running';
      record.consecutiveConfirmedMisses = 0;
      record.firstConfirmedMissAt = undefined;
      await this.persist(record);
      return;
    }

    record.processObservationStatus = 'not_running';
    if (previousObservationAt !== observation.observedAt) {
      record.consecutiveConfirmedMisses = (record.consecutiveConfirmedMisses ?? 0) + 1;
      record.firstConfirmedMissAt ??= observation.observedAt;
    }
    const confirmedAbsent = observation.reason === 'identity_mismatch' || (
      (record.consecutiveConfirmedMisses ?? 0) >= this.confirmedExitMisses &&
      observation.observedAt - (record.firstConfirmedMissAt ?? observation.observedAt) >= this.confirmedExitGraceMs
    );
    if (!confirmedAbsent) {
      await this.persist(record);
      return;
    }
    await this.markProcessExited(
      record,
      undefined,
      observation.reason === 'identity_mismatch'
        ? 'Studio process identity changed; the retained PID was not reused.'
        : record.instanceId
          ? 'Studio process exited.'
          : 'Studio process exited before the MCP plugin connected.',
    );
  }

  private async reconcileFromPositiveEvidence(
    record: ManagedStudioInstance,
    snapshot: StudioProcessSnapshot,
  ): Promise<void> {
    if (record.closedAt === undefined) return;
    if (
      record.failureReason !== 'Studio process exited.' &&
      record.failureReason !== 'Studio process exited before the MCP plugin connected.'
    ) return;
    if (snapshot.status !== 'ok') return;
    const processId = record.nativeProcessId ?? record.spawnPid;
    const studioProcess = processId
      ? snapshot.processes.find((candidate) => candidate.Id === processId)
      : undefined;
    if (!studioProcess || !this.verifyProcessForRecord(record, studioProcess)) return;
    if (record.exitCode !== undefined) return;
    record.closedAt = undefined;
    record.exitedAt = undefined;
    record.failureReason = undefined;
    record.state = record.instanceId ? 'connected' : 'launching';
    record.processObservationStatus = 'running';
    record.lastProcessObservationAt = snapshot.observedAt;
    record.lastSuccessfulProcessObservationAt = snapshot.observedAt;
    record.lastProcessObservationError = undefined;
    record.consecutiveConfirmedMisses = 0;
    record.firstConfirmedMissAt = undefined;
    await this.persist(record);
  }

  private async persist(record: ManagedStudioInstance): Promise<void> {
    await this.registry.upsert(this.toRegistryRecord(record));
  }

  private toRegistryRecord(record: ManagedStudioInstance): ManagedInstanceRegistryRecord {
    if (!record.recordId) throw new Error('Managed Studio record is missing recordId.');
    if (!record.bootId) throw new Error('Managed Studio record is missing bootId.');
    return {
      version: 1,
      recordId: record.recordId,
      instanceId: record.instanceId,
      source: record.source,
      nativeProcessId: record.nativeProcessId,
      nativeProcessStartedAt: record.nativeProcessStartedAt,
      spawnPid: record.spawnPid,
      exe: record.exe,
      args: record.args,
      placeId: record.placeId,
      universeId: record.universeId,
      placeVersion: record.placeVersion,
      localPlaceFile: record.localPlaceFile,
      deleteLocalPlaceFileOnClose: record.deleteLocalPlaceFileOnClose,
      launchedAt: record.launchedAt,
      attachedAt: record.connectedAt,
      connectionDeadlineAt: record.connectionDeadlineAt,
      state: record.state,
      failedAt: record.failedAt,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      failureReason: record.failureReason,
      closedAt: record.closedAt,
      ownerPid: record.ownerPid,
      bootId: record.bootId,
      processObservationStatus: record.processObservationStatus,
      lastProcessObservationAt: record.lastProcessObservationAt,
      lastSuccessfulProcessObservationAt: record.lastSuccessfulProcessObservationAt,
      lastProcessObservationError: record.lastProcessObservationError,
      consecutiveConfirmedMisses: record.consecutiveConfirmedMisses,
      firstConfirmedMissAt: record.firstConfirmedMissAt,
    };
  }

  private fromRegistryRecord(record: ManagedInstanceRegistryRecord): ManagedStudioInstance {
    const state = record.state ?? (record.closedAt !== undefined ? 'exited' : record.instanceId ? 'connected' : 'launching');
    return {
      recordId: record.recordId,
      source: record.source as StudioLaunchSource,
      instanceId: record.instanceId,
      nativeProcessId: record.nativeProcessId,
      nativeProcessStartedAt: record.nativeProcessStartedAt,
      spawnPid: record.spawnPid,
      exe: record.exe,
      args: record.args,
      placeId: record.placeId,
      universeId: record.universeId,
      placeVersion: record.placeVersion,
      localPlaceFile: record.localPlaceFile,
      launchedAt: record.launchedAt,
      connectionDeadlineAt: record.connectionDeadlineAt ?? (state === 'launching' ? record.launchedAt + 120000 : undefined),
      state,
      connectedAt: record.attachedAt,
      failedAt: record.failedAt,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      failureReason: record.failureReason,
      closedAt: record.closedAt,
      ownerPid: record.ownerPid,
      bootId: record.bootId,
      deleteLocalPlaceFileOnClose: record.deleteLocalPlaceFileOnClose,
      processObservationStatus: record.processObservationStatus,
      lastProcessObservationAt: record.lastProcessObservationAt,
      lastSuccessfulProcessObservationAt: record.lastSuccessfulProcessObservationAt,
      lastProcessObservationError: record.lastProcessObservationError,
      consecutiveConfirmedMisses: record.consecutiveConfirmedMisses,
      firstConfirmedMissAt: record.firstConfirmedMissAt,
    };
  }
}

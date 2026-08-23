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
import {
  getStudioPlatformCapabilities,
  type StudioHostPlatform,
  type StudioPlatformCapabilities,
  type StudioProcessIdentityLauncher,
} from './studio-platform.js';

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
  studioWorkingDirectory?: string;
  requireProcessIdentity?: boolean;
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
  studioWorkingDirectory?: string;
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
  processAuthorizationState?: "pending" | "authorized" | "released";
  processObservationStatus?: "running" | "not_running" | "unknown";
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
  authorize?: () => unknown | Promise<unknown>;
  release?: () => unknown | Promise<unknown>;
  abort?: () => unknown | Promise<unknown>;
  onExit?: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  onError?: (listener: (error: Error) => void) => void;
};

type StudioLaunchControl = {
  authorize: () => unknown | Promise<unknown>;
  release: () => unknown | Promise<unknown>;
  abort: () => unknown | Promise<unknown>;
};

const retainedLaunchControls = new Map<string, StudioLaunchControl>();

export interface StudioProcessAdapter {
  observeStudioProcesses?: () => StudioProcessSnapshot | Promise<StudioProcessSnapshot>;
  listStudioProcesses?: () => StudioProcessInfo[] | Promise<StudioProcessInfo[]>;
  stopProcess?: (processId: number, startedAt?: string) => unknown | Promise<unknown>;
  resolveStudioExe?: () => string | Promise<string>;
  spawnStudio?: (exe: string, args: string[], options: Parameters<typeof spawn>[2]) => StudioChildProcess | Promise<StudioChildProcess>;
  currentBootId?: () => string | Promise<string>;
}

export interface StudioInstanceManagerOptions {
  registryDir?: string;
  registry?: ManagedInstanceRegistry;
  processAdapter?: StudioProcessAdapter;
  platformCapabilities?: StudioPlatformCapabilities;
  windowsStudioLauncher?: (
    exe: string,
    args: string[],
    processEnvironment?: StudioProcessEnvironmentPatch,
    studioWorkingDirectory?: string,
  ) => StudioChildProcess | Promise<StudioChildProcess>;
  confirmedExitMisses?: number;
  confirmedExitGraceMs?: number;
  snapshotCacheMs?: number;
  launchCompletionTimeoutMs?: number;
}

export type StudioLifecycleLauncher =
  | StudioProcessIdentityLauncher
  | 'custom-adapter';

export interface StudioLifecycleCapabilities {
  hostPlatform: StudioHostPlatform;
  windowsInteropAvailable: boolean;
  processIdentity: {
    supported: boolean;
    launcher: StudioLifecycleLauncher;
    reason?: string;
  };
}

export interface StudioLaunchPreDispatchErrorBody {
  error: 'process_identity_unavailable';
  message: string;
  launch_stage: 'pre_spawn';
  process_created: false;
  safe_to_fallback: true;
  launcher: StudioLifecycleLauncher;
  remediation: string;
}

export class StudioLaunchPreDispatchError extends Error {
  readonly code = 'process_identity_unavailable';
  readonly statusCode = 409;
  readonly launchStage = 'pre_spawn';
  readonly processCreated = false;
  readonly safeToFallback = true;

  constructor(readonly capabilities: StudioLifecycleCapabilities) {
    super(
      'require_process_identity is supported only by the identity-retaining Windows launcher or a custom process adapter.',
    );
    this.name = 'StudioLaunchPreDispatchError';
  }

  toResponseBody(): StudioLaunchPreDispatchErrorBody {
    return {
      error: this.code,
      message: this.message,
      launch_stage: this.launchStage,
      process_created: this.processCreated,
      safe_to_fallback: this.safeToFallback,
      launcher: this.capabilities.processIdentity.launcher,
      remediation:
        this.capabilities.processIdentity.reason ??
        'Start the broker through the supported Codex wrapper on Windows or WSL, or configure a custom process adapter.',
    };
  }
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
  return getStudioPlatformCapabilities().isWsl;
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

export function parseStudioWorkingDirectory(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new Error('studio_working_directory must be a non-empty string without null characters.');
  }
  return value;
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
  studioWorkingDirectory?: string,
): string {
  const workingDirectory = parseStudioWorkingDirectory(studioWorkingDirectory);
  return buildWindowsStudioStartScriptFromConvertedExe(
    toStudioLaunchArg(exe),
    args,
    processEnvironment,
    workingDirectory ? toStudioLaunchArg(workingDirectory) : undefined,
  );
}

function buildWindowsStudioStartScriptFromConvertedExe(
  windowsExe: string,
  args: string[],
  processEnvironment?: StudioProcessEnvironmentPatch,
  windowsWorkingDirectory?: string,
): string {
  const environmentPatch = parseStudioProcessEnvironmentPatch(processEnvironment);
  const commandLine = [windowsExe, ...args].map(quoteWindowsCommandLineArg).join(' ');
  return [
    ...(environmentPatch ? powershellEnvironmentPatchStatements(environmentPatch) : []),
    `Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class McpSuspendedStudio : IDisposable
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const uint RESUME_FAILED = 0xFFFFFFFF;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint WAIT_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FileTime creation,
        out FileTime exit,
        out FileTime kernel,
        out FileTime user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr process;
    private IntPtr thread;

    private IntPtr job;
    public uint ProcessId { get; private set; }
    public ulong StartedAtFileTime { get; private set; }

    private McpSuspendedStudio(ProcessInformation processInformation, IntPtr jobHandle)
    {
        process = processInformation.hProcess;
        thread = processInformation.hThread;
        job = jobHandle;
        ProcessId = processInformation.dwProcessId;
        FileTime creation;
        FileTime exit;
        FileTime kernel;
        FileTime user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetProcessTimes failed");
        StartedAtFileTime = ((ulong)creation.High << 32) | creation.Low;
    }

    private static void ConfigureKillOnClose(IntPtr jobHandle, bool enabled)
    {
        var information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = enabled ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0;
        int length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(jobHandle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, buffer, (uint)length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void TerminateAndWait(IntPtr processHandle)
    {
        if (!TerminateProcess(processHandle, 1))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 5)
                throw new Win32Exception(error, "TerminateProcess failed");
        }
        uint wait = WaitForSingleObject(processHandle, 15000);
        if (wait == WAIT_TIMEOUT)
            throw new TimeoutException("Timed out waiting for the terminated Studio process");
        if (wait == WAIT_FAILED)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
        if (wait != WAIT_OBJECT_0)
            throw new InvalidOperationException("Unexpected Studio process wait result: " + wait);
    }

    public static McpSuspendedStudio Start(string application, string commandLine, string currentDirectory)
    {
        IntPtr jobHandle = CreateJobObjectW(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
        try
        {
            ConfigureKillOnClose(jobHandle, true);
            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(startup);
            ProcessInformation created;
            uint flags = CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB;
            bool started = CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, currentDirectory, ref startup, out created);
            if (!started && Marshal.GetLastWin32Error() == 5)
                started = CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED, IntPtr.Zero, currentDirectory, ref startup, out created);
            if (!started)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
            try
            {
                if (!AssignProcessToJobObject(jobHandle, created.hProcess))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
                return new McpSuspendedStudio(created, jobHandle);
            }
            catch
            {
                try
                {
                    TerminateAndWait(created.hProcess);
                }
                finally
                {
                    CloseHandle(created.hThread);
                    CloseHandle(created.hProcess);
                }
                throw;
            }
        }
        catch
        {
            CloseHandle(jobHandle);
            throw;
        }
    }

    public void Resume()
    {
        if (thread == IntPtr.Zero)
            throw new InvalidOperationException("Studio launch was already resumed or disposed");
        if (ResumeThread(thread) == RESUME_FAILED)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
        CloseHandle(thread);
        thread = IntPtr.Zero;
    }

    public void Release()
    {
        if (thread != IntPtr.Zero)
            throw new InvalidOperationException("Studio launch cannot be released before it is resumed");
        if (job == IntPtr.Zero)
            throw new InvalidOperationException("Studio launch was already released or disposed");
        ConfigureKillOnClose(job, false);
        CloseHandle(job);
        job = IntPtr.Zero;
    }

    public void Abort()
    {
        if (process != IntPtr.Zero)
            TerminateAndWait(process);
    }

    public void Dispose()
    {
        if (thread != IntPtr.Zero)
        {
            CloseHandle(thread);
            thread = IntPtr.Zero;
        }
        if (job != IntPtr.Zero)
        {
            CloseHandle(job);
            job = IntPtr.Zero;
        }
        if (process != IntPtr.Zero)
        {
            CloseHandle(process);
            process = IntPtr.Zero;
        }
    }
}
'@`,
    `$launch = [McpSuspendedStudio]::Start(${powershellStringLiteral(windowsExe)}, ${powershellStringLiteral(commandLine)}, ${windowsWorkingDirectory === undefined ? '$null' : powershellStringLiteral(windowsWorkingDirectory)})`,
    'try {',
    '[Console]::Out.WriteLine((ConvertTo-Json @{ pid = $launch.ProcessId; started = [string]$launch.StartedAtFileTime } -Compress)); [Console]::Out.Flush()',
    '$accepted = $false',
    '$command = [Console]::In.ReadLine()',
    'if ($command -eq "MCP_STUDIO_LAUNCH_ACCEPT") {',
    '$launch.Resume()',
    '[Console]::Out.WriteLine("MCP_STUDIO_LAUNCH_RESUMED"); [Console]::Out.Flush()',
    '$command = [Console]::In.ReadLine()',
    'if ($command -eq "MCP_STUDIO_LAUNCH_COMPLETE") { $launch.Release(); $accepted = $true }',
    'elseif ($command -eq "MCP_STUDIO_LAUNCH_ABORT") { $launch.Abort(); $accepted = $true }',
    'else { throw "Resumed Studio launch was not completed or aborted." }',
    '} elseif ($command -eq "MCP_STUDIO_LAUNCH_ABORT") { $launch.Abort(); $accepted = $true }',
    'else { throw "Studio launch identity was not accepted." }',
    '} finally {',
    'try { if (-not $accepted) { $launch.Abort() } } finally { $launch.Dispose() }',
    '}',
  ].join('\n');
}

export function buildWindowsStudioStopScript(processId: number, startedAt: string): string {
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error('processId must be a positive integer.');
  if (!/^[1-9]\d*$/u.test(startedAt)) throw new Error('startedAt must be a positive FILETIME string.');
  return [
    `$processId = [int]${processId}`,
    `$expectedStartedAt = [long]${startedAt}`,
    '$studio = $null',
    'try { $studio = [System.Diagnostics.Process]::GetProcessById($processId) } catch [System.ArgumentException] { return }',
    'try {',
    '$actualStartedAt = $studio.StartTime.ToUniversalTime().ToFileTimeUtc()',
    'if ($actualStartedAt -ne $expectedStartedAt) { return }',
    'if (-not $studio.HasExited) {',
    'try { $studio.Kill() } catch { if (-not $studio.HasExited) { throw } }',
    '$studio.WaitForExit()',
    '}',
    '} finally { if ($null -ne $studio) { $studio.Dispose() } }',
  ].join('; ');
}

async function stopWindowsStudio(processId: number, startedAt: string): Promise<void> {
  await powershellAsync(buildWindowsStudioStopScript(processId, startedAt));
}

async function spawnWindowsStudio(
  exe: string,
  args: string[],
  processEnvironment?: StudioProcessEnvironmentPatch,
  studioWorkingDirectory?: string,
): Promise<StudioChildProcess> {
  const windowsExe = await toStudioLaunchArgAsync(exe);
  const windowsWorkingDirectory = studioWorkingDirectory
    ? await toStudioLaunchArgAsync(studioWorkingDirectory)
    : undefined;
  const script = buildWindowsStudioStartScriptFromConvertedExe(
    windowsExe,
    args,
    processEnvironment,
    windowsWorkingDirectory,
  );
  const launcher = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
    cwd:
      isWsl() && existsSync("/mnt/c/Windows")
        ? "/mnt/c/Windows"
        : process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new Promise<StudioChildProcess>((resolve, reject) => {
    let stdout = "";
    let controlOutput = "";
    let stderr = "";
    let identity: { pid: number; startedAt: string } | undefined;
    let initialFailure: Error | undefined;
    let identitySettled = false;
    let controlState:
      | "pending"
      | "accepting"
      | "resumed"
      | "releasing"
      | "released"
      | "aborting" = "pending";
    let resumeSettled = false;
    let completeResume!: (error?: Error) => void;
    const resumeAcknowledgment = new Promise<Error | undefined>((complete) => {
      completeResume = complete;
    });
    const signalResume = (error?: Error): void => {
      if (resumeSettled) return;
      resumeSettled = true;
      completeResume(error);
    };
    let completeLauncher!: (error?: Error) => void;
    const launcherCompletion = new Promise<Error | undefined>((complete) => {
      completeLauncher = complete;
    });
    const waitForLauncherCompletion = (
      timeoutMessage: string,
    ): Promise<Error | undefined> =>
      new Promise<Error | undefined>((complete) => {
        let settled = false;
        const forceTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          const error = new Error(timeoutMessage);
          launcher.kill("SIGKILL");
          signalResume(error);
          completeLauncher(error);
          complete(error);
        }, 10000);
        void launcherCompletion.then((error: Error | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimeout);
          complete(error);
        });
      });
    const waitForResumeAcknowledgment = (): Promise<Error | undefined> =>
      new Promise<Error | undefined>((complete) => {
        const forceTimeout = setTimeout(() => {
          const error = new Error(
            "Timed out resuming the suspended Studio process.",
          );
          launcher.kill("SIGKILL");
          signalResume(error);
          completeLauncher(error);
        }, 10000);
        void resumeAcknowledgment.then((error) => {
          clearTimeout(forceTimeout);
          complete(error);
        });
      });
    const throwWithExactCleanup = async (error: Error): Promise<never> => {
      if (!identity) throw error;
      try {
        await stopWindowsStudio(identity.pid, identity.startedAt);
      } catch (cleanupError) {
        throw new Error(
          `${error.message} Exact Studio cleanup also failed: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
      throw error;
    };
    const authorize = async (): Promise<void> => {
      if (controlState === "resumed") return;
      if (controlState !== "pending")
        throw new Error(
          `Studio launch cannot be authorized from ${controlState}.`,
        );
      controlState = "accepting";
      launcher.stdin.write("MCP_STUDIO_LAUNCH_ACCEPT\n");
      const error = await waitForResumeAcknowledgment();
      if (error) await throwWithExactCleanup(error);
      controlState = "resumed";
    };
    const release = async (): Promise<void> => {
      if (controlState === "released") return;
      if (controlState !== "resumed")
        throw new Error(
          `Studio launch cannot be released from ${controlState}.`,
        );
      controlState = "releasing";
      launcher.stdin.end("MCP_STUDIO_LAUNCH_COMPLETE\n");
      const error = await waitForLauncherCompletion(
        "Timed out releasing the authorized Studio process.",
      );
      if (error) await throwWithExactCleanup(error);
      controlState = "released";
    };
    const abort = async (): Promise<void> => {
      if (controlState === "released") return;
      if (controlState !== "aborting") {
        controlState = "aborting";
        launcher.stdin.end("MCP_STUDIO_LAUNCH_ABORT\n");
      }
      const error = await waitForLauncherCompletion(
        "Timed out aborting the owned Studio process.",
      );
      if (error && identity) {
        await stopWindowsStudio(identity.pid, identity.startedAt);
      } else if (error) {
        throw error;
      }
    };
    const timeout = setTimeout(() => {
      if (identitySettled) return;
      identitySettled = true;
      const failure = (initialFailure = new Error(
        "Timed out while capturing the exact Studio process identity.",
      ));
      controlState = "aborting";
      launcher.stdin.end("MCP_STUDIO_LAUNCH_ABORT\n");
      void waitForLauncherCompletion(
        "Timed out aborting the Studio identity launcher.",
      ).then((completionError) => {
        if (!identity) reject(completionError ?? failure);
      });
    }, 15000);

    launcher.stdout.on("data", (chunk: Buffer) => {
      if (identitySettled) {
        controlOutput = (controlOutput + chunk.toString("utf8")).slice(-1024);
        if (controlOutput.includes("MCP_STUDIO_LAUNCH_RESUMED")) signalResume();
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) {
        const failure = (initialFailure = new Error(
          "Studio launcher identity output exceeded 1 MiB.",
        ));
        identitySettled = true;
        controlState = "aborting";
        launcher.stdin.end("MCP_STUDIO_LAUNCH_ABORT\n");
        void waitForLauncherCompletion(
          "Timed out aborting the oversized Studio identity response.",
        ).then((completionError) => {
          if (!identity) reject(completionError ?? failure);
        });
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      identitySettled = true;
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(stdout.slice(0, newline).trim()) as {
          pid?: unknown;
          started?: unknown;
        };
        const nativePid = Number(parsed.pid);
        const nativeStartedAt =
          typeof parsed.started === "string" &&
          /^[1-9]\d*$/u.test(parsed.started)
            ? parsed.started
            : undefined;
        if (
          !Number.isSafeInteger(nativePid) ||
          nativePid <= 0 ||
          nativeStartedAt === undefined
        ) {
          throw new Error(
            "PowerShell returned an invalid native Studio process identity.",
          );
        }
        identity = { pid: nativePid, startedAt: nativeStartedAt };
        resolve({
          pid: nativePid,
          nativePid,
          nativeStartedAt,
          unref: () => {},
          authorize,
          release,
          abort,
        });
      } catch (error) {
        const failure = (initialFailure =
          error instanceof Error ? error : new Error(String(error)));
        controlState = "aborting";
        launcher.stdin.end("MCP_STUDIO_LAUNCH_ABORT\n");
        void waitForLauncherCompletion(
          "Timed out aborting the invalid Studio identity response.",
        ).then((completionError) => {
          if (!identity) reject(completionError ?? failure);
        });
      }
    });
    launcher.stdin.on("error", (error) => {
      if (!initialFailure) initialFailure = error;
    });
    launcher.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length <= 1024 * 1024) stderr += chunk.toString("utf8");
    });
    launcher.once("error", (error) => {
      clearTimeout(timeout);
      signalResume(error);
      completeLauncher(error);
      if (!identity) reject(error);
    });
    launcher.once("exit", (code) => {
      clearTimeout(timeout);
      void (async () => {
        if (code === 0 && identity && !initialFailure) {
          if (!resumeSettled)
            signalResume(
              new Error("Studio launcher exited before resume acknowledgment."),
            );
          completeLauncher();
          return;
        }
        let cleanupError: unknown;
        if (identity) {
          try {
            await stopWindowsStudio(identity.pid, identity.startedAt);
          } catch (error) {
            cleanupError = error;
          }
        }
        const detail =
          initialFailure?.message ??
          (stderr.trim() || `PowerShell launcher exited with code ${code}.`);
        const cleanupDetail = cleanupError
          ? ` Exact Studio cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          : "";
        const error = new Error(`${detail}${cleanupDetail}`);
        signalResume(error);
        completeLauncher(error);
        if (!identity) reject(error);
      })();
    });
  });
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
const LAUNCH_COMPLETION_TIMEOUT_MS = 3 * 60 * 1000;

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
  return (
    path.dirname(resolvedFile) === path.resolve(BASEPLATE_TEMP_DIR) &&
    BASEPLATE_TEMP_NAME.test(path.basename(resolvedFile))
  );
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
  private launchCompletionTimers = new Map<string, NodeJS.Timeout>();
  private launchControls = retainedLaunchControls;
  private readonly registry: ManagedInstanceRegistry;
  private readonly processAdapter: StudioProcessAdapter;
  private readonly platformCapabilities?: StudioPlatformCapabilities;
  private readonly windowsStudioLauncher: NonNullable<
    StudioInstanceManagerOptions['windowsStudioLauncher']
  >;
  private readonly confirmedExitMisses: number;
  private readonly confirmedExitGraceMs: number;
  private readonly snapshotCacheMs: number;
  private readonly launchCompletionTimeoutMs: number;
  private coordinatorTimer?: ReturnType<typeof setInterval>;
  private coordinatorRefresh?: Promise<void>;
  private cachedSnapshot?: StudioProcessSnapshot;
  private snapshotInFlight?: Promise<StudioProcessSnapshot>;
  private launchQueue: Promise<void> = Promise.resolve();

  constructor(options: StudioInstanceManagerOptions = {}) {
    this.registry = options.registry ?? new ManagedInstanceRegistry(options.registryDir);
    this.processAdapter = options.processAdapter ?? {};
    this.platformCapabilities = options.platformCapabilities;
    this.windowsStudioLauncher = options.windowsStudioLauncher ?? spawnWindowsStudio;
    this.confirmedExitMisses = options.confirmedExitMisses ?? 2;
    this.confirmedExitGraceMs = options.confirmedExitGraceMs ?? 5000;
    this.snapshotCacheMs = options.snapshotCacheMs ?? 0;
    this.launchCompletionTimeoutMs = options.launchCompletionTimeoutMs ?? LAUNCH_COMPLETION_TIMEOUT_MS;
  }

  getLifecycleCapabilities(): StudioLifecycleCapabilities {
    const platform = this.platformCapabilities ?? getStudioPlatformCapabilities();
    if (this.processAdapter.spawnStudio) {
      return {
        hostPlatform: platform.hostPlatform,
        windowsInteropAvailable: platform.windowsInteropAvailable,
        processIdentity: {
          supported: true,
          launcher: 'custom-adapter',
        },
      };
    }
    return {
      hostPlatform: platform.hostPlatform,
      windowsInteropAvailable: platform.windowsInteropAvailable,
      processIdentity: { ...platform.processIdentity },
    };
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

  peekByLaunchId(launchId: string): ManagedStudioInstance | undefined {
    return [...this.managedByInstanceId.values(), ...this.pending].find(
      (record) => record.recordId === launchId,
    );
  }

  async authorizeByLaunchId(launchId: string): Promise<ManagedStudioInstance> {
    const record = this.peekByLaunchId(launchId);
    if (!record)
      throw new Error(
        `Launch ${launchId} is not retained by this broker process.`,
      );
    if (
      record.closedAt !== undefined ||
      record.state === "failed" ||
      record.state === "exited"
    ) {
      throw new Error(
        `Launch ${launchId} is no longer eligible for process authorization.`,
      );
    }
    if (record.processAuthorizationState === "authorized") return record;
    const control = this.launchControls.get(launchId);
    if (record.processAuthorizationState !== "pending" || !control) {
      throw new Error(
        `Launch ${launchId} has no retained process authorization handle.`,
      );
    }
    try {
      this.armLaunchCompletionTimer(record);
      await control.authorize();
      record.processAuthorizationState = "authorized";
      await this.persist(record);
      this.armLaunchCompletionTimer(record);
      return record;
    } catch (error) {
      record.processAuthorizationState = "pending";
      const detail = error instanceof Error ? error.message : String(error);
      await this.markFailed(
        record,
        `Studio process authorization failed: ${detail}`,
      );
      throw error;
    }
  }

  async completeByLaunchId(launchId: string): Promise<ManagedStudioInstance> {
    const record = this.peekByLaunchId(launchId);
    if (!record)
      throw new Error(
        `Launch ${launchId} is not retained by this broker process.`,
      );
    if (
      record.closedAt !== undefined ||
      record.state === "failed" ||
      record.state === "exited"
    ) {
      throw new Error(
        `Launch ${launchId} is no longer eligible for ownership release.`,
      );
    }
    if (record.processAuthorizationState === "released") return record;
    const control = this.launchControls.get(launchId);
    if (record.processAuthorizationState !== "authorized" || !control) {
      throw new Error(
        `Launch ${launchId} has no authorized ownership handle to release.`,
      );
    }
    try {
      this.clearLaunchCompletionTimer(record);
      await control.release();
      record.processAuthorizationState = "released";
      this.launchControls.delete(launchId);
      await this.persist(record);
      return record;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.markFailed(
        record,
        `Studio process ownership release failed: ${detail}`,
      );
      throw error;
    }
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
    if (
      record.closedAt !== undefined ||
      record.state === 'failed' ||
      record.state === 'exited'
    ) return record;
    record.state = 'failed';
    record.failedAt = Date.now();
    record.failureReason = reason;
    this.clearConnectionTimer(record);
    this.clearLaunchCompletionTimer(record);
    const control = record.recordId
      ? this.launchControls.get(record.recordId)
      : undefined;
    if (record.processAuthorizationState !== 'released' && control) {
      try {
        await control.abort();
        const exitedAt = Date.now();
        record.exitedAt = exitedAt;
        record.closedAt = exitedAt;
        record.processObservationStatus = 'not_running';
        record.lastProcessObservationAt = exitedAt;
        record.lastSuccessfulProcessObservationAt = exitedAt;
        this.cleanupManagedRecord(record);
        this.markClosedInMemory(record);
      } catch (error) {
        record.failureReason += ` Exact suspended-process cleanup also failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    await this.persist(record);
    return record;
  }

  async refresh(
    record: ManagedStudioInstance,
    providedSnapshot?: StudioProcessSnapshot,
  ): Promise<ManagedStudioInstance> {
    if (record.closedAt !== undefined) return record;
    const snapshot = providedSnapshot ?? (await this.getProcessSnapshot());
    await this.applyProcessObservation(
      record,
      this.observeRecord(record, snapshot),
    );
    if (record.closedAt !== undefined) return record;

    if (
      record.state === "launching" &&
      record.connectionDeadlineAt !== undefined &&
      Date.now() >= record.connectionDeadlineAt
    ) {
      return this.markFailed(
        record,
        "Studio launched, but the MCP plugin did not connect before timeout.",
      );
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
    const studioWorkingDirectory = parseStudioWorkingDirectory(options.studioWorkingDirectory);
    if (
      options.studioExecutable !== undefined &&
      (typeof options.studioExecutable !== 'string' ||
        options.studioExecutable.length === 0 ||
        options.studioExecutable.includes('\0'))
    ) {
      throw new Error('studio_executable must be a non-empty string without null characters.');
    }
    const lifecycleCapabilities = this.getLifecycleCapabilities();
    if (options.requireProcessIdentity && !lifecycleCapabilities.processIdentity.supported) {
      throw new StudioLaunchPreDispatchError(lifecycleCapabilities);
    }
    const preparedOptions = prepareStudioLaunchOptions(options);
    const bootId = await this.getCurrentBootId();
    const before = new Set(initialSnapshot.status === 'ok' ? initialSnapshot.processes.map((proc) => proc.Id) : []);
    const exe = preparedOptions.studioExecutable ??
      (this.processAdapter.resolveStudioExe ? await this.processAdapter.resolveStudioExe() : await resolveStudioExeAsync());
    const args = await Promise.all(buildStudioLaunchArgs(preparedOptions).map(toStudioLaunchArgAsync));
    const spawnOptions: Parameters<typeof spawn>[2] = {
      cwd: studioWorkingDirectory ??
        (isWsl() && existsSync('/mnt/c/Windows') ? '/mnt/c/Windows' : process.cwd()),
      detached: true,
      stdio: 'ignore',
      ...(processEnvironment ? { env: patchedProcessEnvironment(processEnvironment) } : {}),
    };
    let proc: StudioChildProcess;
    try {
      if (this.processAdapter.spawnStudio) {
        proc = await this.processAdapter.spawnStudio(exe, args, spawnOptions);
      } else if (
        lifecycleCapabilities.processIdentity.launcher === 'windows-retained' ||
        lifecycleCapabilities.processIdentity.launcher === 'wsl-windows-retained'
      ) {
        proc = await this.windowsStudioLauncher(
          exe,
          args,
          processEnvironment,
          studioWorkingDirectory,
        );
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

    if (
      options.requireProcessIdentity &&
      (!Number.isSafeInteger(proc.nativePid) ||
        (proc.nativePid ?? 0) <= 0 ||
        proc.nativeStartedAt === undefined ||
        !/^[1-9]\d*$/u.test(proc.nativeStartedAt) ||
        !proc.authorize ||
        !proc.release ||
        !proc.abort)
    ) {
      const reason = 'Studio launcher did not return an exact creation identity and suspended-process control handles.';
      let abortError: unknown;
      try {
        if (proc.abort) {
          await proc.abort();
        } else if (proc.nativePid && proc.nativeStartedAt) {
          await this.closeProcess(proc.nativePid, proc.nativeStartedAt);
        } else {
          throw new Error('the process adapter did not retain an abort handle or exact process identity');
        }
      } catch (error) {
        abortError = error;
      }
      cleanupManagedBaseplateFiles({ source: preparedOptions.source, localPlaceFile: preparedOptions.localPlaceFile });
      const abortDetail = abortError
        ? ` Exact child cleanup also failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`
        : ' The owned process was stopped.';
      throw new Error(`${reason}${abortDetail}`);
    }

    if (!options.requireProcessIdentity && proc.authorize) {
      try {
        await proc.authorize();
        await proc.release?.();
      } catch (error) {
        try {
          await proc.abort?.();
        } finally {
          cleanupManagedBaseplateFiles({ source: preparedOptions.source, localPlaceFile: preparedOptions.localPlaceFile });
        }
        throw error;
      }
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
      studioWorkingDirectory,
      launchedAt,
      connectionDeadlineAt: options.requireProcessIdentity
        ? undefined
        : launchedAt + (options.connectionTimeoutMs ?? 120000),
      state: 'launching',
      ownerPid: process.pid,
      bootId,
      deleteLocalPlaceFileOnClose: options.source === 'baseplate',
      processAuthorizationState: options.requireProcessIdentity && proc.authorize && proc.release
        ? 'pending'
        : 'released',
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
      if (
        record.recordId &&
        record.processAuthorizationState === 'pending' &&
        proc.authorize &&
        proc.release &&
        proc.abort
      ) {
        this.launchControls.set(record.recordId, {
          authorize: proc.authorize,
          release: proc.release,
          abort: proc.abort,
        });
        this.armLaunchCompletionTimer(record);
      }
    } catch (error) {
      this.pending.delete(record);
      const processId = record.nativeProcessId ?? record.spawnPid;
      let stopError: unknown;
      try {
        if (proc.abort) {
          await proc.abort();
        } else if (processId) {
          await this.closeProcess(processId, record.nativeProcessStartedAt);
        }
      } catch (caught) {
        stopError = caught;
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

  async close(
    record: ManagedStudioInstance,
  ): Promise<ManagedStudioCloseResult> {
    if (record.closedAt !== undefined) {
      return {
        status: "already_closed",
        launchId: record.recordId,
        instanceId: record.instanceId,
      };
    }
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) {
      throw new Error(
        `Cannot close ${record.instanceId ?? "Studio launch"} because its process id was not detected.`,
      );
    }
    const control = record.recordId
      ? this.launchControls.get(record.recordId)
      : undefined;
    if (record.processAuthorizationState !== "released" && control) {
      await control.abort();
      const closedAt = Date.now();
      record.closedAt = closedAt;
      record.exitedAt = closedAt;
      if (record.state !== "failed") record.state = "exited";
      record.processObservationStatus = "not_running";
      record.lastProcessObservationAt = closedAt;
      record.lastSuccessfulProcessObservationAt = closedAt;
      record.lastProcessObservationError = undefined;
      this.cleanupManagedRecord(record);
      this.markClosedInMemory(record);
      await this.persist(record);
      return {
        status: "closed",
        launchId: record.recordId,
        instanceId: record.instanceId,
      };
    }

    const snapshot = await this.getProcessSnapshot(true);
    const observation = this.observeRecord(record, snapshot);
    if (observation.status === "unknown") {
      await this.applyProcessObservation(record, observation);
      throw new Error(
        `Cannot verify the managed Studio process because process observation failed: ${observation.error}`,
      );
    }
    if (observation.status === "not_running") {
      await this.markProcessExited(
        record,
        undefined,
        observation.reason === "identity_mismatch"
          ? "Studio process identity changed; the retained PID was not reused."
          : record.failureReason,
      );
      await this.registry.logEvent({
        event: "registry_close_already_stopped",
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason:
          observation.reason === "identity_mismatch"
            ? "identity_mismatch"
            : "pid_not_running",
        action: "marked_closed_and_cleaned_baseplate",
      });
      return {
        status: "already_closed",
        launchId: record.recordId,
        instanceId: record.instanceId,
      };
    }

    try {
      await this.closeProcess(processId, record.nativeProcessStartedAt);
    } catch (error) {
      const retry = await this.getProcessSnapshot(true);
      const retryObservation = this.observeRecord(record, retry);
      if (
        retryObservation.status === "running" ||
        retryObservation.status === "unknown"
      )
        throw error;
      await this.registry.logEvent({
        event: "registry_close_already_stopped",
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: "stop_raced_with_exit",
        action: "marked_closed_and_cleaned_baseplate",
      });
      await this.markProcessExited(record, undefined, record.failureReason);
      return {
        status: "already_closed",
        launchId: record.recordId,
        instanceId: record.instanceId,
      };
    }

    const closedAt = Date.now();
    record.closedAt = closedAt;
    record.exitedAt = record.exitedAt ?? closedAt;
    if (record.state !== "failed") record.state = "exited";
    record.processObservationStatus = "not_running";
    record.lastProcessObservationAt = closedAt;
    record.lastSuccessfulProcessObservationAt = closedAt;
    record.lastProcessObservationError = undefined;
    this.cleanupManagedRecord(record);
    this.markClosedInMemory(record);
    await this.persist(record);
    return {
      status: "closed",
      launchId: record.recordId,
      instanceId: record.instanceId,
    };
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
    await this.closeProcess(process.Id, process.StartTimeUtcFileTime);
  }

  private async closeProcess(
    processId: number,
    startedAt?: string,
  ): Promise<void> {
    if (this.processAdapter.stopProcess) {
      await this.processAdapter.stopProcess(processId, startedAt);
      return;
    }

    if (process.platform === "win32" || isWsl()) {
      if (startedAt === undefined) {
        throw new Error(
          "Cannot stop a Windows Studio process without its creation-time identity.",
        );
      }
      await stopWindowsStudio(processId, startedAt);
    } else {
      try {
        process.kill(processId, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
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

  private async registrySweepOptions(
    snapshot: StudioProcessSnapshot,
  ): Promise<RegistrySweepOptions> {
    return {
      currentBootId: await this.getCurrentBootId(),
      observeProcess: (record) =>
        this.observeRecord(this.fromRegistryRecord(record), snapshot),
      cleanupRecord: (record) => {
        if (
          record.processAuthorizationState !== "released" &&
          this.launchControls.has(record.recordId)
        )
          return;
        this.cleanupManagedRecord(record);
      },
      confirmedExitMisses: this.confirmedExitMisses,
      confirmedExitGraceMs: this.confirmedExitGraceMs,
    };
  }

  private async sweepRegistry(snapshot: StudioProcessSnapshot): Promise<void> {
    const sweepOptions = await this.registrySweepOptions(snapshot);
    await this.registry.sweep(sweepOptions);
    const persisted = await this.registry.listOpenUnchecked();
    for (const registryRecord of persisted) {
      const ownerPid = registryRecord.ownerPid;
      if (
        registryRecord.processAuthorizationState === "released" ||
        this.launchControls.has(registryRecord.recordId) ||
        registryRecord.bootId !== sweepOptions.currentBootId ||
        ownerPid === undefined ||
        (ownerPid !== process.pid && isProcessAlive(ownerPid))
      ) {
        continue;
      }
      const record = this.fromRegistryRecord(registryRecord);
      if (this.observeRecord(record, snapshot).status !== "running") continue;
      const processId = record.nativeProcessId ?? record.spawnPid;
      if (!processId || !record.nativeProcessStartedAt) {
        record.state = "failed";
        record.failedAt = Date.now();
        record.failureReason =
          "Orphaned unreleased Studio launch has no exact process identity for cleanup.";
        await this.persist(record);
        continue;
      }
      try {
        await this.closeProcess(processId, record.nativeProcessStartedAt);
        const closedAt = Date.now();
        record.state = "failed";
        record.failedAt = closedAt;
        record.failureReason =
          "Orphaned unreleased Studio launch was stopped after its broker owner exited.";
        record.exitedAt = closedAt;
        record.closedAt = closedAt;
        record.processObservationStatus = "not_running";
        record.lastProcessObservationAt = closedAt;
        record.lastSuccessfulProcessObservationAt = closedAt;
        this.cleanupManagedRecord(record);
        await this.persist(record);
      } catch (error) {
        record.state = "failed";
        record.failedAt = Date.now();
        record.failureReason = `Failed to stop orphaned unreleased Studio launch: ${
          error instanceof Error ? error.message : String(error)
        }`;
        await this.persist(record);
      }
    }
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

  private cleanupManagedRecord(record: {
    recordId?: string;
    source: string;
    localPlaceFile?: string;
  }) {
    if (record.recordId) this.launchControls.delete(record.recordId);
    if (record.recordId) this.clearLaunchCompletionTimer(record);
    if (record.source !== "baseplate") return;
    cleanupManagedBaseplateFiles({
      source: "baseplate",
      localPlaceFile: record.localPlaceFile,
    });
  }

  private markClosedInMemory(record: ManagedStudioInstance) {
    record.closedAt = record.closedAt ?? Date.now();
    if (record.instanceId) this.managedByInstanceId.delete(record.instanceId);
    this.pending.delete(record);
    this.clearConnectionTimer(record);
    this.clearLaunchCompletionTimer(record);
  }

  private armLaunchCompletionTimer(record: ManagedStudioInstance) {
    if (!record.recordId) return;
    this.clearLaunchCompletionTimer(record);
    const timeout = setTimeout(() => {
      this.runInBackground(
        'aborting an uncompleted Studio launch',
        this.markFailed(
          record,
          'Carbon did not complete Studio launch ownership transfer before timeout.',
        ),
      );
    }, this.launchCompletionTimeoutMs);
    if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
    this.launchCompletionTimers.set(record.recordId, timeout);
  }

  private clearLaunchCompletionTimer(record: { recordId?: string }) {
    if (!record.recordId) return;
    const timer = this.launchCompletionTimers.get(record.recordId);
    clearTimeout(timer);
    this.launchCompletionTimers.delete(record.recordId);
  }

  private async markProcessExited(
    record: ManagedStudioInstance,
    exitCode?: number,
    reason?: string,
  ): Promise<ManagedStudioInstance> {
    if (record.closedAt !== undefined) return record;
    const control = record.recordId
      ? this.launchControls.get(record.recordId)
      : undefined;
    let controlFailure: string | undefined;
    if (record.processAuthorizationState !== "released" && control) {
      try {
        await control.abort();
      } catch (error) {
        controlFailure = error instanceof Error ? error.message : String(error);
      }
    }
    const exitedAt = Date.now();
    record.exitedAt = exitedAt;
    record.closedAt = exitedAt;
    if (record.state !== "failed") record.state = "exited";
    record.processObservationStatus = "not_running";
    record.lastProcessObservationAt = exitedAt;
    record.lastSuccessfulProcessObservationAt = exitedAt;
    record.lastProcessObservationError = undefined;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (reason) record.failureReason = reason;
    if (controlFailure) {
      record.failureReason = [
        record.failureReason,
        `Launch ownership cleanup failed: ${controlFailure}`,
      ]
        .filter(Boolean)
        .join(" ");
    }
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
      studioWorkingDirectory: record.studioWorkingDirectory,
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
      processAuthorizationState: record.processAuthorizationState,
      lastProcessObservationAt: record.lastProcessObservationAt,
      lastSuccessfulProcessObservationAt: record.lastSuccessfulProcessObservationAt,
      lastProcessObservationError: record.lastProcessObservationError,
      consecutiveConfirmedMisses: record.consecutiveConfirmedMisses,
      firstConfirmedMissAt: record.firstConfirmedMissAt,
    };
  }

  private fromRegistryRecord(
    record: ManagedInstanceRegistryRecord,
  ): ManagedStudioInstance {
    const state =
      record.state ??
      (record.closedAt !== undefined
        ? "exited"
        : record.instanceId
          ? "connected"
          : "launching");
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
      studioWorkingDirectory: record.studioWorkingDirectory,
      launchedAt: record.launchedAt,
      connectionDeadlineAt:
        record.connectionDeadlineAt ??
        (state === "launching" && record.processAuthorizationState === undefined
          ? record.launchedAt + 120000
          : undefined),
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
      processAuthorizationState: record.processAuthorizationState ?? "released",
      lastProcessObservationAt: record.lastProcessObservationAt,
      lastSuccessfulProcessObservationAt:
        record.lastSuccessfulProcessObservationAt,
      lastProcessObservationError: record.lastProcessObservationError,
      consecutiveConfirmedMisses: record.consecutiveConfirmedMisses,
      firstConfirmedMissAt: record.firstConfirmedMissAt,
    };
  }
}

import { spawn, type SpawnOptions } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import type { StudioProcessInfo } from './studio-instance-manager.js';

// Native Linux hosts run the Windows Studio build under Wine. The configured
// launcher (ROBLOX_STUDIO_WINE_LAUNCHER) is invoked as
// `<launcher> <studio-exe-unix-path> <studio args...>` and must `exec` Wine on
// Studio, so the Studio process keeps the PID that this module gates, retains,
// and later stops.

const DEFAULT_PROC_ROOT = '/proc';
const STUDIO_EXECUTABLE_NAME = 'robloxstudiobeta.exe';
// Stop the gate shell before it execs the launcher, so nothing Windows-side
// runs until the launch is authorized with SIGCONT.
const GATE_SCRIPT = 'kill -STOP $$ && exec "$0" "$@"';
const GATE_TIMEOUT_MS = 5000;
// Wine start-up is slow under x86 emulation on ARM64 hosts.
const STUDIO_EXEC_TIMEOUT_MS = 30000;
const ABORT_TIMEOUT_MS = 10000;
const TERMINATE_GRACE_MS = 5000;
const POLL_INTERVAL_MS = 50;

const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_SECOND = 10000000n;
// /proc/<pid>/stat reports start time in USER_HZ, which Linux fixes at 100.
const USER_HZ = 100n;

const bootTimeByProcRoot = new Map<string, bigint>();

interface ProcStat {
  state: string;
  startTimeTicks: bigint;
}

export interface WineStudioLaunchOptions {
  procRoot?: string;
  gateTimeoutMs?: number;
  studioExecTimeoutMs?: number;
}

export interface WineStudioProcess {
  pid: number;
  nativePid: number;
  nativeStartedAt: string;
  unref: () => void;
  authorize: () => Promise<void>;
  release: () => Promise<void>;
  abort: () => Promise<void>;
  onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  onError: (listener: (error: Error) => void) => void;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function isMissingProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
}

/** Windows FILETIME (100 ns ticks since 1601-01-01 UTC) of a Linux process start. */
export function procStartTimeToFileTime(bootTimeSeconds: bigint, startTimeTicks: bigint): string {
  return (
    FILETIME_UNIX_EPOCH +
    bootTimeSeconds * FILETIME_TICKS_PER_SECOND +
    startTimeTicks * (FILETIME_TICKS_PER_SECOND / USER_HZ)
  ).toString();
}

/** Wine maps drive Z: to the Unix root. */
export function toWineWindowsPath(unixPath: string): string {
  return `Z:${unixPath.replace(/\//g, '\\')}`;
}

/** A Wine Studio process has argv[0] ending in RobloxStudioBeta.exe after either path separator. */
export function isWineStudioCommand(argv0: string | undefined): boolean {
  return argv0 !== undefined && argv0.split(/[\\/]/u).pop()?.toLowerCase() === STUDIO_EXECUTABLE_NAME;
}

// The comm field may contain spaces and parentheses, so fields are counted
// from the last ')'. Field 3 is the state and field 22 the start time.
function parseProcStat(content: string): ProcStat {
  const commEnd = content.lastIndexOf(')');
  const fields = commEnd < 0 ? [] : content.slice(commEnd + 1).trim().split(/\s+/u);
  const state = fields[0];
  const startTime = fields[19];
  if (!state || !startTime || !/^\d+$/u.test(startTime)) {
    throw new Error('Malformed /proc/<pid>/stat.');
  }
  return { state, startTimeTicks: BigInt(startTime) };
}

function readProcStat(procRoot: string, pid: number): ProcStat | undefined {
  let content: string;
  try {
    content = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
  } catch (error) {
    if (isMissingProcessError(error)) return undefined;
    throw error;
  }
  return parseProcStat(content);
}

function readArgv0(procRoot: string, pid: number): string | undefined {
  try {
    return readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0')[0] || undefined;
  } catch (error) {
    if (isMissingProcessError(error)) return undefined;
    throw error;
  }
}

// Read once per process: btime moves after wall-clock steps, and identities
// computed by this broker must compare exactly.
function bootTimeSeconds(procRoot: string): bigint {
  const cached = bootTimeByProcRoot.get(procRoot);
  if (cached !== undefined) return cached;
  const match = /^btime\s+(\d+)\s*$/mu.exec(readFileSync(`${procRoot}/stat`, 'utf8'));
  if (!match) throw new Error(`${procRoot}/stat has no btime.`);
  const bootTime = BigInt(match[1]);
  bootTimeByProcRoot.set(procRoot, bootTime);
  return bootTime;
}

/** FILETIME identity of a live (non-zombie) process, or undefined when it is gone. */
export function readWineProcessStartTime(pid: number, procRoot = DEFAULT_PROC_ROOT): string | undefined {
  const stat = readProcStat(procRoot, pid);
  if (!stat || stat.state === 'Z' || stat.state === 'X') return undefined;
  return procStartTimeToFileTime(bootTimeSeconds(procRoot), stat.startTimeTicks);
}

export function listWineStudioProcesses(procRoot = DEFAULT_PROC_ROOT): StudioProcessInfo[] {
  const processes: StudioProcessInfo[] = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    let argv0: string | undefined;
    let startedAt: string | undefined;
    try {
      argv0 = readArgv0(procRoot, pid);
      if (!isWineStudioCommand(argv0)) continue;
      startedAt = readWineProcessStartTime(pid, procRoot);
    } catch (error) {
      // Other users' processes can deny access; they are never ours to manage.
      if ((error as NodeJS.ErrnoException).code === 'EACCES') continue;
      throw error;
    }
    if (startedAt === undefined) continue;
    processes.push({
      Id: pid,
      Name: 'RobloxStudioBeta',
      Path: argv0,
      MainWindowTitle: '',
      StartTimeUtcFileTime: startedAt,
    });
  }
  return processes;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
}

/** Stops the exact Wine Studio process identified by PID and creation FILETIME. */
export async function stopWineStudio(
  pid: number,
  startedAt: string,
  timeoutMs: number,
  procRoot = DEFAULT_PROC_ROOT,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('processId must be a positive integer.');
  if (!/^[1-9]\d*$/u.test(startedAt)) throw new Error('startedAt must be a positive FILETIME string.');
  const isTarget = () => readWineProcessStartTime(pid, procRoot) === startedAt;
  if (!isTarget()) return;
  signalProcess(pid, 'SIGTERM');
  const graceDeadline = Date.now() + Math.min(TERMINATE_GRACE_MS, timeoutMs / 2);
  while (Date.now() < graceDeadline) {
    await delay(POLL_INTERVAL_MS);
    if (!isTarget()) return;
  }
  if (isTarget()) signalProcess(pid, 'SIGKILL');
}

/**
 * Spawns the Wine launcher behind a stopped gate shell. The gated PID is the
 * exact Studio identity: the gate execs the launcher and the launcher execs
 * Wine, so the PID and its start time never change.
 */
export async function spawnWineStudio(
  launcher: string,
  exe: string,
  args: string[],
  spawnOptions: Pick<SpawnOptions, 'cwd' | 'env'>,
  options: WineStudioLaunchOptions = {},
): Promise<WineStudioProcess> {
  const procRoot = options.procRoot ?? DEFAULT_PROC_ROOT;
  const child = spawn('/bin/sh', ['-c', GATE_SCRIPT, launcher, exe, ...args], {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    detached: true,
    stdio: 'ignore',
  });
  let exitDetail: string | undefined;
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  child.once('exit', (code, signal) => {
    exitDetail ??= signal ? `signal ${signal}` : `code ${code}`;
    markExited();
  });
  child.once('error', (error) => {
    exitDetail ??= error.message;
  });

  const pid = child.pid;
  if (pid === undefined) {
    // Spawn failures are emitted on the next tick.
    await delay(0);
    throw new Error(`Failed to start the Wine Studio launch gate: ${exitDetail ?? 'no PID was assigned'}.`);
  }
  const gateDeadline = Date.now() + (options.gateTimeoutMs ?? GATE_TIMEOUT_MS);
  let gated: ProcStat | undefined;
  try {
    while (exitDetail === undefined && Date.now() < gateDeadline) {
      const stat = readProcStat(procRoot, pid);
      if (stat?.state === 'T') {
        gated = stat;
        break;
      }
      await delay(10);
    }
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  if (!gated) {
    child.kill('SIGKILL');
    throw new Error(
      exitDetail === undefined
        ? 'Timed out waiting for the Wine Studio launch gate to stop; the gated process was killed.'
        : `Wine Studio launch gate exited before stopping (${exitDetail}).`,
    );
  }
  const nativeStartedAt = procStartTimeToFileTime(bootTimeSeconds(procRoot), gated.startTimeTicks);

  let controlState: 'pending' | 'authorizing' | 'resumed' | 'released' | 'aborted' = 'pending';
  const authorize = async (): Promise<void> => {
    if (controlState === 'resumed') return;
    if (controlState !== 'pending') {
      throw new Error(`Studio launch cannot be authorized from ${controlState}.`);
    }
    controlState = 'authorizing';
    child.kill('SIGCONT');
    const deadline = Date.now() + (options.studioExecTimeoutMs ?? STUDIO_EXEC_TIMEOUT_MS);
    try {
      while (exitDetail === undefined && Date.now() < deadline) {
        if (
          readWineProcessStartTime(pid, procRoot) === nativeStartedAt &&
          isWineStudioCommand(readArgv0(procRoot, pid))
        ) {
          controlState = 'resumed';
          return;
        }
        await delay(POLL_INTERVAL_MS);
      }
    } catch (error) {
      controlState = 'aborted';
      child.kill('SIGKILL');
      throw error;
    }
    controlState = 'aborted';
    if (exitDetail !== undefined) {
      throw new Error(`Wine Studio process ${pid} exited (${exitDetail}) before RobloxStudioBeta.exe started.`);
    }
    child.kill('SIGKILL');
    throw new Error(
      `Wine launcher did not exec RobloxStudioBeta.exe in gated process ${pid}; the process was killed. ` +
      'ROBLOX_STUDIO_WINE_LAUNCHER must exec Wine so Studio keeps the launcher PID.',
    );
  };
  const release = async (): Promise<void> => {
    if (controlState === 'released') return;
    if (controlState !== 'resumed') {
      throw new Error(`Studio launch cannot be released from ${controlState}.`);
    }
    controlState = 'released';
  };
  const abort = async (): Promise<void> => {
    if (controlState === 'released') return;
    controlState = 'aborted';
    if (exitDetail !== undefined) return;
    // The child is not yet reaped, so its PID cannot have been reused.
    child.kill('SIGKILL');
    const { promise: timedOut, resolve: markTimedOut } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => markTimedOut(true), ABORT_TIMEOUT_MS);
    try {
      if (await Promise.race([exited.then(() => false), timedOut])) {
        throw new Error(`Timed out aborting Wine Studio process ${pid}.`);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    pid,
    nativePid: pid,
    nativeStartedAt,
    unref: () => child.unref(),
    authorize,
    release,
    abort,
    onExit: (listener) => { child.once('exit', listener); },
    onError: (listener) => { child.once('error', listener); },
  };
}

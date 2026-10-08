import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { randomUUID } from 'crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import * as path from 'path';
import { defaultManagedInstanceRegistryDir } from './managed-instance-registry.js';
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
// Wine start-up is slow under x86 emulation on ARM64 hosts, and a cold start
// also launches wineserver and may update the prefix first.
const STUDIO_EXEC_TIMEOUT_MS = 60000;
// Stay below the broker's 3-minute launch completion timeout.
const MAX_STUDIO_EXEC_TIMEOUT_MS = 150000;
const STUDIO_EXEC_TIMEOUT_ENV = 'ROBLOX_STUDIO_WINE_START_TIMEOUT_MS';
const ABORT_TIMEOUT_MS = 10000;
const TERMINATE_GRACE_MS = 5000;
const POLL_INTERVAL_MS = 50;
const LAUNCHER_LOGS_KEPT = 10;
const LAUNCHER_LOG_TAIL_BYTES = 4096;
const LAUNCHER_LOG_TAIL_LINES = 20;
const BOOT_ANCHOR_PREFIX = 'wine-boot-time-';

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
  /** Overrides ROBLOX_STUDIO_WINE_START_TIMEOUT_MS. */
  studioExecTimeoutMs?: number;
  /** Directory for per-launch launcher output logs; output is discarded when unset. */
  logDir?: string;
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

function readCmdline(procRoot: string, pid: number): string[] | undefined {
  let content: string;
  try {
    content = readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8');
  } catch (error) {
    if (isMissingProcessError(error)) return undefined;
    throw error;
  }
  const args = content.split('\0');
  if (args[args.length - 1] === '') args.pop();
  return args;
}

function readArgv0(procRoot: string, pid: number): string | undefined {
  return readCmdline(procRoot, pid)?.[0] || undefined;
}

// The real UID from status, not the /proc/<pid> owner, which becomes root for
// non-dumpable processes.
function readRealUid(procRoot: string, pid: number): number | undefined {
  let content: string;
  try {
    content = readFileSync(`${procRoot}/${pid}/status`, 'utf8');
  } catch (error) {
    if (isMissingProcessError(error)) return undefined;
    throw error;
  }
  const match = /^Uid:\s+(\d+)/mu.exec(content);
  if (!match) throw new Error(`Malformed ${procRoot}/${pid}/status.`);
  return Number(match[1]);
}

function readLiveBootTime(procRoot: string): bigint {
  const match = /^btime\s+(\d+)\s*$/mu.exec(readFileSync(`${procRoot}/stat`, 'utf8'));
  if (!match) throw new Error(`${procRoot}/stat has no btime.`);
  return BigInt(match[1]);
}

function readBootId(procRoot: string): string | undefined {
  try {
    const bootId = readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim();
    return /^[0-9a-f-]+$/iu.test(bootId) ? bootId : undefined;
  } catch {
    return undefined;
  }
}

function readBootAnchor(file: string): bigint | undefined {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const match = /^(\d+)\n?$/u.exec(content);
  if (!match) throw new Error(`${file} is not a boot time.`);
  return BigInt(match[1]);
}

function removeStaleBootAnchors(anchorDir: string, currentName: string): void {
  try {
    for (const name of readdirSync(anchorDir)) {
      if (!name.startsWith(BOOT_ANCHOR_PREFIX) || name.startsWith(currentName)) continue;
      rmSync(path.join(anchorDir, name), { force: true });
    }
  } catch {
    // Stale anchors are a few bytes each; removal is housekeeping.
  }
}

// btime is the wall clock minus uptime, so it moves whenever the clock is
// stepped (NTP, chrony makestep). Identities are persisted in the registry and
// compared exactly, including by a later broker process, so every broker in a
// boot converts start ticks with the first btime any of them observed.
function anchoredBootTime(procRoot: string, liveBootTime: bigint): bigint {
  const bootId = readBootId(procRoot);
  if (bootId === undefined) return liveBootTime;
  const anchorDir = defaultManagedInstanceRegistryDir();
  const anchorName = `${BOOT_ANCHOR_PREFIX}${bootId}`;
  const anchorFile = path.join(anchorDir, anchorName);
  try {
    const existing = readBootAnchor(anchorFile);
    if (existing !== undefined) return existing;
    mkdirSync(anchorDir, { recursive: true });
    // Publish atomically: link() fails if another broker won the race.
    const tmpFile = `${anchorFile}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpFile, `${liveBootTime}\n`);
    try {
      linkSync(tmpFile, anchorFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      unlinkSync(tmpFile);
    }
    removeStaleBootAnchors(anchorDir, anchorName);
    return readBootAnchor(anchorFile) ?? liveBootTime;
  } catch (error) {
    console.error(
      `[studio] Could not persist the Wine boot-time anchor at ${anchorFile}: ` +
      `${error instanceof Error ? error.message : String(error)}. ` +
      'Studio identities may not survive a broker restart after a clock change.',
    );
    return liveBootTime;
  }
}

function bootTimeSeconds(procRoot: string): bigint {
  const cached = bootTimeByProcRoot.get(procRoot);
  if (cached !== undefined) return cached;
  const bootTime = anchoredBootTime(procRoot, readLiveBootTime(procRoot));
  bootTimeByProcRoot.set(procRoot, bootTime);
  return bootTime;
}

/** FILETIME identity of a live (non-zombie) process, or undefined when it is gone. */
export function readWineProcessStartTime(pid: number, procRoot = DEFAULT_PROC_ROOT): string | undefined {
  const stat = readProcStat(procRoot, pid);
  if (!stat || stat.state === 'Z' || stat.state === 'X') return undefined;
  return procStartTimeToFileTime(bootTimeSeconds(procRoot), stat.startTimeTicks);
}

/**
 * Lists the Wine Studio processes owned by `uid` (the current user by default).
 * Other users' Studio processes can never be signalled, so they are not ours.
 */
export function listWineStudioProcesses(
  procRoot = DEFAULT_PROC_ROOT,
  uid: number | undefined = process.getuid?.(),
): StudioProcessInfo[] {
  const processes: StudioProcessInfo[] = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    let argv0: string | undefined;
    let startedAt: string | undefined;
    try {
      if (uid !== undefined && readRealUid(procRoot, pid) !== uid) continue;
      argv0 = readArgv0(procRoot, pid);
      if (!isWineStudioCommand(argv0)) continue;
      startedAt = readWineProcessStartTime(pid, procRoot);
    } catch (error) {
      // Other users' processes can deny access; they are never ours to manage.
      if ((error as NodeJS.ErrnoException).code === 'EACCES' || isMissingProcessError(error)) continue;
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
 * Kills a launch gate that is still stopped because its broker exited before
 * authorizing it. Only the exact gate (PID, start time, stopped, running the
 * gate script) is signalled; nothing Windows-side has run in it.
 */
export function killOrphanedWineLaunchGate(
  pid: number,
  startedAt: string,
  procRoot = DEFAULT_PROC_ROOT,
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const stat = readProcStat(procRoot, pid);
  if (stat?.state !== 'T') return false;
  if (procStartTimeToFileTime(bootTimeSeconds(procRoot), stat.startTimeTicks) !== startedAt) return false;
  const cmdline = readCmdline(procRoot, pid);
  if (cmdline?.[1] !== '-c' || cmdline[2] !== GATE_SCRIPT) return false;
  signalProcess(pid, 'SIGKILL');
  return true;
}

function studioExecTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const configured = process.env[STUDIO_EXEC_TIMEOUT_ENV];
  if (configured === undefined || configured === '') return STUDIO_EXEC_TIMEOUT_MS;
  const value = /^\d+$/u.test(configured) ? Number(configured) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STUDIO_EXEC_TIMEOUT_MS) {
    throw new Error(
      `${STUDIO_EXEC_TIMEOUT_ENV} must be a whole number of milliseconds from 1 to ${MAX_STUDIO_EXEC_TIMEOUT_MS}; got "${configured}".`,
    );
  }
  return value;
}

// One log per launch, named so lexical order is creation order. Studio keeps
// writing to its log for its whole life, so only the newest few are kept.
function openLauncherLog(logDir: string): { file: string; fd: number } | undefined {
  try {
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const file = path.join(logDir, `${stamp}-${randomUUID().slice(0, 8)}.log`);
    const fd = openSync(file, 'a', 0o600);
    const logs = readdirSync(logDir).filter((name) => name.endsWith('.log')).sort();
    for (const name of logs.slice(0, Math.max(0, logs.length - LAUNCHER_LOGS_KEPT))) {
      rmSync(path.join(logDir, name), { force: true });
    }
    return { file, fd };
  } catch (error) {
    console.error(
      `[studio] Could not open a Wine launcher log in ${logDir}; launcher output is discarded: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function launcherLogTail(file: string | undefined): string {
  if (file === undefined) return '';
  let tail: string;
  try {
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, LAUNCHER_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      tail = buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return ` Launcher log: ${file}.`;
  }
  const lines = tail.trimEnd().split('\n').slice(-LAUNCHER_LOG_TAIL_LINES).join('\n');
  return lines
    ? ` Launcher output (${file}):\n${lines}`
    : ` The launcher wrote no output (log: ${file}).`;
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
  const execTimeoutMs = studioExecTimeoutMs(options.studioExecTimeoutMs);
  const log = options.logDir === undefined ? undefined : openLauncherLog(options.logDir);
  let child: ChildProcess;
  try {
    child = spawn('/bin/sh', ['-c', GATE_SCRIPT, launcher, exe, ...args], {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      detached: true,
      stdio: log ? ['ignore', log.fd, log.fd] : 'ignore',
    });
  } finally {
    // The child holds its own copy of the descriptor.
    if (log) closeSync(log.fd);
  }
  const logTail = () => launcherLogTail(log?.file);
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
        : `Wine Studio launch gate exited before stopping (${exitDetail}).${logTail()}`,
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
    const deadline = Date.now() + execTimeoutMs;
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
      throw new Error(`Wine Studio process ${pid} exited (${exitDetail}) before RobloxStudioBeta.exe started.${logTail()}`);
    }
    child.kill('SIGKILL');
    throw new Error(
      `Wine launcher did not exec RobloxStudioBeta.exe in gated process ${pid} within ${execTimeoutMs} ms; ` +
      'the process was killed. ROBLOX_STUDIO_WINE_LAUNCHER must exec Wine so Studio keeps the launcher PID; ' +
      `if Wine is only slow to start, raise ${STUDIO_EXEC_TIMEOUT_ENV}.${logTail()}`,
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

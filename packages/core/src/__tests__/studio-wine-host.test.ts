import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import {
  listStudioProcesses,
  observeStudioProcesses,
  resolveStudioExe,
  StudioInstanceManager,
} from '../studio-instance-manager.js';
import * as studioPlatform from '../studio-platform.js';
import { fileTimeToUnixMs } from '../studio-sign-in.js';
import { defaultManagedInstanceRegistryDir, ManagedInstanceRegistry } from '../managed-instance-registry.js';
import {
  isWineStudioCommand,
  killOrphanedWineLaunchGate,
  listWineStudioProcesses,
  procStartTimeToFileTime,
  readWineProcessStartTime,
  spawnWineStudio,
  stopWineStudio,
  toWineWindowsPath,
  type WineStudioLaunchOptions,
  type WineStudioProcess,
} from '../studio-wine.js';

jest.mock('../studio-platform.js', () => ({
  ...jest.requireActual<typeof studioPlatform>('../studio-platform.js'),
  getStudioPlatformCapabilities: jest.fn(),
}));

// Real gated processes need Linux procfs and bash's `exec -a`.
const linuxTest = process.platform === 'linux' ? test : test.skip;
const BOOT_TIME = 1786570545n;
const NATIVE_LINUX_KERNEL = 'Linux version 6.8.0-generic';

function statLine(pid: number, comm: string, state: string, startTicks: number): string {
  // Fields 4-21 precede starttime (field 22).
  return `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 1000 100\n`;
}

function hasExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Real Wine-host children are reaped asynchronously by Node; the manager exposes
// no exit signal for them, so poll the kernel until the PID is gone.
async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function procState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch {
    return undefined;
  }
}

describe('Wine Studio process identity', () => {
  test('converts Linux start ticks to the Windows FILETIME of the process start', () => {
    expect(procStartTimeToFileTime(0n, 0n)).toBe('116444736000000000');
    expect(procStartTimeToFileTime(BOOT_TIME, 12345n)).toBe('134310442684500000');
    expect(fileTimeToUnixMs(procStartTimeToFileTime(BOOT_TIME, 12345n)))
      .toBe(Number(BOOT_TIME) * 1000 + 12345 * 10);
  });

  linuxTest('reads the FILETIME of a live process from /proc', () => {
    const startedAt = readWineProcessStartTime(process.pid);
    const expectedMs = Date.now() - process.uptime() * 1000;
    expect(Math.abs(fileTimeToUnixMs(startedAt!) - expectedMs)).toBeLessThan(2000);
  });

  test('converts absolute Unix paths to the Wine Z: drive', () => {
    expect(toWineWindowsPath('/home/user/My Places/place.rbxl')).toBe('Z:\\home\\user\\My Places\\place.rbxl');
  });

  test.each([
    ['C:\\Program Files (x86)\\Roblox\\Versions\\version-1\\RobloxStudioBeta.exe', true],
    ['/home/user/.wine/drive_c/Roblox/ROBLOXSTUDIOBETA.EXE', true],
    ['RobloxStudioBeta.exe', true],
    ['/usr/bin/sleep', false],
    ['C:\\Roblox\\RobloxStudioBeta.exe.bak', false],
    [undefined, false],
  ])('recognizes Studio command %p as %p', (argv0, expected) => {
    expect(isWineStudioCommand(argv0)).toBe(expected);
  });
});

describe('native Linux Studio executable resolution', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalExe = process.env.ROBLOX_STUDIO_EXE;
  let fixture: string;

  function useWineLauncher(wineLauncher?: string): void {
    jest.mocked(studioPlatform.getStudioPlatformCapabilities).mockReturnValue(
      studioPlatform.detectStudioPlatform({
        platform: 'linux',
        kernelVersion: NATIVE_LINUX_KERNEL,
        wineLauncher,
        wineLauncherExecutable: wineLauncher !== undefined,
      }),
    );
  }

  beforeEach(() => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-wine-exe-'));
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    useWineLauncher('/opt/studio/launch-studio');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    if (originalExe === undefined) delete process.env.ROBLOX_STUDIO_EXE;
    else process.env.ROBLOX_STUDIO_EXE = originalExe;
    rmSync(fixture, { recursive: true, force: true });
  });

  test('uses ROBLOX_STUDIO_EXE only when it names an existing file', () => {
    delete process.env.ROBLOX_STUDIO_EXE;
    expect(() => resolveStudioExe()).toThrow(/Set ROBLOX_STUDIO_EXE to RobloxStudioBeta\.exe inside your Wine prefix/);

    process.env.ROBLOX_STUDIO_EXE = path.join(fixture, 'missing', 'RobloxStudioBeta.exe');
    expect(() => resolveStudioExe()).toThrow(/does not name an existing file/);

    process.env.ROBLOX_STUDIO_EXE = fixture;
    expect(() => resolveStudioExe()).toThrow(/does not name an existing file/);

    const exe = path.join(fixture, 'RobloxStudioBeta.exe');
    writeFileSync(exe, '');
    process.env.ROBLOX_STUDIO_EXE = exe;
    expect(resolveStudioExe()).toBe(exe);
  });

  test('plain native Linux keeps the generic executable resolution', () => {
    useWineLauncher(undefined);
    delete process.env.ROBLOX_STUDIO_EXE;
    expect(() => resolveStudioExe()).toThrow(/auto-discovery is only supported on Windows, WSL, and macOS/);

    const exe = path.join(fixture, 'missing', 'studio');
    process.env.ROBLOX_STUDIO_EXE = exe;
    expect(resolveStudioExe()).toBe(exe);
  });
});

describe('Wine Studio /proc enumeration', () => {
  const OWN_UID = 1000;
  let procRoot: string;

  function addProcess(
    pid: number,
    cmdline: string[],
    comm: string,
    state: string,
    startTicks: number,
    uid = OWN_UID,
  ): void {
    mkdirSync(path.join(procRoot, String(pid)));
    writeFileSync(path.join(procRoot, String(pid), 'cmdline'), cmdline.map((arg) => `${arg}\0`).join(''));
    writeFileSync(path.join(procRoot, String(pid), 'stat'), statLine(pid, comm, state, startTicks));
    writeFileSync(path.join(procRoot, String(pid), 'status'), `Name:\t${comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  }

  function makeProcRoot(bootTime: bigint, bootId?: string): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-wine-proc-'));
    writeFileSync(path.join(root, 'stat'), `cpu  1 2 3 4\nbtime ${bootTime}\nprocesses 99\n`);
    if (bootId !== undefined) {
      mkdirSync(path.join(root, 'sys', 'kernel', 'random'), { recursive: true });
      writeFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), `${bootId}\n`);
    }
    mkdirSync(path.join(root, '7'));
    writeFileSync(path.join(root, '7', 'stat'), statLine(7, 'RobloxStudioBet', 'S', 4321));
    return root;
  }

  beforeEach(() => {
    procRoot = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-wine-proc-'));
    writeFileSync(path.join(procRoot, 'stat'), `cpu  1 2 3 4\nbtime ${BOOT_TIME}\nprocesses 99\n`);
    mkdirSync(path.join(procRoot, 'self'));
  });

  afterEach(() => {
    rmSync(procRoot, { recursive: true, force: true });
  });

  test('lists only live Wine Studio processes with their exact identity', () => {
    addProcess(100, ['/usr/bin/sleep', '30'], 'sleep', 'S', 500);
    addProcess(200, ['C:\\Program Files (x86)\\Roblox\\Versions\\version-1\\RobloxStudioBeta.exe', '--task', 'EditFile'], 'Roblox) (Studio', 'S', 12345);
    addProcess(300, ['/home/user/.wine/drive_c/Roblox/RobloxStudioBeta.exe'], 'RobloxStudioBet', 'T', 777);
    addProcess(400, ['C:\\Roblox\\RobloxStudioBeta.exe'], 'RobloxStudioBet', 'Z', 900);
    addProcess(500, ['C:\\Roblox\\RobloxStudioBeta.exe.bak'], 'RobloxStudioBet', 'S', 901);
    addProcess(600, [], 'kworker/0:1', 'I', 2);

    addProcess(700, ['C:\\Roblox\\RobloxStudioBeta.exe'], 'RobloxStudioBet', 'S', 902, OWN_UID + 1);

    const processes = listWineStudioProcesses(procRoot, OWN_UID).sort((a, b) => a.Id - b.Id);
    expect(processes).toEqual([
      {
        Id: 200,
        Name: 'RobloxStudioBeta',
        Path: 'C:\\Program Files (x86)\\Roblox\\Versions\\version-1\\RobloxStudioBeta.exe',
        MainWindowTitle: '',
        StartTimeUtcFileTime: procStartTimeToFileTime(BOOT_TIME, 12345n),
      },
      {
        Id: 300,
        Name: 'RobloxStudioBeta',
        Path: '/home/user/.wine/drive_c/Roblox/RobloxStudioBeta.exe',
        MainWindowTitle: '',
        StartTimeUtcFileTime: procStartTimeToFileTime(BOOT_TIME, 777n),
      },
    ]);
  });

  test('a missing /proc root is an enumeration failure, not an empty observation', () => {
    expect(() => listWineStudioProcesses(path.join(procRoot, 'missing'))).toThrow();
  });

  test('identities survive a broker restart after the clock was stepped', () => {
    const bootId = randomUUID();
    const roots = [makeProcRoot(BOOT_TIME, bootId), makeProcRoot(BOOT_TIME + 7n, bootId)];
    try {
      // Each proc root stands for a separate broker process reading /proc.
      const first = readWineProcessStartTime(7, roots[0]);
      expect(first).toBe(procStartTimeToFileTime(BOOT_TIME, 4321n));
      expect(readWineProcessStartTime(7, roots[1])).toBe(first);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  test('a new boot replaces the boot-time anchor of the previous boot', () => {
    const anchorDir = defaultManagedInstanceRegistryDir();
    const [oldBoot, newBoot] = [randomUUID(), randomUUID()];
    const roots = [makeProcRoot(BOOT_TIME, oldBoot), makeProcRoot(BOOT_TIME + 600n, newBoot)];
    try {
      readWineProcessStartTime(7, roots[0]);
      expect(readdirSync(anchorDir)).toContain(`wine-boot-time-${oldBoot}`);
      expect(readWineProcessStartTime(7, roots[1])).toBe(procStartTimeToFileTime(BOOT_TIME + 600n, 4321n));
      const anchors = readdirSync(anchorDir).filter((name) => name.startsWith('wine-boot-time-'));
      expect(anchors).toEqual([`wine-boot-time-${newBoot}`]);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  test('only a stopped process running the launch gate script is treated as an orphaned gate', () => {
    // Fixture PIDs must never be signalled; every case here is rejected first.
    const gate = ['/bin/sh', '-c', 'kill -STOP $$ && exec "$0" "$@"', '/opt/launcher', '/x/RobloxStudioBeta.exe'];
    addProcess(800, gate, 'sh', 'S', 1000);
    addProcess(801, ['/bin/sh', '-c', 'sleep 60'], 'sh', 'T', 1001);
    addProcess(802, gate, 'sh', 'T', 1002);
    expect(killOrphanedWineLaunchGate(800, procStartTimeToFileTime(BOOT_TIME, 1000n), procRoot)).toBe(false);
    expect(killOrphanedWineLaunchGate(801, procStartTimeToFileTime(BOOT_TIME, 1001n), procRoot)).toBe(false);
    expect(killOrphanedWineLaunchGate(802, procStartTimeToFileTime(BOOT_TIME, 1003n), procRoot)).toBe(false);
    expect(killOrphanedWineLaunchGate(803, procStartTimeToFileTime(BOOT_TIME, 1002n), procRoot)).toBe(false);
  });
});

describe('Wine Studio launcher', () => {
  let fixture: string;
  let exe: string;
  let argsFile: string;
  const owned: WineStudioProcess[] = [];

  function writeLauncher(body: string): string {
    const launcher = path.join(fixture, 'launcher.sh');
    writeFileSync(launcher, [
      '#!/usr/bin/env bash',
      `{ printf '%s\\n' "$@"; printf 'WINEPREFIX=%s\\n' "$WINEPREFIX"; } > ${JSON.stringify(argsFile)}`,
      body,
      '',
    ].join('\n'));
    chmodSync(launcher, 0o755);
    return launcher;
  }

  // Stands in for `exec wine <exe>`: the gated PID becomes a process whose
  // argv[0] is the Studio executable.
  function studioLauncher(): string {
    return writeLauncher(`exec -a "$1" ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 60000)'`);
  }

  async function spawnOwned(launcher: string, options: WineStudioLaunchOptions = {}): Promise<WineStudioProcess> {
    const proc = await spawnWineStudio(launcher, exe, ['--task', 'EditFile'], { cwd: fixture, env: process.env }, options);
    owned.push(proc);
    return proc;
  }

  beforeEach(() => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-wine-launch-'));
    exe = path.join(fixture, 'RobloxStudioBeta.exe');
    writeFileSync(exe, '');
    argsFile = path.join(fixture, 'launcher-args');
  });

  afterEach(async () => {
    delete process.env.ROBLOX_STUDIO_WINE_START_TIMEOUT_MS;
    for (const proc of owned.splice(0)) {
      if (!hasExited(proc.pid)) process.kill(proc.pid, 'SIGKILL');
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  linuxTest('gates the launcher until authorization, then resumes the same PID as Studio', async () => {
    const proc = await spawnOwned(studioLauncher());
    expect(proc.nativePid).toBe(proc.pid);
    expect(procState(proc.pid)).toBe('T');
    expect(proc.nativeStartedAt).toBe(readWineProcessStartTime(proc.pid));
    expect(existsSync(argsFile)).toBe(false);

    await proc.authorize();
    await proc.authorize();
    expect(procState(proc.pid)).not.toBe('T');
    expect(readFileSync(argsFile, 'utf8').split('\n').slice(0, 3)).toEqual([exe, '--task', 'EditFile']);
    expect(readFileSync(`/proc/${proc.pid}/cmdline`, 'utf8').split('\0')[0]).toBe(exe);
    expect(readWineProcessStartTime(proc.pid)).toBe(proc.nativeStartedAt);

    await proc.release();
    await expect(proc.authorize()).rejects.toThrow(/cannot be authorized from released/);
  });

  linuxTest('authorization fails closed when the launcher does not exec Studio', async () => {
    const proc = await spawnOwned(writeLauncher('exec sleep 60'), { studioExecTimeoutMs: 500 });
    const exited = new Promise((resolve) => proc.onExit(resolve));
    await expect(proc.authorize()).rejects.toThrow(/did not exec RobloxStudioBeta\.exe.*was killed/);
    await exited;
    expect(hasExited(proc.pid)).toBe(true);
    await expect(proc.release()).rejects.toThrow(/cannot be released from aborted/);
  });

  linuxTest('ROBLOX_STUDIO_WINE_START_TIMEOUT_MS bounds the wait for Studio', async () => {
    process.env.ROBLOX_STUDIO_WINE_START_TIMEOUT_MS = '300';
    const proc = await spawnOwned(writeLauncher('exec sleep 60'));
    await expect(proc.authorize()).rejects.toThrow(/within 300 ms.*raise ROBLOX_STUDIO_WINE_START_TIMEOUT_MS/s);
  });

  test.each(['0', '-5', '1.5', 'soon', '150001'])('rejects ROBLOX_STUDIO_WINE_START_TIMEOUT_MS=%p before spawning', async (value) => {
    process.env.ROBLOX_STUDIO_WINE_START_TIMEOUT_MS = value;
    await expect(spawnWineStudio('/nonexistent/launcher', exe, [], { cwd: fixture, env: process.env }))
      .rejects.toThrow(/ROBLOX_STUDIO_WINE_START_TIMEOUT_MS must be a whole number/);
  });

  linuxTest('a failed launch reports the launcher output from its log', async () => {
    const logDir = path.join(fixture, 'logs');
    const proc = await spawnOwned(
      writeLauncher(`echo 'wine: could not load kernel32.dll' >&2; exit 3`),
      { logDir },
    );
    await expect(proc.authorize()).rejects.toThrow(
      /exited \(code 3\) before RobloxStudioBeta\.exe started\. Launcher output \(.*\):\nwine: could not load kernel32\.dll/,
    );
    const logs = readdirSync(logDir);
    expect(logs).toHaveLength(1);
    expect(readFileSync(path.join(logDir, logs[0]), 'utf8')).toContain('could not load kernel32.dll');
  });

  linuxTest('keeps only the newest launcher logs', async () => {
    const logDir = path.join(fixture, 'logs');
    mkdirSync(logDir);
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(path.join(logDir, `2000-01-01T00-00-${String(index).padStart(2, '0')}-000Z-old.log`), '');
    }
    const proc = await spawnOwned(studioLauncher(), { logDir });
    await proc.abort();
    const logs = readdirSync(logDir).sort();
    expect(logs).toHaveLength(10);
    expect(logs[0]).toBe('2000-01-01T00-00-03-000Z-old.log');
    expect(logs[9]).not.toMatch(/^2000-/u);
  });

  linuxTest('kills only the exact stopped launch gate', async () => {
    const proc = await spawnOwned(studioLauncher());
    const exited = new Promise((resolve) => proc.onExit(resolve));
    const otherStart = (BigInt(proc.nativeStartedAt) + 10000000n).toString();
    expect(killOrphanedWineLaunchGate(proc.pid, otherStart)).toBe(false);
    expect(procState(proc.pid)).toBe('T');
    expect(killOrphanedWineLaunchGate(proc.pid, proc.nativeStartedAt)).toBe(true);
    await exited;
    expect(existsSync(argsFile)).toBe(false);
  });

  linuxTest('abort kills the stopped process before the launcher runs', async () => {
    const proc = await spawnOwned(studioLauncher());
    expect(procState(proc.pid)).toBe('T');
    await proc.abort();
    expect(hasExited(proc.pid)).toBe(true);
    expect(existsSync(argsFile)).toBe(false);
    await expect(proc.authorize()).rejects.toThrow(/cannot be authorized from aborted/);
  });

  linuxTest('stop signals only the exact PID and start time', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      const pid = child.pid!;
      const startedAt = readWineProcessStartTime(pid)!;
      await stopWineStudio(pid, (BigInt(startedAt) + 10000000n).toString(), 1000);
      expect(hasExited(pid)).toBe(false);
      await stopWineStudio(pid, startedAt, 1000);
      await exited;
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('Wine host managed Studio lifecycle', () => {
  let fixture: string;
  let launcher: string;
  let exe: string;
  let placeFile: string;
  let argsFile: string;
  const managers: StudioInstanceManager[] = [];

  function useCapabilities(capabilities: studioPlatform.StudioPlatformCapabilities): void {
    jest.mocked(studioPlatform.getStudioPlatformCapabilities).mockReturnValue(capabilities);
  }

  function manager(): StudioInstanceManager {
    const created = new StudioInstanceManager({
      registryDir: path.join(fixture, 'registry'),
      processAdapter: { currentBootId: () => 'wine-boot' },
    });
    managers.push(created);
    return created;
  }

  beforeEach(() => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-wine-managed-'));
    exe = path.join(fixture, 'RobloxStudioBeta.exe');
    placeFile = path.join(fixture, 'My Place.rbxl');
    argsFile = path.join(fixture, 'launcher-args');
    launcher = path.join(fixture, 'launcher.sh');
    writeFileSync(exe, '');
    writeFileSync(placeFile, '');
    writeFileSync(launcher, [
      '#!/usr/bin/env bash',
      `{ printf '%s\\n' "$@"; printf 'WINEPREFIX=%s\\n' "$WINEPREFIX"; } > ${JSON.stringify(argsFile)}`,
      `exec -a "$1" ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 60000)'`,
      '',
    ].join('\n'));
    chmodSync(launcher, 0o755);
    useCapabilities(studioPlatform.detectStudioPlatform({
      platform: 'linux',
      kernelVersion: NATIVE_LINUX_KERNEL,
      wineLauncher: launcher,
      wineLauncherExecutable: true,
    }));
  });

  afterEach(async () => {
    for (const created of managers.splice(0)) {
      for (const record of await created.list()) {
        const pid = record.nativeProcessId;
        if (pid && !hasExited(pid)) process.kill(pid, 'SIGKILL');
      }
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  linuxTest('plain native Linux observes no Studio processes', async () => {
    useCapabilities(studioPlatform.detectStudioPlatform({ platform: 'linux', kernelVersion: NATIVE_LINUX_KERNEL }));
    expect(listStudioProcesses()).toEqual([]);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: [] });
  });

  linuxTest('launches, authorizes, releases, observes, and closes the exact Wine Studio process', async () => {
    const studio = manager();
    expect(studio.getLifecycleCapabilities()).toEqual({
      hostPlatform: 'linux',
      windowsInteropAvailable: false,
      processIdentity: { supported: true, launcher: 'wine-retained' },
    });

    const record = await studio.launch({
      source: 'local_file',
      localPlaceFile: placeFile,
      studioExecutable: exe,
      requireProcessIdentity: true,
      processEnvironment: { set: { WINEPREFIX: path.join(fixture, 'prefix') } },
    });
    const pid = record.nativeProcessId!;
    expect(record.spawnPid).toBe(pid);
    expect(record.processAuthorizationState).toBe('pending');
    expect(record.nativeProcessStartedAt).toBe(readWineProcessStartTime(pid));
    expect(record.args).toEqual(['--task', 'EditFile', '--localPlaceFile', toWineWindowsPath(placeFile)]);
    expect(procState(pid)).toBe('T');
    expect(existsSync(argsFile)).toBe(false);

    await studio.authorizeByLaunchId(record.recordId!);
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      exe,
      '--task',
      'EditFile',
      '--localPlaceFile',
      `Z:${placeFile.replace(/\//g, '\\')}`,
      `WINEPREFIX=${path.join(fixture, 'prefix')}`,
    ]);
    await studio.completeByLaunchId(record.recordId!);

    const observed = await observeStudioProcesses();
    expect(observed.status === 'ok' && observed.processes.find((candidate) => candidate.Id === pid)).toEqual({
      Id: pid,
      Name: 'RobloxStudioBeta',
      Path: exe,
      MainWindowTitle: '',
      StartTimeUtcFileTime: record.nativeProcessStartedAt,
    });
    await expect(studio.getByLaunchId(record.recordId!)).resolves.toMatchObject({
      processAuthorizationState: 'released',
      processObservationStatus: 'running',
    });

    await expect(studio.closeByLaunchId(record.recordId!)).resolves.toMatchObject({ status: 'closed' });
    await waitUntil(() => hasExited(pid));
    await expect(studio.closeByLaunchId(record.recordId!)).resolves.toMatchObject({ status: 'already_closed' });
  });

  linuxTest('a later broker kills the launch gate of a broker that died before authorizing', async () => {
    // Launch controls are shared within a process, so the dead broker's launch
    // is a gate spawned outside any manager plus its persisted record.
    const gate = await spawnWineStudio(launcher, exe, [], { cwd: fixture, env: process.env });
    const exited = new Promise((resolve) => gate.onExit(resolve));
    try {
      await persistOrphanedLaunch(gate);
      await manager().list();
      await exited;
      expect(existsSync(argsFile)).toBe(false);
    } finally {
      if (!hasExited(gate.pid)) process.kill(gate.pid, 'SIGKILL');
    }
  });

  async function persistOrphanedLaunch(gate: WineStudioProcess): Promise<void> {
    const deadBroker = spawn('true');
    await new Promise((resolve) => deadBroker.once('exit', resolve));
    await new ManagedInstanceRegistry(path.join(fixture, 'registry')).upsert({
      version: 1,
      recordId: randomUUID(),
      source: 'local_file',
      nativeProcessId: gate.pid,
      nativeProcessStartedAt: gate.nativeStartedAt,
      spawnPid: gate.pid,
      exe,
      args: [],
      launchedAt: Date.now(),
      state: 'launching',
      ownerPid: deadBroker.pid,
      bootId: 'wine-boot',
      processAuthorizationState: 'pending',
    });
  }

  linuxTest('closing a Wine Studio process that already exited reports it as not running', async () => {
    const studio = manager();
    const record = await studio.launch({
      source: 'local_file',
      localPlaceFile: placeFile,
      studioExecutable: exe,
      requireProcessIdentity: true,
    });
    await studio.authorizeByLaunchId(record.recordId!);
    await studio.completeByLaunchId(record.recordId!);
    process.kill(record.nativeProcessId!, 'SIGKILL');
    await waitUntil(() => hasExited(record.nativeProcessId!));

    await expect(studio.closeByLaunchId(record.recordId!)).resolves.toMatchObject({ status: 'already_closed' });
  });
});

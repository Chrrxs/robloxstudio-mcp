import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import {
  isWineStudioCommand,
  listWineStudioProcesses,
  procStartTimeToFileTime,
  readWineProcessStartTime,
  spawnWineStudio,
  stopWineStudio,
  toWineWindowsPath,
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

  beforeEach(() => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-wine-exe-'));
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
    jest.mocked(studioPlatform.getStudioPlatformCapabilities).mockReturnValue(
      studioPlatform.detectStudioPlatform({ platform: 'linux', kernelVersion: NATIVE_LINUX_KERNEL }),
    );
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
});

describe('Wine Studio /proc enumeration', () => {
  let procRoot: string;

  function addProcess(pid: number, cmdline: string[], comm: string, state: string, startTicks: number): void {
    mkdirSync(path.join(procRoot, String(pid)));
    writeFileSync(path.join(procRoot, String(pid), 'cmdline'), cmdline.map((arg) => `${arg}\0`).join(''));
    writeFileSync(path.join(procRoot, String(pid), 'stat'), statLine(pid, comm, state, startTicks));
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

    const processes = listWineStudioProcesses(procRoot).sort((a, b) => a.Id - b.Id);
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

  async function spawnOwned(launcher: string, options: Parameters<typeof spawnWineStudio>[4] = {}): Promise<WineStudioProcess> {
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

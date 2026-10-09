import * as childProcess from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  listStudioProcesses,
  observeStudioProcesses,
  StudioInstanceManager,
  type ManagedStudioInstance,
} from '../studio-instance-manager.js';

const mockExecFileSync = jest.fn<string, [string, string[], object]>();
const mockExecFileAsync = jest.fn<Promise<{ stdout: string; stderr: string }>, [string, string[], object]>();

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof childProcess>('child_process');
  return {
    ...actual,
    execFileSync: (command: string, args: string[], options: object) => mockExecFileSync(command, args, options),
    execFile: Object.assign(
      () => { throw new Error('Use the promisified command runner'); },
      { [Symbol.for('nodejs.util.promisify.custom')]: (command: string, args: string[], options: object) => mockExecFileAsync(command, args, options) },
    ),
  };
});

const actualChildProcess = jest.requireActual<typeof childProcess>('child_process');
const actualExecFileAsync = promisify(actualChildProcess.execFile);
const windowsPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const powershellExecutable = process.platform === 'win32' ? 'powershell.exe' : windowsPowerShell;
const nativeTest = process.platform === 'win32' || existsSync(windowsPowerShell) ? test : test.skip;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const processInfo = {
  Id: 4242,
  Name: 'RobloxStudioBeta',
  Path: 'C:\\RobloxStudioBeta.exe',
  MainWindowTitle: 'Studio',
  StartTimeUtcFileTime: '133700123459000000',
};

function returnOutput(stdout: string): void {
  mockExecFileSync.mockReturnValue(stdout);
  mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' });
}

// Real PowerShell is reached through WSL interop (or a Windows runner) and can
// fail for reasons outside the code under test. Native tests record every call
// so a failure shows what PowerShell actually did, not only the wrapped error.
interface PowerShellCall {
  path: 'sync' | 'async';
  elapsedMs: number;
  outcome: string;
  stdout: string;
  stderr: string;
}

const powerShellCalls: PowerShellCall[] = [];

function outputText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function failedAsyncCall(error: unknown): Omit<PowerShellCall, 'path' | 'elapsedMs'> {
  if (!(error instanceof Error)) return { outcome: `threw ${String(error)}`, stdout: '', stderr: '' };
  const field = (key: string): string => outputText(Reflect.get(error, key));
  return {
    outcome: `failed (code ${field('code') || '-'}, signal ${field('signal') || '-'}, killed ${field('killed') || '-'}): ` +
      error.message.split('\n')[0],
    stdout: field('stdout'),
    stderr: field('stderr'),
  };
}

function describePowerShellCalls(): string {
  const header = `PowerShell calls during this test (${powershellExecutable}, cwd ${process.cwd()}):`;
  if (powerShellCalls.length === 0) return `${header}\n  none`;
  return [header, ...powerShellCalls.map((call, index) => [
    `  #${index + 1} ${call.path}: ${call.outcome} after ${call.elapsedMs} ms`,
    `     stdout: ${JSON.stringify(call.stdout.slice(0, 2000))}`,
    `     stderr: ${JSON.stringify(call.stderr.slice(0, 2000))}`,
  ].join('\n'))].join('\n');
}

function withPowerShellDiagnostics<Args extends unknown[]>(
  body: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    powerShellCalls.length = 0;
    try {
      await body(...args);
    } catch (error) {
      if (error instanceof Error) error.message += `\n\n${describePowerShellCalls()}`;
      throw error;
    }
  };
}

// Execute the production query in real Windows PowerShell, replacing only its OS
// process source. The missing-name branch uses the actual Get-Process error.
function usePowerShellProcessSource(body: string): void {
  const prelude = `function Get-Process { [CmdletBinding()] param([string[]]$Name) ${body} }; `;
  const withPrelude = (args: string[]) => [...args.slice(0, -1), prelude + args[args.length - 1]];
  mockExecFileSync.mockImplementation((_command, args) => {
    const startedAt = Date.now();
    // spawnSync, unlike execFileSync, keeps stderr from a successful run too.
    const result = actualChildProcess.spawnSync(powershellExecutable, withPrelude(args), { encoding: 'utf8', timeout: 15000 });
    powerShellCalls.push({
      path: 'sync',
      elapsedMs: Date.now() - startedAt,
      outcome: result.error
        ? `failed to run: ${result.error.message}`
        : result.status === 0 ? 'exited 0' : `exited ${result.status ?? '-'} (signal ${result.signal ?? '-'})`,
      stdout: outputText(result.stdout),
      stderr: outputText(result.stderr),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw Object.assign(new Error(`Command failed: ${powershellExecutable}\n${outputText(result.stderr)}`), {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return result.stdout;
  });
  mockExecFileAsync.mockImplementation(async (_command, args) => {
    const startedAt = Date.now();
    try {
      const output = await actualExecFileAsync(powershellExecutable, withPrelude(args), { encoding: 'utf8', timeout: 15000 });
      powerShellCalls.push({ path: 'async', elapsedMs: Date.now() - startedAt, outcome: 'exited 0', ...output });
      return output;
    } catch (error) {
      powerShellCalls.push({ path: 'async', elapsedMs: Date.now() - startedAt, ...failedAsyncCall(error) });
      throw error;
    }
  });
}

describe('native Studio process enumeration', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    mockExecFileSync.mockReset();
    mockExecFileAsync.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  });

  nativeTest('a missing Studio process is a successful empty observation in both native paths', withPowerShellDiagnostics(async () => {
    usePowerShellProcessSource([
      "$PSBoundParameters['Name'] = 'RsmcpAbsent' + [guid]::NewGuid().ToString('N')",
      'Microsoft.PowerShell.Management\\Get-Process @PSBoundParameters',
    ].join('; '));
    expect(listStudioProcesses()).toEqual([]);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: [] });
  }));

  nativeTest.each([1, 2])('enumerates %i Studio processes through both native paths', withPowerShellDiagnostics(async (count: number) => {
    usePowerShellProcessSource(`foreach ($idValue in 4242..${4241 + count}) { [PSCustomObject]@{
      Id = $idValue; Name = 'RobloxStudioBeta'; Path = 'C:\\RobloxStudioBeta.exe';
      MainWindowTitle = 'Studio'; StartTime = [datetime]::FromFileTimeUtc(133700123459000000)
    } }`);
    const expected = count === 1 ? [processInfo] : [processInfo, { ...processInfo, Id: 4243 }];
    expect(listStudioProcesses()).toEqual(expected);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: expected });
  }));

  nativeTest('PowerShell permission failures are not swallowed as missing processes', withPowerShellDiagnostics(async () => {
    usePowerShellProcessSource("Write-Error -Message 'Access denied' -Category PermissionDenied -ErrorId 'PermissionDenied'");
    expect(() => listStudioProcesses()).toThrow();
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'error' });
  }));

  test('a valid empty JSON array confirms process absence', async () => {
    returnOutput('[]');
    expect(listStudioProcesses()).toEqual([]);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: [] });
  });

  test.each([
    { label: 'one process object', output: JSON.stringify(processInfo), expected: [processInfo] },
    { label: 'multiple process array', output: JSON.stringify([processInfo, { ...processInfo, Id: 4243 }]), expected: [processInfo, { ...processInfo, Id: 4243 }] },
  ])('accepts $label from PowerShell', async ({ output, expected }) => {
    returnOutput(output);
    expect(listStudioProcesses()).toEqual(expected);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: expected });
  });

  // Windows reports Path = $null for a process created suspended (a launch
  // awaiting authorization): its loader has not mapped the main module yet.
  nativeTest('a Studio process without a readable image path enumerates through both native paths', withPowerShellDiagnostics(async () => {
    usePowerShellProcessSource(`[PSCustomObject]@{
      Id = 4242; Name = 'RobloxStudioBeta'; Path = $null;
      MainWindowTitle = ''; StartTime = [datetime]::FromFileTimeUtc(133700123459000000)
    }`);
    const expected = [{ Id: 4242, Name: 'RobloxStudioBeta', MainWindowTitle: '', StartTimeUtcFileTime: '133700123459000000' }];
    expect(listStudioProcesses()).toEqual(expected);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: expected });
  }));

  test('a suspended launch without a readable image path stays observed as running', async () => {
    returnOutput(JSON.stringify([{ ...processInfo, Path: null, MainWindowTitle: '' }]));
    const registryDir = mkdtempSync(path.join(os.tmpdir(), 'studio-observation-'));
    try {
      const manager = new StudioInstanceManager({
        registryDir,
        processAdapter: { currentBootId: () => 'boot-1' },
      });
      const record: ManagedStudioInstance = {
        recordId: 'suspended-launch',
        source: 'local_file',
        nativeProcessId: 4242,
        nativeProcessStartedAt: processInfo.StartTimeUtcFileTime,
        spawnPid: 4242,
        exe: processInfo.Path,
        args: [],
        launchedAt: 1,
        state: 'launching',
        ownerPid: process.pid,
        bootId: 'boot-1',
        processAuthorizationState: 'pending',
      };
      await manager.refresh(record);
      expect(record).toMatchObject({ state: 'launching', processObservationStatus: 'running' });
      expect(record.lastProcessObservationError).toBeUndefined();
    } finally {
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['execution failure', undefined],
    ['empty output', ''],
    ['invalid JSON', '{'],
    ['null JSON', 'null'],
    ['missing process identity', '[{}]'],
    ['invalid process id', JSON.stringify([{ ...processInfo, Id: '4242' }])],
    ['inaccessible start time', JSON.stringify([{ ...processInfo, StartTimeUtcFileTime: null }])],
  ])('%s stays unknown and never closes managed Studio ownership', async (_label, output) => {
    if (output === undefined) {
      const failure = Object.assign(new Error('Access denied'), { code: 1 });
      mockExecFileSync.mockImplementation(() => { throw failure; });
      mockExecFileAsync.mockRejectedValue(failure);
    } else {
      returnOutput(output);
    }
    expect(() => listStudioProcesses()).toThrow();
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'error' });

    const registryDir = mkdtempSync(path.join(os.tmpdir(), 'studio-observation-'));
    try {
      const manager = new StudioInstanceManager({
        registryDir,
        processAdapter: { currentBootId: () => 'boot-1' },
        confirmedExitMisses: 1,
        confirmedExitGraceMs: 0,
      });
      const record: ManagedStudioInstance = {
        recordId: 'native-observation',
        instanceId: 'studio:4242',
        source: 'local_file',
        nativeProcessId: 4242,
        nativeProcessStartedAt: processInfo.StartTimeUtcFileTime,
        exe: processInfo.Path,
        args: [],
        launchedAt: 1,
        state: 'connected',
        ownerPid: process.pid,
        bootId: 'boot-1',
        processAuthorizationState: 'released',
      };
      await manager.refresh(record);
      await manager.refresh(record);
      expect(record).toMatchObject({
        state: 'connected',
        processObservationStatus: 'unknown',
        consecutiveConfirmedMisses: 0,
      });
      expect(record.closedAt).toBeUndefined();
      await expect(manager.getByLaunchId('native-observation')).resolves.toMatchObject({
        state: 'connected',
        processObservationStatus: 'unknown',
      });
    } finally {
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});

describe('native macOS close verification', () => {
  let registryDir: string;
  let manager: StudioInstanceManager;
  let record: ManagedStudioInstance;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' });
    mockExecFileSync.mockReset();
    mockExecFileAsync.mockReset();
    returnOutput('4242 /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio');
    registryDir = mkdtempSync(path.join(os.tmpdir(), 'studio-macos-close-'));
    manager = new StudioInstanceManager({
      registryDir,
      processAdapter: { currentBootId: () => 'macos-close-test' },
      closeTimeoutMs: 1000,
    });
    record = {
      recordId: 'macos-close-test',
      bootId: 'macos-close-test',
      nativeProcessId: 4242,
      spawnPid: 4242,
      source: 'local_file',
      exe: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
      args: [],
      launchedAt: Date.now(),
      state: 'connected',
      processAuthorizationState: 'released',
      processObservationStatus: 'running',
    };
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    rmSync(registryDir, { recursive: true, force: true });
  });

  test('SIGTERM success is not exit proof; probe the PID and never escalate to SIGKILL', async () => {
    const signalled = Promise.withResolvers<void>();
    const kill = jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(4242);
      if (signal === 'SIGTERM') signalled.resolve();
      return true;
    });
    const outcome = manager.close(record).catch((error: unknown) => error);
    await signalled.promise;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/still running/) }));
    expect(kill).toHaveBeenCalledWith(4242, 0);
    expect(kill).not.toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(record.closedAt).toBeUndefined();
  });

  test.each(['ESRCH', 'EPERM'])('PID probe %s distinguishes exit from an unverifiable process', async (code) => {
    jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error(code), { code });
      return true;
    });
    if (code === 'ESRCH') {
      await expect(manager.close(record)).resolves.toMatchObject({ status: 'closed' });
      expect(record.state).toBe('exited');
    } else {
      await expect(manager.close(record)).rejects.toThrow(/EPERM/);
      expect(record.closedAt).toBeUndefined();
      expect(record.processObservationStatus).toBe('unknown');
    }
  });

  test('absence from name-filtered enumeration is not proof that a retained PID exited', async () => {
    returnOutput('');
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    await expect(manager.close(record)).rejects.toThrow(/still alive/);
    expect(record.closedAt).toBeUndefined();
    expect(record.processObservationStatus).toBe('unknown');
    expect(kill).toHaveBeenCalledWith(4242, 0);
    expect(kill).not.toHaveBeenCalledWith(4242, 'SIGTERM');
  });
});

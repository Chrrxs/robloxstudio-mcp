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

// Execute the production query in real Windows PowerShell, replacing only its OS
// process source. The missing-name branch uses the actual Get-Process error.
function usePowerShellProcessSource(body: string): void {
  const prelude = `function Get-Process { [CmdletBinding()] param([string[]]$Name) ${body} }; `;
  mockExecFileSync.mockImplementation((_command, args) => actualChildProcess.execFileSync(
    powershellExecutable,
    [...args.slice(0, -1), prelude + args[args.length - 1]],
    { encoding: 'utf8', timeout: 15000 },
  ));
  mockExecFileAsync.mockImplementation((_command, args) => actualExecFileAsync(
    powershellExecutable,
    [...args.slice(0, -1), prelude + args[args.length - 1]],
    { encoding: 'utf8', timeout: 15000 },
  ));
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

  nativeTest('a missing Studio process is a successful empty observation in both native paths', async () => {
    usePowerShellProcessSource([
      "$PSBoundParameters['Name'] = 'RsmcpAbsent' + [guid]::NewGuid().ToString('N')",
      'Microsoft.PowerShell.Management\\Get-Process @PSBoundParameters',
    ].join('; '));
    expect(listStudioProcesses()).toEqual([]);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: [] });
  });

  nativeTest.each([1, 2])('enumerates %i Studio processes through both native paths', async (count) => {
    usePowerShellProcessSource(`foreach ($idValue in 4242..${4241 + count}) { [PSCustomObject]@{
      Id = $idValue; Name = 'RobloxStudioBeta'; Path = 'C:\\RobloxStudioBeta.exe';
      MainWindowTitle = 'Studio'; StartTime = [datetime]::FromFileTimeUtc(133700123459000000)
    } }`);
    const expected = count === 1 ? [processInfo] : [processInfo, { ...processInfo, Id: 4243 }];
    expect(listStudioProcesses()).toEqual(expected);
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'ok', processes: expected });
  });

  nativeTest('PowerShell permission failures are not swallowed as missing processes', async () => {
    usePowerShellProcessSource("Write-Error -Message 'Access denied' -Category PermissionDenied -ErrorId 'PermissionDenied'");
    expect(() => listStudioProcesses()).toThrow();
    await expect(observeStudioProcesses()).resolves.toMatchObject({ status: 'error' });
  });

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

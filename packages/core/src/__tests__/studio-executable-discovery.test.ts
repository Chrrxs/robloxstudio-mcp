import * as childProcess from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStudioExe, StudioInstanceManager } from '../studio-instance-manager.js';
import * as studioPlatform from '../studio-platform.js';

const mockExecFileSync = jest.fn<string, [string, string[], object]>();
const mockExecFileAsync = jest.fn<Promise<{ stdout: string; stderr: string }>, [string, string[], object]>();

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof childProcess>('child_process');
  return {
    ...actual,
    spawn: jest.fn(() => { throw new Error('Unexpected native process launch'); }),
    execFileSync: (command: string, args: string[], options: object) => mockExecFileSync(command, args, options),
    execFile: Object.assign(
      () => { throw new Error('Use the promisified command runner'); },
      { [Symbol.for('nodejs.util.promisify.custom')]: (command: string, args: string[], options: object) => mockExecFileAsync(command, args, options) },
    ),
  };
});

jest.mock('../studio-platform.js', () => ({
  ...jest.requireActual<typeof studioPlatform>('../studio-platform.js'),
  getStudioPlatformCapabilities: jest.fn(),
}));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const incompleteMessage = /installation\/update is incomplete.*Complete the installation\/update or reinstall Roblox Studio under the owning Windows account/s;

type InstallationState = 'complete' | 'download' | 'missing-settings' | 'empty-settings' | 'directory-settings';

describe.each(['windows', 'wsl'] as const)('%s automatic Studio executable discovery', (host) => {
  let fixture: string;
  let originalLocalAppData: string | undefined;
  let originalExe: string | undefined;
  const windowsStudioLauncher = jest.fn(() => { throw new Error('Reached native launch boundary'); });

  function install(version: string, mtime: number, state: InstallationState): string {
    const folder = path.join(fixture, 'Roblox', 'Versions', `version-${version}`);
    mkdirSync(folder, { recursive: true });
    const exe = path.join(folder, 'RobloxStudioBeta.exe');
    writeFileSync(exe, 'offline executable fixture');
    utimesSync(exe, mtime, mtime);
    const settings = path.join(folder, 'AppSettings.xml');
    if (state === 'directory-settings') mkdirSync(settings);
    else if (state !== 'missing-settings') writeFileSync(settings, state === 'empty-settings' ? '' : '<Settings />');
    if (state === 'download') writeFileSync(path.join(folder, 'content.zip.crdownload'), 'partial download');
    return exe;
  }

  function manager(): StudioInstanceManager {
    return new StudioInstanceManager({
      registryDir: path.join(fixture, 'registry'),
      processAdapter: {
        currentBootId: () => 'test-boot',
        observeStudioProcesses: () => ({ status: 'ok', observedAt: Date.now(), processes: [] }),
      },
      windowsStudioLauncher,
    });
  }

  beforeEach(() => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'studio-executable-discovery-'));
    originalLocalAppData = process.env.LOCALAPPDATA;
    originalExe = process.env.ROBLOX_STUDIO_EXE;
    process.env.LOCALAPPDATA = fixture;
    delete process.env.ROBLOX_STUDIO_EXE;
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: host === 'windows' ? 'win32' : 'linux' });
    jest.mocked(studioPlatform.getStudioPlatformCapabilities).mockReturnValue(studioPlatform.detectStudioPlatform({
      platform: host === 'windows' ? 'win32' : 'linux',
      kernelVersion: host === 'wsl' ? 'microsoft-standard-WSL2' : undefined,
      windowsInteropAvailable: true,
    }));
    windowsStudioLauncher.mockClear();
    jest.mocked(childProcess.spawn).mockClear();
    mockExecFileSync.mockReset();
    mockExecFileAsync.mockReset();
    const commandOutput = (command: string, args: string[]): string => {
      if (host === 'wsl' && command === 'cmd.exe') return 'C:\\Users\\StudioOwner\\AppData\\Local';
      if (host === 'wsl' && command === 'wslpath' && args[0] === '-u') return fixture;
      throw new Error(`Unexpected native command: ${command}`);
    };
    mockExecFileSync.mockImplementation(commandOutput);
    mockExecFileAsync.mockImplementation(async (command, args) => ({ stdout: commandOutput(command, args), stderr: '' }));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalExe === undefined) delete process.env.ROBLOX_STUDIO_EXE;
    else process.env.ROBLOX_STUDIO_EXE = originalExe;
    rmSync(fixture, { recursive: true, force: true });
  });

  test('selects the newest executable by mtime and ignores an older interrupted installation', async () => {
    install('z-older', 1000, 'download');
    const newest = install('a-newer', 2000, 'complete');
    expect(resolveStudioExe()).toBe(newest);
    await expect(manager().launch({ source: 'published_place', placeId: 1, universeId: 2 })).rejects.toThrow('Reached native launch boundary');
    expect(windowsStudioLauncher).toHaveBeenCalledWith(newest, ['--task', 'EditPlace', '--placeId', '1', '--universeId', '2'], undefined, undefined);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test.each<InstallationState>(['download', 'missing-settings', 'empty-settings', 'directory-settings'])(
    'rejects newest %s installation before launch without falling back to older complete Studio',
    async (state) => {
      install('older-complete', 1000, 'complete');
      const newest = install('newer-incomplete', 2000, state);
      expect(() => resolveStudioExe()).toThrow(incompleteMessage);
      expect(() => resolveStudioExe()).toThrow(path.dirname(newest));
      await expect(manager().launch({ source: 'published_place', placeId: 1, universeId: 2 })).rejects.toThrow(incompleteMessage);
      expect(windowsStudioLauncher).not.toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
    },
  );

  test('explicit executable overrides retain their behavior for incomplete installations', async () => {
    const exactExe = install('explicit', 2000, 'missing-settings');
    process.env.ROBLOX_STUDIO_EXE = exactExe;
    expect(resolveStudioExe()).toBe(exactExe);
    await expect(manager().launch({ source: 'published_place', placeId: 1, universeId: 2 })).rejects.toThrow('Reached native launch boundary');
    delete process.env.ROBLOX_STUDIO_EXE;
    await expect(manager().launch({ source: 'published_place', placeId: 1, universeId: 2, studioExecutable: exactExe })).rejects.toThrow('Reached native launch boundary');
    expect(windowsStudioLauncher).toHaveBeenCalledTimes(2);
  });
});

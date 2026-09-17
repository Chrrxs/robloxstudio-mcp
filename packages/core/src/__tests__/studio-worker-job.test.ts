import { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { detectStudioPlatform } from '../studio-platform.js';

const mockNativeLaunch = jest.fn<ChildProcess, []>(() => {
  const child = new ChildProcess();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stderr = child.stderr;
  void Promise.resolve().then(() => {
    stderr.emit('data', Buffer.from('Open test worker job failed: named job does not exist'));
    child.emit('exit', 1, null);
  });
  return child;
});

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: () => mockNativeLaunch(),
}));

describe('retained Windows test-worker ownership at the compiled launch adapter', () => {
  let root: string;
  let previousName: string | undefined;
  beforeEach(() => {
    jest.useFakeTimers();
    root = mkdtempSync(path.join(os.tmpdir(), 'studio-worker-core-'));
    previousName = process.env.RSMCP_STUDIO_TEST_WORKER_JOB;
    mockNativeLaunch.mockClear();
  });
  afterEach(() => {
    if (previousName === undefined) delete process.env.RSMCP_STUDIO_TEST_WORKER_JOB;
    else process.env.RSMCP_STUDIO_TEST_WORKER_JOB = previousName;
    rmSync(root, { recursive: true, force: true });
    jest.useRealTimers();
  });
  function manager() {
    return new StudioInstanceManager({
      registryDir: root,
      platformCapabilities: detectStudioPlatform({ platform: 'win32' }),
      processAdapter: {
        currentBootId: () => 'worker-fixture-boot',
        observeStudioProcesses: () => ({ status: 'ok', observedAt: Date.now(), processes: [] }),
      },
    });
  }
  const launch = { source: 'published_place' as const, placeId: 1, universeId: 2, studioExecutable: 'C:\\fixture\\Node.exe', requireProcessIdentity: true };

  test('malformed worker capability rejects before creating a native process', async () => {
    process.env.RSMCP_STUDIO_TEST_WORKER_JOB = 'Local\\RsmcpStudioWorker-not-a-capability; Write-Output unsafe';
    await expect(manager().launch(launch)).rejects.toThrow('Invalid Studio test worker job name');
    expect(mockNativeLaunch).not.toHaveBeenCalled();
  });

  test('a missing worker job is fatal, never retried as an unowned launch', async () => {
    process.env.RSMCP_STUDIO_TEST_WORKER_JOB = 'Local\\RsmcpStudioWorker-0123456789abcdef0123456789abcdef';
    await expect(manager().launch(launch)).rejects.toThrow('Open test worker job failed');
    expect(mockNativeLaunch).toHaveBeenCalledTimes(1);
  });
});

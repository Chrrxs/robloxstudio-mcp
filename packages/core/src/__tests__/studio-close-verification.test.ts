import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import type { ConnectedStudioInstance, ManagedStudioInstance, StudioProcessAdapter, StudioProcessInfo } from '../studio-instance-manager.js';

const PID = 4321;
const PROCESS: StudioProcessInfo = {
  Id: PID,
  Name: 'RobloxStudio',
  Path: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
  StartTimeUtcFileTime: '133700123456',
};

const CONNECTED: ConnectedStudioInstance = {
  instanceId: 'instance:close-test',
  role: 'edit',
  placeId: 0,
  placeName: 'CloseTest',
  dataModelName: 'CloseTest',
};

describe('Studio close process verification', () => {
  let registryDir: string;
  let manager: StudioInstanceManager;
  let record: ManagedStudioInstance;
  let processes: StudioProcessInfo[];
  let adapter: StudioProcessAdapter;
  let stopCalled: PromiseWithResolvers<void>;

  beforeEach(() => {
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-close-verification-'));
    processes = [PROCESS];
    stopCalled = Promise.withResolvers<void>();
    adapter = {
      currentBootId: () => 'close-test-boot',
      listStudioProcesses: () => processes,
      stopProcess: jest.fn(() => { stopCalled.resolve(); }),
    };
    manager = new StudioInstanceManager({ registryDir, processAdapter: adapter, closeTimeoutMs: 1000 });
    record = {
      recordId: 'close-test-launch',
      source: 'local_file',
      nativeProcessId: PID,
      nativeProcessStartedAt: PROCESS.StartTimeUtcFileTime,
      spawnPid: PID,
      exe: PROCESS.Path!,
      args: [],
      launchedAt: Date.now(),
      state: 'connected',
      instanceId: 'instance:close-test',
      bootId: 'close-test-boot',
      processAuthorizationState: 'released',
      processObservationStatus: 'running',
    };
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    fs.rmSync(registryDir, { recursive: true, force: true });
  });

  test('a process that ignores termination is not marked exited and can be closed again', async () => {
    const outcome = manager.close(record).catch((error: unknown) => error);
    await stopCalled.promise;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/timed out.*still running/i) }));
    expect(record.closedAt).toBeUndefined();
    expect(record.exitedAt).toBeUndefined();
    expect(record.processObservationStatus).toBe('running');

    adapter.stopProcess = jest.fn(() => { processes = []; });
    await expect(manager.close(record)).resolves.toMatchObject({ status: 'closed' });
    expect(record.state).toBe('exited');
    expect(record.processObservationStatus).toBe('not_running');
  });

  test('waits for delayed exit before deleting generated place files', async () => {
    const baseplateDir = path.join(os.tmpdir(), 'robloxstudio-mcp-baseplates');
    const placeFile = path.join(baseplateDir, `Baseplate-${process.pid}-${Date.now()}.rbxl`);
    fs.mkdirSync(baseplateDir, { recursive: true });
    fs.writeFileSync(placeFile, '<roblox />');
    fs.writeFileSync(`${placeFile}.lock`, '');
    record.source = 'baseplate';
    record.localPlaceFile = placeFile;
    try {
      let settled = false;
      const closing = manager.close(record).then((result) => { settled = true; return result; });
      await stopCalled.promise;
      await jest.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      expect(record.closedAt).toBeUndefined();
      expect(fs.existsSync(placeFile)).toBe(true);
      expect(fs.existsSync(`${placeFile}.lock`)).toBe(true);

      processes = [];
      await jest.advanceTimersByTimeAsync(100);
      await expect(closing).resolves.toMatchObject({ status: 'closed' });
      expect(record.state).toBe('exited');
      expect(fs.existsSync(placeFile)).toBe(false);
      expect(fs.existsSync(`${placeFile}.lock`)).toBe(false);
    } finally {
      fs.rmSync(placeFile, { force: true });
      fs.rmSync(`${placeFile}.lock`, { force: true });
    }
  });

  test('post-stop observation failure is unknown, not exited, and remains retryable', async () => {
    adapter.stopProcess = () => {
      adapter.listStudioProcesses = () => { throw new Error('process query failed'); };
    };
    await expect(manager.close(record)).rejects.toThrow(/could not verify.*process query failed/i);
    expect(record.closedAt).toBeUndefined();
    expect(record.processObservationStatus).toBe('unknown');

    adapter.listStudioProcesses = () => processes;
    adapter.stopProcess = () => { processes = []; };
    await expect(manager.close(record)).resolves.toMatchObject({ status: 'closed' });
  });

  test.each(['stop', 'observation'] as const)('bounds a hanging %s without a late terminal-state write', async (stage) => {
    const hanging = Promise.withResolvers<never>();
    adapter.stopProcess = () => {
      stopCalled.resolve();
      if (stage === 'stop') return hanging.promise;
      adapter.listStudioProcesses = () => hanging.promise;
    };
    const outcome = manager.close(record).catch((error: unknown) => error);
    await stopCalled.promise;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/timed out.*unknown/i) }));
    expect(record.closedAt).toBeUndefined();
    expect(record.processObservationStatus).toBe('unknown');
    hanging.reject(new Error('late failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(record.closedAt).toBeUndefined();
  });

  test('does not signal a replacement process that reused the PID', async () => {
    processes = [{ ...PROCESS, StartTimeUtcFileTime: '133700999999' }];
    await expect(manager.close(record)).resolves.toMatchObject({ status: 'already_closed' });
    expect(adapter.stopProcess).not.toHaveBeenCalled();
  });

  test('recognizes exit even if the PID is reused while waiting', async () => {
    adapter.stopProcess = () => {
      processes = [{ ...PROCESS, StartTimeUtcFileTime: '133700999999' }];
    };
    await expect(manager.close(record)).resolves.toMatchObject({ status: 'closed' });
    expect(record.state).toBe('exited');
  });

  test('does not treat missing creation-time metadata as a confirmed exit', async () => {
    adapter.stopProcess = () => { processes = [{ ...PROCESS, StartTimeUtcFileTime: undefined }]; };
    await expect(manager.close(record)).rejects.toThrow(/identity is unavailable/);
    expect(record.closedAt).toBeUndefined();
    expect(record.processObservationStatus).toBe('unknown');
  });

  test('handles a process that exits concurrently with a failed stop request', async () => {
    adapter.stopProcess = () => {
      processes = [];
      throw new Error('process already exited');
    };
    await expect(manager.close(record)).resolves.toMatchObject({ status: 'already_closed' });
    await expect(manager.close(record)).resolves.toMatchObject({ status: 'already_closed' });
  });

  test('unmanaged close also waits for verified process exit', async () => {
    let settled = false;
    const closing = manager.closeConnectedInstance(CONNECTED).then(() => { settled = true; });
    await stopCalled.promise;
    await jest.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    processes = [];
    await jest.advanceTimersByTimeAsync(100);
    await closing;
    expect(settled).toBe(true);
  });

  test.each(['managed', 'unmanaged', 'implicit'] as const)('%s tool close does not unregister peers when the process survives', async (kind) => {
    const bridge = new BridgeService();
    bridge.registerPeer({
      ...CONNECTED,
      peerId: 'close-peer',
      transportPeerId: 'close-peer',
      isRunning: false,
      pluginVersion: 'test',
      pluginVariant: 'main',
    });
    if (kind !== 'unmanaged') await manager.refresh(record);
    const tools = new RobloxStudioTools(bridge);
    Object.defineProperty(tools, 'instanceManager', { value: manager });
    const outcome = tools.manageInstance({
      action: 'close',
      ...(kind === 'implicit' ? {} : { instance_id: CONNECTED.instanceId }),
    }).catch((error: unknown) => error);
    await stopCalled.promise;
    await jest.advanceTimersByTimeAsync(1000);
    const result = await outcome;
    if (kind !== 'unmanaged') {
      expect(result).toEqual(expect.objectContaining({ message: expect.stringMatching(/still running/i) }));
      const status = await tools.manageInstance({ action: 'status', instance_id: CONNECTED.instanceId });
      expect(JSON.parse(status.content[0].text)).toMatchObject({ state: 'connected', process_running: true });
    } else {
      expect(result).not.toBeInstanceOf(Error);
      expect(JSON.stringify(result)).toMatch(/still running/);
      expect(JSON.stringify(result)).not.toMatch(/Studio instance closed/);
    }
    expect(bridge.getPublicInstances()).toHaveLength(1);
  });

  test('a disconnected plugin does not turn a live PID into an exited tool response', async () => {
    await manager.refresh(record);
    const tools = new RobloxStudioTools(new BridgeService());
    Object.defineProperty(tools, 'instanceManager', { value: manager });
    const outcome = tools.manageInstance({ action: 'close', launch_id: record.recordId }).catch((error: unknown) => error);
    await stopCalled.promise;
    await jest.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBeInstanceOf(Error);
    const status = await tools.manageInstance({ action: 'status', launch_id: record.recordId });
    expect(JSON.parse(status.content[0].text)).toMatchObject({ connected: false, state: 'connected', process_running: true });
  });

  test('retained launches attempt exact-handle abort even when enumeration is unavailable', async () => {
    const abort = jest.fn();
    adapter.resolveStudioExe = () => PROCESS.Path!;
    adapter.spawnStudio = () => ({
      pid: PID, nativePid: PID, nativeStartedAt: PROCESS.StartTimeUtcFileTime,
      unref() {}, authorize() {}, release() {}, abort,
    });
    const owned = await manager.launch({ source: 'local_file', localPlaceFile: '/tmp/close-test.rbxl', requireProcessIdentity: true });
    adapter.listStudioProcesses = () => { throw new Error('enumeration unavailable'); };
    await expect(manager.close(owned)).rejects.toThrow(/enumeration unavailable/);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(owned.closedAt).toBeUndefined();
    expect(owned.processObservationStatus).toBe('unknown');

    adapter.listStudioProcesses = () => processes;
    abort.mockImplementation(() => { processes = []; });
    await expect(manager.close(owned)).resolves.toMatchObject({ status: 'closed' });
  });

  test('missing identity before close is unknown, not a replacement process', async () => {
    processes = [{ ...PROCESS, StartTimeUtcFileTime: undefined }];
    await expect(manager.close(record)).rejects.toThrow(/identity is unavailable/);
    expect(adapter.stopProcess).not.toHaveBeenCalled();
    expect(record.closedAt).toBeUndefined();
    expect(record.processObservationStatus).toBe('unknown');
  });
});

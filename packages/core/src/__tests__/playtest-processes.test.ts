import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findPlaytestProcesses,
  playtestProcessRole,
  studioPlaceFile,
  type StudioProcessNode,
} from '../playtest-processes.js';
import {
  buildWindowsStudioStopManyScript,
  parseWindowsStudioProcessTree,
  StudioInstanceManager,
  type ConnectedStudioInstance,
  type ManagedStudioInstance,
  type StudioProcessAdapter,
} from '../studio-instance-manager.js';

const EXE = 'C:\\Users\\me\\AppData\\Local\\Roblox\\Versions\\version-1\\RobloxStudioBeta.exe';
const PLACE = '\\\\wsl.localhost\\Ubuntu\\tmp\\carbon-serve-1.rbxl';
const OTHER_PLACE = '\\\\wsl.localhost\\Ubuntu\\tmp\\carbon-serve-2.rbxl';

function edit(id: number, startedAt: string, place = PLACE, title = 'Place1 - Roblox Studio'): StudioProcessNode {
  return {
    Id: id,
    ParentId: 1,
    CommandLine: `${EXE} --task EditFile --localPlaceFile ${place}`,
    StartTimeUtcFileTime: startedAt,
    MainWindowTitle: title,
  };
}

function testWindow(id: number, parent: number, startedAt: string, role: 'Server' | 'Client', place = PLACE): StudioProcessNode {
  return {
    Id: id,
    ParentId: parent,
    CommandLine: `"${EXE}" -task Start${role} -localProjectFile "${place}"`,
    StartTimeUtcFileTime: startedAt,
    MainWindowTitle: role === 'Server' ? 'Server' : 'Place1',
  };
}

describe('playtest process matching (issue #190)', () => {
  test('reads the test role and place file from Studio command lines', () => {
    expect(playtestProcessRole(`${EXE} -task StartServer -localProjectFile x.rbxl`)).toBe('server');
    expect(playtestProcessRole(`${EXE} --task StartClient`)).toBe('client');
    expect(playtestProcessRole(`${EXE} --task EditFile --localPlaceFile x.rbxl`)).toBeUndefined();
    expect(playtestProcessRole(undefined)).toBeUndefined();

    expect(studioPlaceFile(`${EXE} --task EditFile --localPlaceFile ${PLACE}`)).toBe('wsl.localhost/ubuntu/tmp/carbon-serve-1.rbxl');
    expect(studioPlaceFile(`"${EXE}" -task StartClient -localProjectFile "${PLACE}"`)).toBe('wsl.localhost/ubuntu/tmp/carbon-serve-1.rbxl');
    const intent = String.raw`"${EXE}" -launchIntentString "{\"task\":\"EditFile\",\"localplacefile\":\"C:\\\\Temp\\\\Base.rbxl\"}" -parentPid 3`;
    expect(studioPlaceFile(intent)).toBe('c:/temp/base.rbxl');
    expect(studioPlaceFile(`${EXE}`)).toBeUndefined();
  });

  test('finds the Server under the edit Studio and the clients under the Server', () => {
    const processes = [
      edit(100, '1000'),
      testWindow(200, 100, '2000', 'Server'),
      testWindow(300, 200, '3000', 'Client'),
      testWindow(301, 200, '3001', 'Client'),
      edit(400, '1500', OTHER_PLACE),
      testWindow(500, 400, '2500', 'Server', OTHER_PLACE),
    ];
    expect(findPlaytestProcesses(processes[0], processes)).toEqual([
      { pid: 200, startedAt: '2000', role: 'server' },
      { pid: 300, startedAt: '3000', role: 'client' },
      { pid: 301, startedAt: '3001', role: 'client' },
    ]);
    expect(findPlaytestProcesses(processes[4], processes)).toEqual([{ pid: 500, startedAt: '2500', role: 'server' }]);
  });

  test('keeps clients whose Server already exited, by their place file', () => {
    const processes = [edit(100, '1000'), testWindow(300, 200, '3000', 'Client')];
    expect(findPlaytestProcesses(processes[0], processes)).toEqual([{ pid: 300, startedAt: '3000', role: 'client' }]);
  });

  test('a reused parent PID does not adopt another edit Studio\'s windows', () => {
    // PID 100 now names an edit Studio created after the window: a different process.
    const processes = [edit(100, '9000', OTHER_PLACE), testWindow(200, 100, '2000', 'Server')];
    expect(findPlaytestProcesses(processes[0], processes)).toEqual([]);
  });

  test('an orphan is not claimed when another edit Studio has its place open', () => {
    const processes = [edit(100, '1000'), edit(101, '1100'), testWindow(300, 999, '3000', 'Client')];
    expect(findPlaytestProcesses(processes[0], processes)).toEqual([]);
  });

  test('windows of another edit Studio with a live parent chain are never claimed', () => {
    const processes = [edit(100, '1000'), edit(400, '1500', OTHER_PLACE), testWindow(500, 400, '2500', 'Server', PLACE)];
    expect(findPlaytestProcesses(processes[0], processes)).toEqual([]);
  });
});

describe('Windows process tree helpers', () => {
  test('parses the PowerShell tree, including a single object and missing details', () => {
    expect(parseWindowsStudioProcessTree(JSON.stringify({
      Id: 5, ParentId: 4, CommandLine: 'x', MainWindowTitle: 't', StartTimeUtcFileTime: '77',
    }))).toEqual([{ Id: 5, ParentId: 4, CommandLine: 'x', MainWindowTitle: 't', StartTimeUtcFileTime: '77' }]);
    expect(parseWindowsStudioProcessTree(JSON.stringify([
      { Id: 5, ParentId: null, CommandLine: null, MainWindowTitle: '', StartTimeUtcFileTime: '77' },
    ]))).toEqual([{ Id: 5, MainWindowTitle: '', StartTimeUtcFileTime: '77' }]);
    expect(() => parseWindowsStudioProcessTree(JSON.stringify([{ Id: 5 }]))).toThrow('Malformed');
  });

  test('stops each exact process and keeps going past one that fails', () => {
    const script = buildWindowsStudioStopManyScript([
      { pid: 200, startedAt: '2000' },
      { pid: 300, startedAt: '3000' },
    ]);
    expect(script).toContain('try { $stopped += @(Stop-ExactStudio 200 2000) } catch');
    expect(script).toContain('try { $stopped += @(Stop-ExactStudio 300 3000) } catch');
    expect(script).toContain('-ne $expectedStartedAt');
    expect(() => buildWindowsStudioStopManyScript([{ pid: 0, startedAt: '1' }])).toThrow('processId');
    expect(() => buildWindowsStudioStopManyScript([{ pid: 1, startedAt: '1; rm' }])).toThrow('startedAt');
  });
});

describe('StudioInstanceManager test windows', () => {
  const INSTANCE: ConnectedStudioInstance = {
    instanceId: 'instance:windows', role: 'edit', placeId: 0, placeName: 'Place1', dataModelName: 'Place1',
  };
  let registryDir: string;
  let processes: StudioProcessNode[];
  let stopped: number[];
  let adapter: StudioProcessAdapter;
  let manager: StudioInstanceManager;

  beforeEach(() => {
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playtest-processes-'));
    processes = [
      edit(100, '1000'),
      testWindow(200, 100, '2000', 'Server'),
      testWindow(300, 200, '3000', 'Client'),
    ];
    stopped = [];
    adapter = {
      currentBootId: () => 'playtest-boot',
      observeStudioProcesses: () => ({
        status: 'ok',
        observedAt: Date.now(),
        processes: processes.map((node) => ({ ...node, Name: 'RobloxStudioBeta', Path: EXE })),
      }),
      observeStudioProcessTree: () => ({ status: 'ok', observedAt: Date.now(), processes }),
      stopProcess: (pid) => {
        stopped.push(pid);
        processes = processes.filter((node) => node.Id !== pid);
      },
    };
    manager = new StudioInstanceManager({ registryDir, processAdapter: adapter, closeTimeoutMs: 1000 });
  });

  afterEach(() => {
    fs.rmSync(registryDir, { recursive: true, force: true });
  });

  test('lists the windows of the edit Studio found by its title, and closes them', async () => {
    const listing = await manager.listPlaytestProcesses(INSTANCE);
    expect(listing).toEqual({
      status: 'ok',
      editProcessId: 100,
      processes: [
        { pid: 200, startedAt: '2000', role: 'server' },
        { pid: 300, startedAt: '3000', role: 'client' },
      ],
    });
    if (listing.status !== 'ok') throw new Error('unreachable');
    await expect(manager.closePlaytestProcesses(listing.processes)).resolves.toEqual({
      closed: listing.processes,
      remaining: [],
    });
    expect(stopped).toEqual([200, 300]);
  });

  test('reports a window that survives its close', async () => {
    adapter.stopProcess = (pid) => { stopped.push(pid); };
    const result = await manager.closePlaytestProcesses([{ pid: 200, startedAt: '2000', role: 'server' }], 300);
    expect(result).toMatchObject({
      closed: [],
      remaining: [{ pid: 200 }],
      error: expect.stringMatching(/Timed out closing test windows 200/),
    });
  });

  test('cannot list windows without a process tree, and never reads the real host behind an adapter', async () => {
    delete adapter.observeStudioProcessTree;
    manager = new StudioInstanceManager({ registryDir, processAdapter: adapter });
    await expect(manager.listPlaytestProcesses(INSTANCE)).resolves.toMatchObject({ status: 'unavailable' });
  });

  test('an unknown edit Studio is reported, not guessed among several', async () => {
    processes = [edit(100, '1000', PLACE, 'A - Roblox Studio'), edit(101, '1001', OTHER_PLACE, 'B - Roblox Studio')];
    await expect(manager.listPlaytestProcesses(INSTANCE)).resolves.toMatchObject({
      status: 'unavailable',
      reason: expect.stringMatching(/Could not find the edit Studio process/),
    });
  });

  test('a sole Studio whose title does not name the instance is not assumed to be its edit', async () => {
    // With a remotely reachable bridge, the connected edit may be another machine's Studio.
    processes = [edit(100, '1000', PLACE, 'Other - Roblox Studio'), testWindow(200, 100, '2000', 'Server')];
    await expect(manager.listPlaytestProcesses(INSTANCE)).resolves.toMatchObject({ status: 'unavailable' });
  });

  test('a failed process listing is an error, not an unsupported platform', async () => {
    adapter.observeStudioProcessTree = () => ({ status: 'error', observedAt: Date.now(), error: 'timed out' });
    await expect(manager.listPlaytestProcesses(INSTANCE)).resolves.toEqual({
      status: 'error', error: 'Could not list Studio processes: timed out',
    });
  });

  test('closing a managed edit Studio also closes the test windows it started', async () => {
    const record: ManagedStudioInstance = {
      recordId: 'playtest-launch',
      source: 'local_file',
      nativeProcessId: 100,
      nativeProcessStartedAt: '1000',
      spawnPid: 100,
      exe: EXE,
      args: [],
      launchedAt: Date.now(),
      state: 'connected',
      instanceId: INSTANCE.instanceId,
      bootId: 'playtest-boot',
      processAuthorizationState: 'released',
      processObservationStatus: 'running',
    };
    await expect(manager.close(record)).resolves.toMatchObject({ status: 'closed' });
    expect(stopped).toEqual([100, 200, 300]);
  });
});

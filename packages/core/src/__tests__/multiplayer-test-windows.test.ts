import { BridgeService } from '../bridge-service.js';
import type { PlaytestProcess } from '../playtest-processes.js';
import type { PlaytestProcessCloseResult, PlaytestProcessListing } from '../studio-instance-manager.js';
import { RobloxStudioTools } from './test-tools.js';

// Issue #190: multiplayer_playtest must end test windows by process, not only
// through the plugins that happen to be connected.

const EDIT = {
  peerId: 'session-1',
  transportPeerId: 'session-1',
  instanceId: 'instance:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
  pluginVersion: 'test-version',
  pluginVariant: 'main',
};

const WINDOWS: PlaytestProcess[] = [
  { pid: 200, startedAt: '2000', role: 'server' },
  { pid: 300, startedAt: '3000', role: 'client' },
];

interface Harness {
  bridge: BridgeService;
  tools: RobloxStudioTools;
  listings: PlaytestProcessListing[];
  closed: PlaytestProcess[][];
  phases: (string | undefined)[];
  /** The test the edit plugin reports; a test changes it to model another start. */
  testId: string;
}

// Each listing call takes the next entry; the last one repeats. Each phase read likewise.
function harness(listings: PlaytestProcessListing[], phases: (string | undefined)[] = ['completed']): Harness {
  const bridge = new BridgeService();
  bridge.registerPeer(EDIT);
  const tools = new RobloxStudioTools(bridge);
  const state: Harness = { bridge, tools, listings, closed: [], phases, testId: 'test-current' };
  const internals = tools as unknown as {
    instanceManager: {
      listPlaytestProcesses: () => Promise<PlaytestProcessListing>;
      closePlaytestProcesses: (processes: PlaytestProcess[]) => Promise<PlaytestProcessCloseResult>;
    };
    _multiplayerEditSession: () => Promise<{ phase?: string; testId?: string }>;
  };
  internals.instanceManager.listPlaytestProcesses = async () =>
    state.listings.length > 1 ? state.listings.shift()! : state.listings[0];
  internals.instanceManager.closePlaytestProcesses = async (processes) => {
    state.closed.push(processes);
    return { closed: processes, remaining: [] };
  };
  internals._multiplayerEditSession = async () => {
    const next = state.phases.length > 1 ? state.phases.shift() : state.phases[0];
    return next === undefined ? {} : { phase: next, testId: state.testId };
  };
  return state;
}

function body(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

function claim(bridge: BridgeService) {
  return bridge.claimNextRequestForTransport('session-1', 'test-windows');
}

async function claimSoon(bridge: BridgeService) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const queued = claim(bridge);
    if (queued) return queued;
    await Promise.resolve();
  }
  throw new Error('No request was queued.');
}

describe('multiplayer_playtest test windows (issue #190)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('end with no connected peers closes test windows instead of reporting already ended', async () => {
    const { tools, closed, bridge } = harness([
      { status: 'ok', editProcessId: 100, processes: WINDOWS },
      { status: 'ok', editProcessId: 100, processes: [] },
    ]);
    bridge.createMultiplayerGroup('test-orphan', 'instance:test');
    const result = body(await tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, 5, 'instance:test'));
    expect(result).toEqual({
      success: true,
      action: 'end',
      multiplayerGroupId: 'test-orphan',
      message: 'Multiplayer playtest ended; closed 2 test window(s) that were still running.',
      teardownConfirmed: true,
      closedTestWindows: 2,
    });
    expect(closed).toEqual([WINDOWS]);
    expect(bridge.getMultiplayerGroups()).toEqual([]);
  });

  test('end still reports already ended when no window and no test is running', async () => {
    const { tools, closed } = harness([{ status: 'ok', editProcessId: 100, processes: [] }]);
    const result = body(await tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, 5, 'instance:test'));
    expect(result).toEqual({
      success: true,
      action: 'end',
      message: 'Multiplayer playtest already ended.',
      teardownConfirmed: true,
    });
    expect(closed).toEqual([]);
  });

  test('end closes windows Studio opens after the call while it still reports the test running', async () => {
    jest.useFakeTimers();
    const { tools, closed } = harness([
      { status: 'ok', editProcessId: 100, processes: [] },
      { status: 'ok', editProcessId: 100, processes: WINDOWS },
      { status: 'ok', editProcessId: 100, processes: [] },
    ], ['running', 'running', 'completed']);
    const pending = tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, 10, 'instance:test');
    await jest.advanceTimersByTimeAsync(1000);
    const result = body(await pending);
    expect(result).toMatchObject({ success: true, teardownConfirmed: true, closedTestWindows: 2 });
    expect(closed).toEqual([WINDOWS]);
  });

  test('end does not confirm teardown while Studio reports a test running and windows cannot be tracked', async () => {
    jest.useFakeTimers();
    const state = harness(
      [{ status: 'unavailable', reason: 'Test windows are tracked by process only on Windows and WSL.' }],
      ['running'],
    );
    const { tools, bridge } = state;
    state.testId = 'test-running';
    bridge.createMultiplayerGroup('test-running', 'instance:test');
    const result = body(await tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, 5, 'instance:test'));
    expect(result).toEqual({
      success: true,
      action: 'end',
      multiplayerGroupId: 'test-running',
      message: expect.stringMatching(/^Studio still reports a multiplayer test in progress/),
      teardownConfirmed: false,
      editPhase: 'running',
      testWindowTracking: 'Test windows are tracked by process only on Windows and WSL.',
    });
    // The group stays so late peers still join it, and a later end can find it.
    expect(bridge.getMultiplayerGroups().map((group) => group.id)).toEqual(['test-running']);
  });

  test('end reports windows it could not close', async () => {
    const state = harness([{ status: 'ok', editProcessId: 100, processes: WINDOWS }]);
    (state.tools as unknown as {
      instanceManager: { closePlaytestProcesses: () => Promise<PlaytestProcessCloseResult> };
    }).instanceManager.closePlaytestProcesses = async () => ({
      closed: [WINDOWS[1]], remaining: [WINDOWS[0]], error: 'Could not close test windows: 200: Access is denied.',
    });
    const result = body(await state.tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, 5, 'instance:test'));
    expect(result).toEqual({
      success: true,
      action: 'end',
      message: 'Multiplayer playtest end requested, but 1 test window(s) are still running.',
      teardownConfirmed: false,
      closedTestWindows: 1,
      remainingTestWindows: 1,
      testWindowError: 'Could not close test windows: 200: Access is denied.',
      editPhase: 'completed',
    });
  });

  test('a start whose peers never register is ended and its windows closed', async () => {
    const { tools, bridge, closed } = harness([
      { status: 'ok', editProcessId: 100, processes: [] },
      { status: 'ok', editProcessId: 100, processes: WINDOWS },
      { status: 'ok', editProcessId: 100, processes: [] },
    ]);
    (tools as unknown as { _buildMultiplayerState: () => Promise<unknown> })._buildMultiplayerState = async () => ({
      peers: [{ role: 'edit' }], clientRoles: [], playerCount: 0,
    });
    const pending = tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 0.1, 'instance:test');
    const request = await claimSoon(bridge);
    expect(request.endpoint).toBe('/api/multiplayer-test-start');
    bridge.resolveRequest(request.requestId, { success: true, testId: 'test-undetected' });
    const result = body(await pending);
    expect(result).toMatchObject({
      success: false,
      error: 'multiplayer_start_not_detected',
      message: expect.stringMatching(/MCP ended the attempt and closed its 2 test window\(s\)\.$/),
      teardownConfirmed: true,
      closedTestWindows: 2,
    });
    expect(closed).toEqual([WINDOWS]);
    expect(bridge.getMultiplayerGroups()).toEqual([]);
  });

  test('start refuses while test windows without a plugin are open, and closes none', async () => {
    const { tools, bridge, closed } = harness([{ status: 'ok', editProcessId: 100, processes: WINDOWS }], ['completed']);
    const result = body(await tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 5, 'instance:test'));
    expect(result).toEqual({
      success: false,
      action: 'start',
      error: 'stale_test_windows',
      message: '2 test window(s) of this Studio are running without a connected MCP plugin. Close them with multiplayer_playtest action="end", then start again.',
      testWindows: 2,
      editPhase: 'completed',
      roles: ['edit'],
    });
    expect(claim(bridge)).toBeNull();
    expect(closed).toEqual([]);
  });

  test('start names a start still loading instead of calling its windows stale', async () => {
    const { tools, closed } = harness([{ status: 'ok', editProcessId: 100, processes: WINDOWS }], ['starting']);
    expect(body(await tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 5, 'instance:test'))).toMatchObject({
      success: false,
      error: 'stale_test_windows',
      message: expect.stringMatching(/^Studio is still starting a multiplayer test/),
      editPhase: 'starting',
    });
    expect(closed).toEqual([]);
  });

  test('end leaves the windows of a test that started after the one it ends', async () => {
    const state = harness([{ status: 'ok', editProcessId: 100, processes: WINDOWS }], ['running']);
    state.testId = 'test-someone-else';
    state.bridge.createMultiplayerGroup('test-ours', 'instance:test');
    const result = body(await state.tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, 5, 'instance:test'));
    expect(result).toMatchObject({ success: true, teardownConfirmed: true, message: 'Multiplayer playtest already ended.' });
    expect(state.closed).toEqual([]);
  });

  test('a failed listing never confirms teardown', async () => {
    const { tools } = harness([{ status: 'error', error: 'Could not list Studio processes: timed out' }]);
    expect(body(await tools.multiplayerPlaytest('end', undefined, undefined, undefined, undefined, 5, 'instance:test'))).toMatchObject({
      success: true,
      teardownConfirmed: false,
      testWindowError: 'Could not list Studio processes: timed out',
    });
  });

  test('a start whose server refuses EndTest still has its windows closed', async () => {
    const { tools, bridge, closed } = harness([
      { status: 'ok', editProcessId: 100, processes: [] },
      { status: 'ok', editProcessId: 100, processes: WINDOWS },
      { status: 'ok', editProcessId: 100, processes: [] },
    ]);
    (tools as unknown as { multiplayerTestEnd: () => Promise<unknown> }).multiplayerTestEnd = async () => ({
      content: [{ type: 'text', text: JSON.stringify({ error: 'EndTest failed' }) }],
    });
    (tools as unknown as { _waitForMultiplayerStart: () => Promise<unknown> })._waitForMultiplayerStart = async () => ({
      ok: false, roles: ['edit', 'server'], timedOut: true,
    });
    (tools as unknown as { _buildMultiplayerState: () => Promise<unknown> })._buildMultiplayerState = async () => ({
      peers: [{ role: 'edit' }], clientRoles: [], playerCount: 0,
    });
    const pending = tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 5, 'instance:test');
    const request = await claimSoon(bridge);
    bridge.resolveRequest(request.requestId, { success: true, testId: 'test-current' });
    expect(body(await pending)).toMatchObject({
      success: false,
      teardownConfirmed: true,
      closedTestWindows: 2,
      teardownError: 'EndTest failed',
    });
    expect(closed).toEqual([WINDOWS]);
  });

  test('status counts test windows no connected plugin answers for', async () => {
    const { tools } = harness([{ status: 'ok', editProcessId: 100, processes: WINDOWS }]);
    (tools as unknown as { _buildMultiplayerState: () => Promise<unknown> })._buildMultiplayerState = async () => ({
      phase: 'running', peers: [{ role: 'edit' }], playerCount: 0,
    });
    expect(body(await tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, 'instance:test')))
      .toMatchObject({
        success: true,
        roles: ['edit'],
        testWindows: 2,
        unansweredTestWindows: 2,
        testWindowHint: expect.stringContaining('end closes them'),
      });
  });
});

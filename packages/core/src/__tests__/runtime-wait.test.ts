import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools, buildWaitProbe } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';

type Reply = Record<string, unknown>;
type Handler = (endpoint: string, data: { code?: string }) => Reply | Promise<Reply>;

const parse = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content[0].text ?? '{}');

// A solo playtest: edit, server and client-1 peers of one Studio process.
function setup(handler: Handler) {
  const bridge = new BridgeService();
  for (const role of ['edit', 'server', 'client-1']) {
    const peerId = `peer:${role}`;
    const registered = bridge.registerPeer({
      peerId, transportPeerId: peerId, instanceId: 'instance:solo', role,
      placeId: 1, placeName: 'Place', dataModelName: 'Place', isRunning: role !== 'edit',
    });
    if (!registered.ok) throw new Error(registered.error.message);
  }
  const request = jest.spyOn(StudioHttpClient.prototype, 'request')
    .mockImplementation((async (endpoint: string, data: { code?: string }) => handler(endpoint, data)) as never);
  return { bridge, request, tools: new RobloxStudioTools(bridge) };
}

describe('buildWaitProbe', () => {
  test('returns an expression and keeps the caller text on line 1', () => {
    const probe = buildWaitProbe('workspace:GetAttribute("Ready")');
    expect(probe.split('\n')[0]).toBe('local __mcp_value = (function() return (workspace:GetAttribute("Ready")');
    expect(probe).toContain('return (if __mcp_value then "T" else "F") .. __mcp_shown');
  });

  test('runs a block with its own return unchanged', () => {
    expect(buildWaitProbe('local n = #workspace:GetChildren() return n > 3').split('\n')[0])
      .toBe('local __mcp_value = (function() local n = #workspace:GetChildren() return n > 3');
  });
});

describe('eval_*_runtime wait_until', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('runs code once, then returns as soon as the server condition flips', async () => {
    let polls = 0;
    const { tools, request } = setup((_endpoint, data) => data.code?.startsWith('local __mcp_value')
      ? { bridge: 'ok', ok: true, result: ++polls < 3 ? 'Ffalse' : 'Ttrue' }
      : { bridge: 'ok', ok: true, result: 'nil', output: ['scheduled'] });
    const pending = tools.evalServerRuntime('task.delay(1, flip)', 'instance:solo', undefined, { wait_until: 'workspace:GetAttribute("flip")', poll_ms: 100 });
    await jest.advanceTimersByTimeAsync(500);
    expect(parse(await pending)).toMatchObject({ satisfied: true, value: 'true', polls: 3, code_result: 'nil', code_output: ['scheduled'] });
    expect(request.mock.calls.map(([, , peer]) => peer)).toEqual(['peer:server', 'peer:server', 'peer:server', 'peer:server']);
  });

  test('polls a client and reports the last value on timeout', async () => {
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: true, result: 'F3' }));
    const pending = tools.evalClientRuntime(undefined, undefined, 'instance:solo', undefined, { wait_until: '#game.Players:GetPlayers() > 3', timeout_s: 1, poll_ms: 250 });
    await jest.advanceTimersByTimeAsync(1500);
    expect(parse(await pending)).toMatchObject({
      satisfied: false, value: '3', error: 'wait_until timed out after 1s: the condition never became truthy.',
    });
    expect(request.mock.calls.every(([, , peer]) => peer === 'peer:client-1')).toBe(true);
  });

  test('treats a runtime error as not yet true and keeps polling', async () => {
    let polls = 0;
    const { tools } = setup(() => (++polls === 1
      ? { bridge: 'ok', ok: false, error: 'attempt to index nil with \'Value\'' }
      : { bridge: 'ok', ok: true, result: 'T5' }));
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'workspace.Score.Value', poll_ms: 50 });
    await jest.advanceTimersByTimeAsync(100);
    expect(parse(await pending)).toMatchObject({ satisfied: true, value: '5', polls: 2 });
  });

  test('does not poll when code fails', async () => {
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: false, error: 'boom' }));
    const body = parse(await tools.evalServerRuntime('error("boom")', 'instance:solo', undefined, { wait_until: 'true' }));
    expect(body).toMatchObject({ satisfied: false, polls: 0, error: expect.stringContaining('code failed') });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ bridge: 'ok', ok: false, error: '[string "probe"]:1: Expected identifier, got \')\'' }, 'wait_until does not compile'],
    [{ error: 'eval_*_runtime requires a running playtest.' }, 'The playtest stopped while waiting'],
  ])('stops early on %j', async (reply, error) => {
    const { tools, request } = setup(() => reply);
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'x ==' });
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 1, error: expect.stringContaining(error) });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('stops when the runtime peer disconnects', async () => {
    const { tools, bridge } = setup(() => {
      bridge.unregisterPeer('peer:server');
      return { bridge: 'ok', ok: true, result: 'Fnil' };
    });
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'false', poll_ms: 50 });
    await jest.advanceTimersByTimeAsync(200);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 2, value: 'nil', error: expect.stringContaining('server peer is gone') });
  });

  test('rejects a call with neither code nor wait_until', async () => {
    const { tools } = setup(() => ({}));
    await expect(tools.evalServerRuntime(undefined, 'instance:solo')).rejects.toThrow('eval_server_runtime requires code or wait_until');
  });

  test.each([
    [{ wait_until: '  ' }, /wait_until must be a non-empty/],
    [{ wait_until: 'true', timeout_s: 601 }, /timeout_s must be a number above 0 and at most 600/],
    [{ wait_until: 'true', poll_ms: 10 }, /poll_ms must be an integer from 50 to 10000/],
  ])('rejects %j', async (wait, error) => {
    const { tools, request } = setup(() => ({}));
    await expect(tools.evalServerRuntime(undefined, 'instance:solo', undefined, wait)).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  });
});

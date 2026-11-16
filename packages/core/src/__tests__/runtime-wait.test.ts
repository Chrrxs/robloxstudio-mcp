import { BridgeService, RoutingFailure } from '../bridge-service.js';
import { RobloxStudioTools, buildWaitProbe } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';

type Reply = Record<string, unknown>;
type Handler = (endpoint: string, data: { code?: string }) => Reply | Promise<Reply>;

const parse = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content[0].text ?? '{}');
const isProbe = (code: string | undefined) => code?.startsWith('local __mcp_thread') === true;
const firstLine = (code: string | undefined) => code?.split('\n')[0] ?? '';
// What the Studio plugin sends back when the payload fails to load: no output array.
const loadFailure = (error: string): Reply => ({ bridge: 'ok', ok: false, error });
// A runtime error caught by the plugin's xpcall wrapper always carries output.
const runtimeError = (error: string): Reply => ({ bridge: 'ok', ok: false, error, output: [] });

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
    expect(firstLine(probe)).toBe('local __mcp_thread = coroutine.create(function() return (workspace:GetAttribute("Ready")');
    expect(probe).toContain('return (if __mcp_value then "T" else "F") .. __mcp_shown');
  });

  test('keeps text that mentions return as an expression', () => {
    expect(firstLine(buildWaitProbe('workspace:GetAttribute("return") == 2 -- return early')))
      .toBe('local __mcp_thread = coroutine.create(function() return (workspace:GetAttribute("return") == 2 -- return early');
  });

  test('runs the block form with its own return unchanged', () => {
    expect(firstLine(buildWaitProbe('local n = #workspace:GetChildren() return n > 3', 'block')))
      .toBe('local __mcp_thread = coroutine.create(function() local n = #workspace:GetChildren() return n > 3');
  });

  test('cancels a condition that yields and raises a clear error', () => {
    const probe = buildWaitProbe('workspace:WaitForChild("Map")');
    expect(probe).toContain('local __mcp_ok, __mcp_value = coroutine.resume(__mcp_thread)');
    expect(probe).toContain('if coroutine.status(__mcp_thread) ~= "dead" then\n\ttask.cancel(__mcp_thread)\n\terror("wait_until must not yield');
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
    const { tools, request } = setup((_endpoint, data) => isProbe(data.code)
      ? { bridge: 'ok', ok: true, result: ++polls < 3 ? 'Ffalse' : 'Ttrue', output: [] }
      : { bridge: 'ok', ok: true, result: 'nil', output: ['scheduled'] });
    const pending = tools.evalServerRuntime('task.delay(1, flip)', 'instance:solo', undefined, { wait_until: 'workspace:GetAttribute("flip")', poll_ms: 100 });
    await jest.advanceTimersByTimeAsync(500);
    expect(parse(await pending)).toMatchObject({ satisfied: true, value: 'true', polls: 3, code_result: 'nil', code_output: ['scheduled'] });
    expect(request.mock.calls.map(([, , peer]) => peer)).toEqual(['peer:server', 'peer:server', 'peer:server', 'peer:server']);
  });

  test('polls a client and reports the last value on timeout', async () => {
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: true, result: 'F3', output: [] }));
    const pending = tools.evalClientRuntime(undefined, undefined, 'instance:solo', undefined, { wait_until: '#game.Players:GetPlayers() > 3', timeout_s: 1, poll_ms: 250 });
    await jest.advanceTimersByTimeAsync(1500);
    expect(parse(await pending)).toMatchObject({
      satisfied: false, value: '3', error: 'wait_until timed out after 1s: the condition never became truthy.',
    });
    expect(request.mock.calls.every(([, , peer]) => peer === 'peer:client-1')).toBe(true);
  });

  test.each([
    [runtimeError('attempt to index nil with \'Value\'')],
    [runtimeError('Workspace.__MCPEvalPayload:1: Expected \':\' not \'.\' calling member function FindFirstChild')],
    [loadFailure('ModuleScript Source set failed: busy')],
  ])('treats %j as not yet true and keeps polling', async (reply) => {
    let polls = 0;
    const { tools } = setup(() => (++polls === 1 ? reply : { bridge: 'ok', ok: true, result: 'T5', output: [] }));
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'workspace.Score.Value', timeout_s: 5, poll_ms: 50 });
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
    [loadFailure('user_code:1: Expected identifier, got \')\''), 'wait_until does not compile'],
    [loadFailure('user_code:1: Malformed string; did you forget to finish it?'), 'wait_until does not compile'],
    [loadFailure('user_code:1: Cannot use \'...\' outside of a vararg function'), 'wait_until does not compile'],
    [loadFailure('Requested module experienced an error while loading'), 'wait_until does not compile'],
    // Fallback for a reply without the plugin's eval shape.
    [{ error: 'user_code:1: String literal contains malformed escape sequence' }, 'wait_until does not compile'],
    [{ bridge: 'missing', error: 'eval_*_runtime requires a running playtest.' }, 'The playtest stopped while waiting'],
    [runtimeError('wait_until must not yield: it called something that waits\nuser_code:1'), 'wait_until must not yield'],
  ])('stops early on %j', async (reply, error) => {
    const { tools, request } = setup(() => reply);
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'x ==' });
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 1, error: expect.stringContaining(error) });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('switches to the block form once when only the block compiles, and keeps it', async () => {
    let blockPolls = 0;
    const { tools, request } = setup((_endpoint, data) => firstLine(data.code).includes('return (local')
      ? loadFailure('user_code:1: Expected identifier when parsing expression, got \'local\'')
      : { bridge: 'ok', ok: true, result: ++blockPolls < 2 ? 'F2' : 'T3', output: [] });
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'local n = #workspace:GetChildren() return n > 2', timeout_s: 5, poll_ms: 50 });
    await jest.advanceTimersByTimeAsync(100);
    expect(parse(await pending)).toMatchObject({ satisfied: true, value: '3', polls: 3 });
    expect(request.mock.calls.map(([, data]) => firstLine((data as { code: string }).code).includes('return (local')))
      .toEqual([true, false, false]);
  });

  test('keeps the expression form when it compiles, even if the text says return', async () => {
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: true, result: 'Ttrue', output: [] }));
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: '(function() return workspace:GetAttribute("return") end)() == 2' });
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await pending)).toMatchObject({ satisfied: true, polls: 1 });
    expect(firstLine((request.mock.calls[0][1] as { code: string }).code)).toContain('function() return ((function() return');
  });

  test('reports a compile error when neither form compiles', async () => {
    const { tools, request } = setup(() => loadFailure('user_code:1: Expected \'end\''));
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'if x then return 1' });
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 2, error: expect.stringContaining('wait_until does not compile') });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('stops when the runtime peer disconnects', async () => {
    const { tools, bridge } = setup(() => {
      bridge.unregisterPeer('peer:client-1');
      return { bridge: 'ok', ok: true, result: 'Fnil', output: [] };
    });
    const pending = tools.evalClientRuntime(undefined, undefined, 'instance:solo', undefined, { wait_until: 'false', timeout_s: 5, poll_ms: 50 });
    await jest.advanceTimersByTimeAsync(200);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 2, value: 'nil', error: expect.stringContaining('client-1 peer is gone') });
  });

  test('rethrows a routing failure before any probe reached a peer', async () => {
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: true, result: 'Ttrue', output: [] }));
    await expect(tools.evalServerRuntime(undefined, 'instance:elsewhere', undefined, { wait_until: 'true' })).rejects.toBeInstanceOf(RoutingFailure);
    await expect(tools.evalClientRuntime(undefined, 'client-2', 'instance:solo', undefined, { wait_until: 'true' })).rejects.toBeInstanceOf(RoutingFailure);
    expect(request).not.toHaveBeenCalled();
  });

  test('stops polling when the caller cancels, passing the signal to each probe', async () => {
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: true, result: 'Ffalse', output: [] }));
    const controller = new AbortController();
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'false', poll_ms: 1000 }, controller.signal);
    const cancelled = expect(pending).rejects.toThrow('caller went away');
    await jest.advanceTimersByTimeAsync(1500);
    controller.abort(new Error('caller went away'));
    await cancelled;
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[4] === controller.signal)).toBe(true);
  });

  test('spreads long waits so one wait sends at most 120 probes', async () => {
    // The whole wait fits one response here; this client allows long calls.
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_MCP_RESPONSE_BUDGET_MS: '400000' });
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: true, result: 'Ffalse', output: [] }));
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'false', timeout_s: 300, poll_ms: 50 });
    await jest.advanceTimersByTimeAsync(300_000);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 120 });
    expect(request).toHaveBeenCalledTimes(120);
  });

  test('rejects a call with neither code nor wait_until', async () => {
    const { tools } = setup(() => ({}));
    await expect(tools.evalServerRuntime(undefined, 'instance:solo')).rejects.toThrow('eval_server_runtime requires code or wait_until');
  });

  test.each([
    [{ wait_until: '  ' }, /wait_until must be a non-empty/],
    [{ wait_until: 'true', timeout_s: 301 }, /timeout_s must be a number above 0 and at most 300/],
    [{ wait_until: 'true', poll_ms: 10 }, /poll_ms must be an integer from 50 to 10000/],
  ])('rejects %j', async (wait, error) => {
    const { tools, request } = setup(() => ({}));
    await expect(tools.evalServerRuntime(undefined, 'instance:solo', undefined, wait)).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  });

  test('a wait past the response budget returns pending; repeats join it and get_request_status returns the result', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_MCP_RESPONSE_BUDGET_MS: '1000' });
    let flipped = false;
    const { tools } = setup(() => ({ bridge: 'ok', ok: true, result: flipped ? 'Ttrue' : 'Ffalse' }));
    const wait = { wait_until: 'workspace:GetAttribute("flip")', timeout_s: 30 };

    const first = tools.evalServerRuntime(undefined, 'instance:solo', undefined, wait);
    await jest.advanceTimersByTimeAsync(1000);
    const pending = parse(await first);
    expect(pending).toMatchObject({ state: 'pending', tool: 'eval_server_runtime', action: 'wait_until', requestId: expect.stringMatching(/^eval_server_runtime-/) });

    const repeat = tools.evalServerRuntime(undefined, 'instance:solo', undefined, wait);
    await jest.advanceTimersByTimeAsync(1000);
    expect(parse(await repeat)).toMatchObject({ state: 'pending', requestId: pending.requestId, joinedRunningCall: true });

    flipped = true;
    const status = tools.getRequestStatus(pending.requestId, 5000);
    await jest.advanceTimersByTimeAsync(500);
    const result = await status;
    expect(parse(result)).toMatchObject({ requestId: pending.requestId, state: 'completed', outcome: 'result' });
    expect(JSON.parse(result.content[1].text ?? '{}')).toMatchObject({ satisfied: true, value: 'true' });
  });

  test('a get_request_status wait is capped by the response budget', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_MCP_RESPONSE_BUDGET_MS: '1000' });
    const { tools } = setup(() => ({ bridge: 'ok', ok: true, result: 'Ffalse' }));
    const first = tools.evalServerRuntime(undefined, 'instance:solo', undefined, { wait_until: 'false', timeout_s: 30 });
    await jest.advanceTimersByTimeAsync(1000);
    const { requestId } = parse(await first);

    let settled = false;
    const status = tools.getRequestStatus(requestId, 20_000).finally(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    expect(parse(await status)).toMatchObject({ requestId, state: 'pending' });
  });
});

describe('playtest lifecycle response budget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_MCP_RESPONSE_BUDGET_MS: '1000' });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('a slow solo_playtest stop returns pending, a repeat joins it without a second stop, and the status returns the result', async () => {
    const stop = Promise.withResolvers<Reply>();
    const { bridge, tools, request } = setup((endpoint) => endpoint === '/api/stop-playtest' ? stop.promise : {});

    const first = tools.soloPlaytest('stop', undefined, undefined, 'instance:solo');
    await jest.advanceTimersByTimeAsync(1000);
    const pending = parse(await first);
    expect(pending).toMatchObject({ state: 'pending', tool: 'solo_playtest', action: 'stop', requestId: expect.stringMatching(/^solo_playtest-/) });

    const repeat = tools.soloPlaytest('stop', undefined, undefined, 'instance:solo');
    await jest.advanceTimersByTimeAsync(1000);
    expect(parse(await repeat)).toMatchObject({ state: 'pending', requestId: pending.requestId, joinedRunningCall: true });
    expect(request.mock.calls.filter(([endpoint]) => endpoint === '/api/stop-playtest')).toHaveLength(1);

    bridge.unregisterPeer('peer:server');
    bridge.unregisterPeer('peer:client-1');
    stop.resolve({ success: true });
    const status = tools.getRequestStatus(pending.requestId, 5000);
    await jest.advanceTimersByTimeAsync(1000);
    const result = await status;
    expect(parse(result)).toMatchObject({ requestId: pending.requestId, state: 'completed', outcome: 'result', tool: 'solo_playtest', action: 'stop' });
    expect(JSON.parse(result.content[1].text ?? '{}')).toEqual({ success: true, action: 'stop', message: 'Playtest stopped.' });
  });
});

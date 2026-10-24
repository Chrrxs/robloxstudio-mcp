import request from 'supertest';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer, TOOL_HANDLERS } from '../http-server.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

class RecoveryTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

type ToolResult = { content: Array<{ text?: string }> };

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as ToolResult).content[0].text ?? '');
}

const MAIN = 'game.ServerScriptService.Main';

// Write tools whose retries join one retained operation, called the way an MCP
// client calls them. transport is the Peer the request is delivered to.
const RECOVERABLE_WRITES: Array<[string, string, Record<string, unknown>]> = [
  ['set_script_source', 'edit', { instancePath: MAIN, source: 'return 2\n', expected_revision: '9:1' }],
  ['insert_script_lines', 'edit', { instancePath: MAIN, afterLine: 1, newContent: 'print(1)', expected_revision: '9:1' }],
  ['delete_script_lines', 'edit', { instancePath: MAIN, line_range: '2', expected_revision: '9:1' }],
  ['find_and_replace_in_scripts', 'edit', { pattern: 'a', replacement: 'b', expected_revisions: { [MAIN]: '9:1' } }],
  ['insert_asset', 'edit', { assetId: 123 }],
  ['import_rbxm', 'edit', { source: { base64: 'cmJ4bSBieXRlcw==' }, parent_path: 'game.Workspace' }],
  ['eval_server_runtime', 'server', { code: 'return 42' }],
  ['eval_client_runtime', 'client', { code: 'return 42' }],
];

describe('mutation recovery tools', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new RecoveryTestBridge();
    tools = new RobloxStudioTools(bridge);
    expect(bridge.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:recovery',
      role: 'edit', placeId: 0, placeName: 'Recovery',
    }).ok).toBe(true);
    // Separate live server and client, so instance:recovery keeps selecting its edit Peer.
    for (const [peerId, instanceId, role] of [['server', 'instance:runtime', 'server'], ['client', 'instance:client', 'client-1']]) {
      expect(bridge.registerPeer({
        peerId, transportPeerId: peerId, instanceId, role, placeId: 0, placeName: 'Runtime',
      }).ok).toBe(true);
    }
  });
  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test.each(['execute_luau', 'set_properties', 'edit_script_lines'])('%s recovers a late result using caller operation identity', async tool => {
    const operationId = `recovery-${tool}`;
    const invoke = () => {
      if (tool === 'execute_luau') return tools.executeLuau('return 42', 'edit', 'instance:recovery', operationId);
      if (tool === 'set_properties') {
        return tools.setProperties('game.Workspace.Text', { Value: 'recipe' }, 'instance:recovery', operationId);
      }
      return tools.editScriptLines(MAIN, [
        { oldString: 'local a = 1', newString: 'local a = 1\nlocal b = 2' },
        { oldString: 'return a', newString: 'return a + b' },
      ], { expectedRevision: '24:1' }, 'instance:recovery', operationId);
    };
    const original = invoke();
    const timedOut = expect(original).rejects.toThrow(operationId);
    const delivery = bridge.claimNextRequestForTransport('edit', 'socket');
    expect(delivery?.requestId).toBe(operationId);
    await jest.advanceTimersByTimeAsync(30_000);
    await timedOut;
    const unknown = await tools.getRequestStatus(operationId);
    expect(JSON.parse(unknown.content[0].text)).toMatchObject({ requestId: operationId, outcome: 'unknown' });
    expect(bridge.settleTransportResponse('wrong-peer', operationId, { success: true })).toBe('unknown');
    expect(bridge.settleTransportResponse('edit', operationId, { success: true, value: 42 })).toBe('accepted');
    const recovered = await tools.getRequestStatus(operationId);
    expect(JSON.parse(recovered.content[0].text)).toMatchObject({
      requestId: operationId, outcome: 'success', response: { success: true, value: 42 },
    });
    const replay = await invoke();
    expect(JSON.parse(replay.content[0].text)).toEqual({ success: true, value: 42 });
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
  });

  test.each(RECOVERABLE_WRITES)('%s: a retry after a lost response recovers the first result without a second mutation', async (tool, transport, args) => {
    const operationId = `recovery-${tool}`;
    const instanceId = { server: 'instance:runtime', client: 'instance:client' }[transport] ?? 'instance:recovery';
    const invoke = (overrides: Record<string, unknown> = {}) =>
      TOOL_HANDLERS[tool](tools, { ...args, ...overrides, operation_id: operationId, instance_id: instanceId });

    const original = invoke();
    const timedOut = expect(original).rejects.toThrow(operationId);
    await jest.advanceTimersByTimeAsync(0);
    const delivery = bridge.claimNextRequestForTransport(transport, 'socket');
    expect(delivery?.requestId).toBe(operationId);
    // The response is lost: the caller's wait ends while Studio is executing.
    await jest.advanceTimersByTimeAsync(30_000);
    await timedOut;
    expect(bridge.settleTransportResponse(transport, operationId, { success: true, applied: tool })).toBe('accepted');

    expect(parse(await invoke())).toEqual({ success: true, applied: tool });
    // The same ID with different arguments is refused before anything is sent.
    const changed = tool === 'import_rbxm'
      ? { source: { base64: 'b3RoZXIgYnl0ZXM=' } }
      : { code: 'return 43', source: 'return 3\n', afterLine: 2, line_range: '3', replacement: 'c', assetId: 124 };
    await expect(invoke(changed)).rejects.toMatchObject({ code: 'operation_id_collision' });
    expect(bridge.claimNextRequestForTransport(transport, 'socket')).toBeNull();
  });

  test('after the retention window a retry is a new operation, as documented', async () => {
    const args = { instancePath: MAIN, afterLine: 1, newContent: 'print(1)', operation_id: 'expiring', instance_id: 'instance:recovery' };
    const first = TOOL_HANDLERS.insert_script_lines(tools, args);
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')?.requestId).toBe('expiring');
    bridge.settleTransportResponse('edit', 'expiring', { success: true });
    await first;

    await jest.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(JSON.parse((await tools.getRequestStatus('expiring')).content[0].text)).toMatchObject({ state: 'unknown', outcome: 'unknown' });
    const retry = TOOL_HANDLERS.insert_script_lines(tools, args);
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')?.requestId).toBe('expiring');
    bridge.settleTransportResponse('edit', 'expiring', { success: true });
    await retry;
  });

  test('revisions and plan bindings reach the plugin only when supplied', async () => {
    const dispatched = async (tool: string, args: Record<string, unknown>) => {
      const pending = TOOL_HANDLERS[tool](tools, { ...args, instance_id: 'instance:recovery' });
      await jest.advanceTimersByTimeAsync(0);
      const delivery = bridge.claimNextRequestForTransport('edit', 'socket');
      bridge.settleTransportResponse('edit', delivery!.requestId, { success: true });
      await pending;
      return delivery!.data;
    };

    expect(await dispatched('delete_script_lines', { instancePath: MAIN, line_range: '2-3' }))
      .toEqual({ instancePath: MAIN, startLine: 2, endLine: 3 });
    expect(await dispatched('delete_script_lines', { instancePath: MAIN, line_range: '2', expected_revision: '9:1' }))
      .toEqual({ instancePath: MAIN, startLine: 2, endLine: 2, expectedRevision: '9:1' });
    expect(await dispatched('set_script_source', { instancePath: MAIN, source: 'x', expected_revision: '9:1' }))
      .toEqual({ instancePath: MAIN, source: 'x', expectedRevision: '9:1' });
    expect(await dispatched('find_and_replace_in_scripts', {
      pattern: 'a', replacement: 'b', dryRun: false, classFilter: 'LocalScript', expected_revisions: { [MAIN]: '9:1' },
    })).toMatchObject({ pattern: 'a', replacement: 'b', classFilter: 'LocalScript', expectedRevisions: { [MAIN]: '9:1' } });
  });

  test.each([
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b', classFilter: 'Scripts' }, 'classFilter must be one of Script, LocalScript, ModuleScript'],
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b', maxReplacements: 0 }, 'maxReplacements must be a positive integer'],
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b', expected_revisions: [] }, 'expected_revisions must map'],
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b', expected_revisions: { [MAIN]: 9 } }, 'expected_revisions must map'],
    ['grep_scripts', { pattern: 'a', classFilter: 'script' }, 'classFilter must be one of'],
    ['insert_script_lines', { instancePath: MAIN, newContent: 'x', expected_revision: '' }, 'expected_revision must be a nonempty string'],
    ['import_rbxm', { source: { base64: 'cmJ4bQ==' }, parent_path: 'game.Workspace', operation_id: ' ' }, 'operation_id must be a nonblank string'],
  ])('%s rejects %j before dispatch', async (tool, args, message) => {
    await expect(TOOL_HANDLERS[tool](tools, { ...args, instance_id: 'instance:recovery' })).rejects.toThrow(message);
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('unknown and expired IDs never claim the mutation was unexecuted', async () => {
    const result = await tools.getRequestStatus('unknown');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ state: 'unknown', outcome: 'unknown' });
    await expect(tools.getRequestStatus('')).rejects.toThrow('request_id');
  });

  test('after a server restart a lost operation is unknown, never unexecuted, and a retry runs anew', async () => {
    const args = { instancePath: MAIN, line_range: '2', expected_revision: '9:1', operation_id: 'across-restart', instance_id: 'instance:recovery' };
    const first = TOOL_HANDLERS.delete_script_lines(tools, args);
    const firstFailed = expect(first).rejects.toThrow('across-restart');
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')?.requestId).toBe('across-restart');
    await jest.advanceTimersByTimeAsync(30_000);
    await firstFailed;

    // The operation store lives in the server process; a restart loses it.
    const restarted = new RecoveryTestBridge();
    const restartedTools = new RobloxStudioTools(restarted);
    expect(restarted.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:recovery', role: 'edit', placeId: 0, placeName: 'Recovery',
    }).ok).toBe(true);
    try {
      expect(JSON.parse((await restartedTools.getRequestStatus('across-restart')).content[0].text))
        .toMatchObject({ state: 'unknown', outcome: 'unknown' });
      // Only the plugin's revision check can stop this retry from deleting again.
      const retry = TOOL_HANDLERS.delete_script_lines(restartedTools, args);
      await jest.advanceTimersByTimeAsync(0);
      const delivery = restarted.claimNextRequestForTransport('edit', 'socket');
      expect(delivery).toMatchObject({ requestId: 'across-restart', data: { expectedRevision: '9:1' } });
      restarted.settleTransportResponse('edit', 'across-restart', { code: 'revision_mismatch' });
      expect(parse(await retry)).toEqual({ code: 'revision_mismatch' });
    } finally {
      restarted.clearAllPendingRequests();
    }
  });
});

describe('script write preconditions through a proxy', () => {
  // An older primary's plugin ignores expectedRevision(s) and writes part of a
  // bulk plan before finding the cap; its /topology lacks script_preconditions.
  async function withProxy(
    options: { olderPrimary?: boolean; dropFirstProxyResponse?: boolean },
    run: (context: {
      primary: BridgeService; proxyTools: RobloxStudioTools; proxyBodies: Record<string, unknown>[]; dispatched: string[];
    }) => Promise<void>,
  ): Promise<void> {
    const primary = new RecoveryTestBridge();
    expect(primary.registerPeer({
      peerId: 'edit', transportPeerId: 'edit', instanceId: 'instance:proxy', role: 'edit', placeId: 0, placeName: 'Proxy',
    }).ok).toBe(true);
    // Answers each request the primary admits, as Studio would.
    const dispatched: string[] = [];
    const send = primary.sendRequest.bind(primary);
    jest.spyOn(primary, 'sendRequest').mockImplementation((...args) => {
      const response = send(...args);
      const claimed = primary.claimNextRequestForTransport('edit', 'socket');
      if (claimed) {
        dispatched.push(claimed.requestId);
        primary.settleTransportResponse('edit', claimed.requestId, { success: true, data: claimed.data });
      }
      return response;
    });
    let dropResponse = options.dropFirstProxyResponse === true;
    const app = createHttpServer(new RobloxStudioTools(primary), primary);
    const proxyBodies: Record<string, unknown>[] = [];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      if (init?.method === 'POST') proxyBodies.push(JSON.parse(String(init.body)));
      const response = init?.method === 'POST'
        ? await request(app).post(path).set('Content-Type', 'application/json').send(String(init.body))
        : await request(app).get(path);
      if (dropResponse && url.pathname === '/proxy') {
        // The primary executed the request; its answer is lost on the way back.
        dropResponse = false;
        throw new TypeError('fetch failed: connection reset');
      }
      let text = response.text;
      if (options.olderPrimary && url.pathname === '/topology') {
        const topology = JSON.parse(text);
        topology.proxyFeatures = ['submit', 'identity', 'status_wait'];
        text = JSON.stringify(topology);
      }
      return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
    });
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      await run({ primary, proxyTools: new RobloxStudioTools(proxy), proxyBodies, dispatched });
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
      primary.clearAllPendingRequests();
      await app.cleanup();
    }
  }

  test('a current primary receives the revision and the caller operation ID', async () => {
    await withProxy({}, async ({ proxyTools, proxyBodies }) => {
      const result = parse(await TOOL_HANDLERS.delete_script_lines(proxyTools, {
        instancePath: MAIN, line_range: '2', expected_revision: '9:1', operation_id: 'proxied-delete', instance_id: 'instance:proxy',
      }));
      expect(result).toMatchObject({ success: true, data: { expectedRevision: '9:1' } });
      expect(proxyBodies).toEqual([expect.objectContaining({ operationId: 'proxied-delete' })]);
    });
  });

  test('a retry through the proxy recovers a result whose response was lost, without a second mutation', async () => {
    await withProxy({ dropFirstProxyResponse: true }, async ({ proxyTools, proxyBodies, dispatched }) => {
      const args = { instancePath: MAIN, afterLine: 1, newContent: 'print(1)', expected_revision: '9:1', operation_id: 'proxied-insert', instance_id: 'instance:proxy' };

      await expect(TOOL_HANDLERS.insert_script_lines(proxyTools, args)).rejects.toThrow('proxied-insert');
      const retried = parse(await TOOL_HANDLERS.insert_script_lines(proxyTools, args));

      expect(retried).toMatchObject({ success: true, data: { newContent: 'print(1)', expectedRevision: '9:1' } });
      expect(proxyBodies).toHaveLength(2);
      expect(dispatched).toEqual(['proxied-insert']);
      await expect(TOOL_HANDLERS.insert_script_lines(proxyTools, { ...args, afterLine: 2 }))
        .rejects.toMatchObject({ code: 'operation_id_collision' });
      expect(dispatched).toEqual(['proxied-insert']);
    });
  });

  test.each([
    ['delete_script_lines', { instancePath: MAIN, line_range: '2', expected_revision: '9:1' }, 'expected_revision'],
    ['set_script_source', { instancePath: MAIN, source: 'x', expected_revision: '9:1' }, 'expected_revision'],
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b', expected_revisions: { [MAIN]: '9:1' } }, 'expected_revisions'],
  ])('an older primary refuses %s %j before it reaches Studio', async (tool, args, argument) => {
    await withProxy({ olderPrimary: true }, async ({ proxyTools, proxyBodies }) => {
      await expect(TOOL_HANDLERS[tool](proxyTools, { ...args, instance_id: 'instance:proxy' }))
        .rejects.toMatchObject({ code: 'primary_unsupported', message: expect.stringContaining(`ignores ${argument}`) });
      expect(proxyBodies).toEqual([]);
    });
  });

  test.each([
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b' }],
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b', dryRun: true }],
    ['find_and_replace_in_scripts', { pattern: 'a', replacement: 'b', dryRun: true, expected_revisions: { [MAIN]: '9:1' } }],
    ['delete_script_lines', { instancePath: MAIN, line_range: '2' }],
  ])('an older primary still serves %s %j, which asks for no precondition it would skip', async (tool, args) => {
    await withProxy({ olderPrimary: true }, async ({ proxyTools, proxyBodies }) => {
      expect(parse(await TOOL_HANDLERS[tool](proxyTools, { ...args, instance_id: 'instance:proxy' })).success).toBe(true);
      expect(proxyBodies).toHaveLength(1);
    });
  });
});

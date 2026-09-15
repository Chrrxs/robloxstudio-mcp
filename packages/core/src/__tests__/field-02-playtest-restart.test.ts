// Field report #2: solo_playtest action="restart" against a fake bridge; the test resolves the
// queued plugin requests (stop, execute-luau, start) and registers runtime peers by hand.
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';

const EDIT_PEER = {
  peerId: 'edit-1',
  transportPeerId: 'edit-1',
  instanceId: 'instance:restart',
  role: 'edit',
  placeId: 0,
  placeName: 'RestartPlace.rbxl',
  dataModelName: 'RestartPlace',
  isRunning: false,
  pluginVersion: 'test-version',
  pluginVariant: 'main',
  timestamp: Date.now(),
};

function runtimePeer(role: 'server' | 'client', peerId: string, transportPeerId = 'server-1') {
  return { ...EDIT_PEER, peerId, transportPeerId, role, isRunning: true };
}

async function claimQueued(bridge: BridgeService, transportPeerId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const queued = bridge.claimNextRequestForTransport(transportPeerId, 'restart-test');
    if (queued) return queued;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`No queued request for ${transportPeerId}`);
}

function parse(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? '{}') as Record<string, unknown>;
}

describe('field #2 solo_playtest restart', () => {
  test('schema exposes restart, optional mode and before_start', () => {
    const schema = TOOL_DEFINITIONS.find((tool) => tool.name === 'solo_playtest')!.inputSchema as {
      properties: Record<string, { enum?: string[]; type?: string }>;
    };
    expect(schema.properties.action.enum).toContain('restart');
    expect(schema.properties.before_start?.type).toBe('string');
  });

  test('restart stops, runs before_start on the edit peer, then starts with the previous mode', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT_PEER);
    bridge.registerPeer(runtimePeer('server', 'server-1'));
    bridge.registerPeer(runtimePeer('client', 'client-1'));

    const resultPromise = tools.soloPlaytest('restart', undefined, 5, EDIT_PEER.instanceId, 'return workspace.Name');
    const endpoints: string[] = [];

    const stop = await claimQueued(bridge, 'edit-1');
    endpoints.push(stop.endpoint);
    bridge.resolveRequest(stop.requestId, { success: true, message: 'Playtest stopped.' });
    bridge.unregisterPeer('server-1');

    const luau = await claimQueued(bridge, 'edit-1');
    endpoints.push(luau.endpoint);
    expect(luau.data).toMatchObject({ code: 'return workspace.Name' });
    bridge.resolveRequest(luau.requestId, { success: true, returnValue: 'Workspace' });

    const start = await claimQueued(bridge, 'edit-1');
    endpoints.push(start.endpoint);
    expect(start.data).toMatchObject({ mode: 'play' });
    bridge.resolveRequest(start.requestId, { success: true, message: 'started' });
    bridge.registerPeer(runtimePeer('server', 'server-2', 'server-2'));
    bridge.registerPeer(runtimePeer('client', 'client-2', 'server-2'));

    const body = parse(await resultPromise);
    expect(endpoints).toEqual(['/api/stop-playtest', '/api/execute-luau', '/api/start-playtest']);
    expect(body).toMatchObject({
      success: true,
      action: 'restart',
      mode: 'play',
      wasRunning: true,
      beforeStart: { success: true, returnValue: 'Workspace' },
      roles: ['edit', 'server', 'client-1'],
    });
    expect(typeof body.stoppedInMs).toBe('number');
    expect(typeof body.startedInMs).toBe('number');
    expect(body.totalMs as number).toBeGreaterThanOrEqual(body.stoppedInMs as number);
  });

  test('restart with only a server peer preserves run mode', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT_PEER);
    bridge.registerPeer(runtimePeer('server', 'server-1'));

    const resultPromise = tools.soloPlaytest('restart', undefined, 5, EDIT_PEER.instanceId);
    const stop = await claimQueued(bridge, 'edit-1');
    bridge.resolveRequest(stop.requestId, { success: true });
    bridge.unregisterPeer('server-1');
    const start = await claimQueued(bridge, 'edit-1');
    expect(start.endpoint).toBe('/api/start-playtest');
    expect(start.data).toMatchObject({ mode: 'run' });
    bridge.resolveRequest(start.requestId, { success: true });
    bridge.registerPeer(runtimePeer('server', 'server-2', 'server-2'));

    expect(parse(await resultPromise)).toMatchObject({ success: true, mode: 'run', wasRunning: true });
  });

  test('restart without an active playtest is a plain start that reuses the last mode', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT_PEER);

    const firstStart = tools.soloPlaytest('start', 'run', 5, EDIT_PEER.instanceId);
    const first = await claimQueued(bridge, 'edit-1');
    bridge.resolveRequest(first.requestId, { success: true });
    bridge.registerPeer(runtimePeer('server', 'server-1'));
    expect(parse(await firstStart).success).toBe(true);
    bridge.unregisterPeer('server-1');

    const resultPromise = tools.soloPlaytest('restart', undefined, 5, EDIT_PEER.instanceId);
    const start = await claimQueued(bridge, 'edit-1');
    expect(start.endpoint).toBe('/api/start-playtest');
    expect(start.data).toMatchObject({ mode: 'run' });
    bridge.resolveRequest(start.requestId, { success: true });
    bridge.registerPeer(runtimePeer('server', 'server-2', 'server-2'));

    expect(parse(await resultPromise)).toMatchObject({
      success: true, action: 'restart', mode: 'run', wasRunning: false, stoppedInMs: 0,
    });
  });

  test('restart with no active playtest and no known mode fails before touching Studio', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT_PEER);

    await expect(tools.soloPlaytest('restart', undefined, 5, EDIT_PEER.instanceId)).rejects.toThrow(/mode/);
    expect(bridge.claimNextRequestForTransport('edit-1', 'restart-test')).toBeNull();
  });

  test('restart reports a before_start failure and does not start', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerPeer(EDIT_PEER);
    bridge.registerPeer(runtimePeer('server', 'server-1'));

    const resultPromise = tools.soloPlaytest('restart', undefined, 5, EDIT_PEER.instanceId, 'error("boom")');
    const stop = await claimQueued(bridge, 'edit-1');
    bridge.resolveRequest(stop.requestId, { success: true });
    bridge.unregisterPeer('server-1');
    const luau = await claimQueued(bridge, 'edit-1');
    bridge.resolveRequest(luau.requestId, { success: false, error: 'boom' });

    const body = parse(await resultPromise);
    expect(body).toMatchObject({ success: false, action: 'restart', wasRunning: true, error: 'before_start_failed' });
    expect(body.beforeStart).toMatchObject({ success: false, error: 'boom' });
    expect(bridge.claimNextRequestForTransport('edit-1', 'restart-test')).toBeNull();
  });
});

import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';

function register(bridge: BridgeService, instanceId: string, role: string, group?: string) {
  const peerId = `peer:${instanceId}:${role}`;
  const result = bridge.registerPeer({
    peerId, transportPeerId: peerId, instanceId, role, multiplayerGroupId: group,
    placeId: 123, placeName: 'Same Place', dataModelName: 'Same Place', isRunning: role !== 'edit',
  });
  if (!result.ok) throw new Error(result.error.message);
  return peerId;
}

describe('explicit runtime viewport targeting', () => {
  let lastTools: RobloxStudioTools | undefined;
  beforeEach(() => {
    // Synthetic topology only; never inspect the user's managed Studio state.
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });
  afterEach(async () => {
    if (lastTools) await (lastTools as unknown as { managedConnectionAssociations: Promise<void> }).managedConnectionAssociations;
    jest.restoreAllMocks();
  });

  function setup() {
    const bridge = new BridgeService();
    register(bridge, 'instance:controller', 'edit');
    bridge.createMultiplayerGroup('group:four', 'instance:controller');
    register(bridge, 'instance:server', 'server', 'group:four');
    for (const index of [4, 2, 3, 1]) register(bridge, `instance:player${index}`, `client-${index}`, 'group:four');
    const request = jest.spyOn(StudioHttpClient.prototype, 'request').mockImplementation(async (endpoint) => {
      if (endpoint !== '/api/capture-studio') return { success: true };
      return {
        success: true, source: 'StudioCaptureService', encoding: 'rgba8', width: 2, height: 1,
        data: Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]).toString('base64'),
      };
    });
    lastTools = new RobloxStudioTools(bridge);
    return { bridge, request, tools: lastTools };
  }

  test.each([1, 2, 3, 4])('captures the explicitly selected client-%i role alias', async (index) => {
    const { tools, request } = setup();
    const result = await tools.captureScreenshot(`instance:player${index}-client-${index}`, 'png');
    expect(result.content.some((entry) => entry.type === 'image')).toBe(true);
    expect(request.mock.calls.map(([endpoint, , peer]) => [endpoint, peer])).toEqual([
      ['/api/capture-studio', `peer:instance:player${index}:client-${index}`],
    ]);
  });

  test.each([1, 2, 3, 4])('captures the explicitly selected client-%i process ID', async (index) => {
    const { tools, request } = setup();
    await tools.captureScreenshot(`instance:player${index}`, 'png');
    expect(request.mock.calls[0][2]).toBe(`peer:instance:player${index}:client-${index}`);
  });

  test.each([undefined, 'instance:controller', 'instance:server-server'])('preserves first-client fallback for %s', async (id) => {
    const { tools, request } = setup();
    await tools.captureScreenshot(id, 'png');
    expect(request.mock.calls[0][2]).toBe('peer:instance:player1:client-1');
  });

  test('rejects an unknown or stale client alias instead of selecting another client', async () => {
    const { tools, request, bridge } = setup();
    await expect(tools.captureScreenshot('instance:missing-client-2', 'png')).rejects.toThrow(/not connected/);
    bridge.unregisterPeer('peer:instance:player3:client-3');
    await expect(tools.captureScreenshot('instance:player3-client-3', 'png')).rejects.toThrow(/not connected/);
    expect(request).not.toHaveBeenCalled();
  });

  test('rejects omitted instance when a second scope is connected', async () => {
    const { tools, request, bridge } = setup();
    register(bridge, 'instance:other', 'edit');
    await expect(tools.captureScreenshot(undefined, 'png')).rejects.toThrow(/Multiple Studio/);
    expect(request).not.toHaveBeenCalled();
  });

  test('retains the idle edit peer when no client exists', async () => {
    const { tools, request, bridge } = setup();
    for (const peer of [...bridge.getPeers()]) bridge.unregisterPeer(peer.peerId);
    const edit = register(bridge, 'instance:idle', 'edit');
    await tools.captureScreenshot('instance:idle', 'png');
    expect(request.mock.calls[0][2]).toBe(edit);
  });

  test('mouse and keyboard follow an explicit client alias without a redundant target', async () => {
    const { tools, request } = setup();
    await tools.simulateMouseInput('click', 10, 20, undefined, undefined, undefined, 'instance:player3-client-3');
    await tools.simulateKeyboardInput('Space', 'press', undefined, undefined, undefined, 'instance:player3-client-3');
    expect(request.mock.calls.map(([endpoint, , peer]) => [endpoint, peer])).toEqual([
      ['/api/simulate-mouse-input', 'peer:instance:player3:client-3'],
      ['/api/simulate-keyboard-input', 'peer:instance:player3:client-3'],
    ]);
  });

  test('preserves explicit eval_client_runtime and input role overrides', async () => {
    const { tools, request } = setup();
    await tools.evalClientRuntime('return 1', 'client-4', 'instance:player4-client-4');
    await tools.simulateMouseInput('click', 10, 20, undefined, undefined, 'client-2', 'instance:controller');
    expect(request.mock.calls.map(([endpoint, , peer]) => [endpoint, peer])).toEqual([
      ['/api/eval-runtime', 'peer:instance:player4:client-4'],
      ['/api/simulate-mouse-input', 'peer:instance:player2:client-2'],
    ]);
  });
});

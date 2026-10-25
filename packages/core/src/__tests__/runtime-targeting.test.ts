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

  test('forwards move and the scroll wheel delta to the client', async () => {
    const { tools, request } = setup();
    await tools.simulateMouseInput('scroll', 30, 40, undefined, -3, 'client-2', 'instance:controller');
    await tools.simulateMouseInput('move', 50, 60, undefined, undefined, 'client-2', 'instance:controller');
    expect(request.mock.calls.map(([endpoint, data, peer]) => [endpoint, data, peer])).toEqual([
      ['/api/simulate-mouse-input', { action: 'scroll', x: 30, y: 40, button: undefined, wheel: -3 }, 'peer:instance:player2:client-2'],
      ['/api/simulate-mouse-input', { action: 'move', x: 50, y: 60, button: undefined, wheel: undefined }, 'peer:instance:player2:client-2'],
    ]);
  });

  test.each([undefined, 0, Number.NaN])('rejects scroll with wheel %p before contacting Studio', async (wheel) => {
    const { tools, request } = setup();
    await expect(tools.simulateMouseInput('scroll', 30, 40, undefined, wheel, 'client-2', 'instance:controller'))
      .rejects.toThrow(/wheel must be a non-zero number/);
    expect(request).not.toHaveBeenCalled();
  });

  test.each([1, 2, 3, 4])('eval_client_runtime follows the client-%i alias without a redundant target', async (index) => {
    const { tools, request } = setup();
    await tools.evalClientRuntime('return 1', undefined, `instance:player${index}-client-${index}`);
    await tools.evalClientRuntime('return 1', undefined, `instance:player${index}`);
    expect(request.mock.calls.map(([endpoint, , peer]) => [endpoint, peer])).toEqual([
      ['/api/eval-runtime', `peer:instance:player${index}:client-${index}`],
      ['/api/eval-runtime', `peer:instance:player${index}:client-${index}`],
    ]);
  });

  test.each([undefined, 'instance:controller', 'instance:server-server'])('eval_client_runtime keeps the client-1 default for %s', async (id) => {
    const { tools, request } = setup();
    await tools.evalClientRuntime('return 1', undefined, id);
    expect(request.mock.calls[0][2]).toBe('peer:instance:player1:client-1');
  });

  test('eval_client_runtime rejects a target that contradicts the client alias', async () => {
    const { tools, request } = setup();
    await expect(tools.evalClientRuntime('return 1', 'client-3', 'instance:player2-client-2'))
      .rejects.toMatchObject({ routingError: { code: 'ambiguous_target' } });
    expect(request).not.toHaveBeenCalled();
  });

  describe('solo playtest without an edit peer', () => {
    function setupSolo(roles: string[]) {
      const bridge = new BridgeService();
      for (const role of roles) register(bridge, 'instance:solo', role);
      // Two distinct pixels: a single-colour frame would send the capture to
      // the real host-window fallback, which this routing test must not reach.
      const request = jest.spyOn(StudioHttpClient.prototype, 'request').mockImplementation(async () => ({
        success: true, source: 'StudioCaptureService', encoding: 'rgba8', width: 2, height: 1,
        data: Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]).toString('base64'),
      }));
      lastTools = new RobloxStudioTools(bridge);
      return { request, tools: lastTools };
    }

    test.each([undefined, 'instance:solo'])('captures the client viewport for %s', async (id) => {
      const { tools, request } = setupSolo(['server', 'client-1']);
      const result = await tools.captureScreenshot(id, 'png');
      expect(result.content.some((entry) => entry.type === 'image')).toBe(true);
      expect(request.mock.calls[0][2]).toBe('peer:instance:solo:client-1');
    });

    test('routes viewport input to the client', async () => {
      const { tools, request } = setupSolo(['server', 'client-1']);
      await tools.simulateMouseInput('click', 10, 20, undefined, undefined, undefined, 'instance:solo');
      await tools.simulateKeyboardInput('Space', 'press', undefined, undefined, 'client-1', 'instance:solo');
      expect(request.mock.calls.map(([, , peer]) => peer)).toEqual([
        'peer:instance:solo:client-1',
        'peer:instance:solo:client-1',
      ]);
    });
  });

  describe('a Peer-naming instance_id selects that Peer for every targeted tool', () => {
    type Call = (tools: RobloxStudioTools, id: string, target?: string) => Promise<unknown>;
    const CLIENT_TWO = 'instance:player2-client-2';
    const SERVER = 'instance:server-server';
    const peer = (role: string) => role === 'edit'
      ? 'peer:instance:controller:edit'
      : role === 'server' ? 'peer:instance:server:server' : `peer:instance:player${role.slice('client-'.length)}:${role}`;
    const tools: Record<string, Call> = {
      execute_luau: (t, id, target) => t.executeLuau('return 1', target, id),
      eval_client_runtime: (t, id, target) => t.evalClientRuntime('return 1', target, id),
      set_network_profile: (t, id, target) => t.setNetworkProfile('poor', target, undefined, id),
      get_simulation_state: (t, id, target) => t.getSimulationState('network', target, id),
      reset_simulation_state: (t, id, target) => t.resetSimulationState(target, true, false, id),
      get_device_simulator_state: (t, id, target) => t.getDeviceSimulatorState(target, undefined, false, id),
      set_device_simulator: (t, id, target) => t.setDeviceSimulator(target, undefined, undefined, undefined, undefined, undefined, true, id),
      capture_script_profiler: (t, id, target) => t.captureScriptProfiler(target, {}, id),
      breakpoints: (t, id, target) => t.breakpoints('list', {}, target, id),
      get_memory_breakdown: (t, id, target) => t.getMemoryBreakdown(target, undefined, id),
      get_scene_analysis: (t, id, target) => t.getSceneAnalysis(undefined, target, undefined, undefined, id),
      export_rbxm: (t, id, target) => t.exportRbxm(['game.Workspace'], '/tmp/rsmcp-unused.rbxm', target, id),
      simulate_mouse_input: (t, id, target) => t.simulateMouseInput('click', 1, 1, undefined, undefined, target, id),
      simulate_keyboard_input: (t, id, target) => t.simulateKeyboardInput('Space', 'press', undefined, undefined, target, id),
    };
    const peersFor = (request: jest.SpyInstance) => [...new Set(request.mock.calls.map((call) => call[2]))];

    // Expected role per tool for [client-2 id, server id] without a target. Tools that
    // cannot act on the named role keep their scope default.
    const expected: Record<string, [string, string | string[]]> = {
      execute_luau: ['client-2', 'server'],
      eval_client_runtime: ['client-2', 'client-1'],
      set_network_profile: ['client-2', 'client-1'],
      get_simulation_state: ['client-2', ['edit', 'client-1', 'client-2', 'client-3', 'client-4']],
      reset_simulation_state: ['client-2', ['edit', 'client-1', 'client-2', 'client-3', 'client-4']],
      get_device_simulator_state: ['client-2', 'edit'],
      set_device_simulator: ['client-2', 'edit'],
      capture_script_profiler: ['client-2', 'server'],
      breakpoints: ['client-2', 'server'],
      get_memory_breakdown: ['client-2', 'server'],
      get_scene_analysis: ['client-2', 'server'],
      export_rbxm: ['edit', 'server'],
      simulate_mouse_input: ['client-2', 'client-1'],
      simulate_keyboard_input: ['client-2', 'client-1'],
    };

    test.each(Object.keys(tools))('%s defaults to the named Peer', async (name) => {
      const [clientRole, serverRoles] = expected[name];
      let setupResult = setup();
      await tools[name](setupResult.tools, CLIENT_TWO);
      expect(peersFor(setupResult.request)).toEqual([peer(clientRole)]);

      jest.restoreAllMocks();
      jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
      setupResult = setup();
      await tools[name](setupResult.tools, SERVER);
      const roles = Array.isArray(serverRoles) ? serverRoles : [serverRoles];
      expect(peersFor(setupResult.request).sort()).toEqual(roles.map(peer).sort());
    });

    test.each(Object.keys(tools).filter((name) => expected[name][0] === 'client-2'))(
      '%s rejects a target that contradicts the named client',
      async (name) => {
        const { tools: instance, request } = setup();
        await expect(tools[name](instance, CLIENT_TWO, 'client-3'))
          .rejects.toMatchObject({ routingError: { code: 'ambiguous_target' } });
        expect(request).not.toHaveBeenCalled();
      },
    );

    test('scope-wide targets still address the whole group', async () => {
      const { tools: instance, request } = setup();
      await instance.setNetworkProfile('poor', 'all-clients', undefined, CLIENT_TWO);
      expect(peersFor(request).sort()).toEqual(['client-1', 'client-2', 'client-3', 'client-4'].map(peer).sort());
    });

    test('multiplayer leave_client removes the named client, not client-1', async () => {
      const { tools: instance, request, bridge } = setup();
      request.mockImplementation(async (endpoint, _data, peerId) => {
        if (endpoint === '/api/multiplayer-test-leave-client' && typeof peerId === 'string') bridge.unregisterPeer(peerId);
        return { success: true };
      });
      const result = await instance.multiplayerPlaytest('leave_client', undefined, undefined, undefined, undefined, 5, CLIENT_TWO);
      expect(request.mock.calls[0].slice(0, 3)).toEqual(['/api/multiplayer-test-leave-client', {}, peer('client-2')]);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ success: true });
      expect(bridge.getPeerById(peer('client-1'))).toBeDefined();
    });

    test('multiplayer leave_client rejects a contradicting target', async () => {
      const { tools: instance, request } = setup();
      await expect(instance.multiplayerPlaytest('leave_client', undefined, 'client-1', undefined, undefined, 5, CLIENT_TWO))
        .rejects.toMatchObject({ routingError: { code: 'ambiguous_target' } });
      expect(request).not.toHaveBeenCalled();
    });
  });
});

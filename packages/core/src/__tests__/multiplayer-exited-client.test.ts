import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';

const SERVER = 'peer:instance:server:server';
const client = (index: number) => `peer:instance:player${index}:client-${index}`;
const TIMEOUT = {
  success: false,
  error: 'client_broker_timeout',
  message: 'client-1 did not answer /api/multiplayer-test-leave-client within 25.0 s.',
};

type Handler = (endpoint: string, data: unknown, peerId: unknown) => unknown;

function registerClient(bridge: BridgeService, index: number) {
  // Client Peers reach MCP through the server Peer's broker.
  const result = bridge.registerPeer({
    peerId: client(index), transportPeerId: SERVER, instanceId: `instance:player${index}`, role: `client-${index}`,
    multiplayerGroupId: 'group:two', placeId: 1, placeName: 'Place', dataModelName: 'Place', isRunning: true,
  });
  if (!result.ok) throw new Error(result.error.message);
}

describe('multiplayer client whose Studio process exited', () => {
  let lastTools: RobloxStudioTools | undefined;
  beforeEach(() => {
    // Synthetic topology only; never inspect the user's managed Studio state.
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });
  afterEach(async () => {
    if (lastTools) await (lastTools as unknown as { managedConnectionAssociations: Promise<void> }).managedConnectionAssociations;
    jest.restoreAllMocks();
  });

  function setup(handler: Handler) {
    const bridge = new BridgeService();
    for (const [peerId, instanceId, role, group] of [
      ['peer:instance:controller:edit', 'instance:controller', 'edit', undefined],
      [SERVER, 'instance:server', 'server', 'group:two'],
    ] as const) {
      if (role === 'server') bridge.createMultiplayerGroup('group:two', 'instance:controller');
      const result = bridge.registerPeer({
        peerId, transportPeerId: peerId, instanceId, role, multiplayerGroupId: group,
        placeId: 1, placeName: 'Place', dataModelName: 'Place', isRunning: role !== 'edit',
      });
      if (!result.ok) throw new Error(result.error.message);
    }
    registerClient(bridge, 1);
    registerClient(bridge, 2);
    // These clients joined well before any request in the test.
    for (const peer of bridge.getPeers()) peer.connectedAt -= 60_000;
    const request = jest.spyOn(StudioHttpClient.prototype, 'request')
      .mockImplementation(async (endpoint, data, peerId) => handler(endpoint, data, peerId) ?? { success: true });
    lastTools = new RobloxStudioTools(bridge);
    return { bridge, request, tools: lastTools };
  }

  const serverState = (clients: unknown[]) => ({ success: true, peer: 'server', players: [], playerCount: clients.length, clients });
  const roles = (bridge: BridgeService) => bridge.getPeers().map((peer) => peer.role).sort();
  const parse = (result: { content: { text?: string }[] }) => JSON.parse(result.content[0].text ?? '{}');

  test('leave_client treats a client whose Player is gone as already left', async () => {
    const { tools, bridge, request } = setup((endpoint, _data, peerId) => {
      if (endpoint === '/api/multiplayer-test-leave-client') return TIMEOUT;
      if (endpoint === '/api/multiplayer-test-state' && peerId === SERVER) {
        return serverState([{ peerId: client(2), role: 'client-2', player: 'Player2', playerPresent: true }]);
      }
      return undefined;
    });
    const result = parse(await tools.multiplayerPlaytest('leave_client', undefined, 'client-1', undefined, undefined, 5, 'instance:controller'));
    expect(result).toEqual({
      success: true,
      action: 'leave_client',
      message: 'client-1 had already left (its Player is no longer in the server); removed it.',
      roles: ['edit', 'server', 'client-2'],
    });
    expect(roles(bridge)).toEqual(['client-2', 'edit', 'server']);
    expect(request.mock.calls[0].slice(0, 3)).toEqual(['/api/multiplayer-test-leave-client', {}, client(1)]);

    const status = parse(await tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, 'instance:controller'));
    expect(status.roles).toEqual(['client-2', 'edit', 'server']);
  });

  test('leave_client also treats a request rejected by a departing proxy as already left', async () => {
    const { tools, bridge } = setup((endpoint, _data, peerId) => {
      if (endpoint === '/api/multiplayer-test-leave-client') throw new Error('Peer disconnected');
      if (endpoint === '/api/multiplayer-test-state' && peerId === SERVER) {
        return serverState([{ peerId: client(2), role: 'client-2', player: 'Player2', playerPresent: true }]);
      }
      return undefined;
    });
    const result = parse(await tools.multiplayerTestLeaveClient('client-1', 5, 'instance:controller'));
    expect(result).toMatchObject({ success: true, left: true, alreadyLeft: true });
    expect(roles(bridge)).toEqual(['client-2', 'edit', 'server']);
  });

  test('leave_client keeps reporting a broker timeout while the server still has the Player', async () => {
    const { tools, bridge } = setup((endpoint, _data, peerId) => {
      if (endpoint === '/api/multiplayer-test-leave-client') return TIMEOUT;
      if (endpoint === '/api/multiplayer-test-state' && peerId === SERVER) {
        return serverState([
          { peerId: client(1), role: 'client-1', player: 'Player1', playerPresent: true },
          { peerId: client(2), role: 'client-2', player: 'Player2', playerPresent: true },
        ]);
      }
      return undefined;
    });
    const result = parse(await tools.multiplayerPlaytest('leave_client', undefined, 'client-1', undefined, undefined, 5, 'instance:controller'));
    expect(result).toMatchObject({ success: false, error: 'client_broker_timeout', message: TIMEOUT.message });
    expect(roles(bridge)).toEqual(['client-1', 'client-2', 'edit', 'server']);
  });

  test('leave_client relays the server removing an unresponsive client', async () => {
    const message = 'client-1 did not answer the leave request and its MCP bridge last sent a heartbeat 12.0 s ago, so its Studio process probably exited (window closed or killed) or is frozen. The server removed its Player Player1.';
    const { tools, bridge } = setup((endpoint, _data, peerId) => {
      if (endpoint === '/api/multiplayer-test-leave-client' && typeof peerId === 'string') {
        bridge.unregisterPeer(peerId);
        return { success: true, removedByServer: true, localPlayer: 'Player1', message };
      }
      return undefined;
    });
    const result = parse(await tools.multiplayerPlaytest('leave_client', undefined, 'client-1', undefined, undefined, 5, 'instance:controller'));
    expect(result).toEqual({ success: true, action: 'leave_client', message, roles: ['edit', 'server', 'client-2'] });
  });

  test('status drops a client the server no longer brokers but keeps one still joining', async () => {
    const { tools, bridge } = setup((endpoint, _data, peerId) => {
      if (endpoint === '/api/multiplayer-test-state' && peerId === SERVER) {
        // client-3 registers while the server builds its snapshot.
        if (!bridge.getPeerById(client(3))) registerClient(bridge, 3);
        return serverState([{ peerId: client(2), role: 'client-2', player: 'Player2', playerPresent: true }]);
      }
      return undefined;
    });
    const status = parse(await tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, 'instance:controller'));
    expect(status.roles).toEqual(['client-2', 'edit', 'server']);
    expect(roles(bridge)).toEqual(['client-2', 'client-3', 'edit', 'server']);
  });

  test('status drops a client whose Player the server reports gone', async () => {
    const { tools, bridge } = setup((endpoint, _data, peerId) => {
      if (endpoint === '/api/multiplayer-test-state' && peerId === SERVER) {
        return serverState([
          { peerId: client(1), role: 'client-1', player: 'Player1', playerPresent: false },
          { peerId: client(2), role: 'client-2', player: 'Player2', playerPresent: true },
        ]);
      }
      return undefined;
    });
    const status = parse(await tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, 'instance:controller'));
    expect(status.roles).toEqual(['client-2', 'edit', 'server']);
    expect(roles(bridge)).toEqual(['client-2', 'edit', 'server']);
  });

  test('status flags a client whose bridge stopped sending heartbeats', async () => {
    const { tools, bridge } = setup((endpoint, _data, peerId) => {
      if (endpoint === '/api/multiplayer-test-state' && peerId === SERVER) {
        return serverState([
          { peerId: client(1), role: 'client-1', player: 'Player1', playerPresent: true, heartbeatAgeMs: 28_900 },
          { peerId: client(2), role: 'client-2', player: 'Player2', playerPresent: true, heartbeatAgeMs: 400 },
        ]);
      }
      return undefined;
    });
    const status = parse(await tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, 'instance:controller'));
    expect(status).toMatchObject({
      roles: ['client-1', 'client-2', 'edit', 'server'],
      unresponsiveClients: ['client-1'],
      hint: expect.stringMatching(/may have exited/),
    });
    expect(roles(bridge)).toEqual(['client-1', 'client-2', 'edit', 'server']);
  });

  test('status keeps every client when the plugin does not report brokered clients', async () => {
    const { tools, bridge } = setup(() => undefined);
    const status = parse(await tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, 'instance:controller'));
    expect(status.roles).toEqual(['client-1', 'client-2', 'edit', 'server']);
    expect(status.unresponsiveClients).toBeUndefined();
    expect(roles(bridge)).toEqual(['client-1', 'client-2', 'edit', 'server']);
  });
});

import { BridgeService } from '../bridge-service.js';
import type { RegisterPeerInput } from '../bridge-service.js';

function register(
  bridge: BridgeService,
  input: Pick<RegisterPeerInput, 'peerId' | 'instanceId' | 'role'> &
    Partial<Omit<RegisterPeerInput, 'peerId' | 'instanceId' | 'role'>>,
) {
  const result = bridge.registerPeer({
    transportPeerId: input.peerId,
    placeId: 0,
    placeName: '',
    ...input,
  });
  if (!result.ok) throw new Error(`registerPeer failed: ${result.error.code}`);
  return result;
}

describe('BridgeService', () => {
  let bridge: BridgeService;

  beforeEach(() => {
    bridge = new BridgeService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Peer and Instance topology', () => {
    test('aggregates Peers by opaque process Instance ID', () => {
      register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:solo',
        role: 'edit',
        placeId: 123,
        placeName: 'Shared Place',
      });
      register(bridge, {
        peerId: 'server-peer',
        instanceId: 'instance:solo',
        role: 'server',
        placeId: 123,
        placeName: 'Shared Place',
      });

      expect(bridge.getPeers()).toHaveLength(2);
      expect(bridge.getInstances()).toHaveLength(1);
      expect(bridge.getPublicInstances()[0]).toMatchObject({
        id: 'instance:solo',
        placeId: 123,
        placeName: 'Shared Place',
        peers: [
          { peerId: 'edit-peer', instanceId: 'instance:solo', role: 'edit' },
          { peerId: 'server-peer', instanceId: 'instance:solo', role: 'server' },
        ],
      });
      expect(bridge.getConnectedInstances()[0]).toMatchObject({
        id: 'instance:solo',
        placeId: 123,
        placeName: 'Shared Place',
        peers: {
          edit: 'edit-peer',
          server: 'server-peer',
        },
      });
      expect(bridge.getPublicPeers()[0]).not.toHaveProperty('transportPeerId');
    });

    test('allows same-place same-role Peers in separate process Instances', () => {
      const first = register(bridge, {
        peerId: 'window-a-edit',
        instanceId: 'instance:window-a',
        role: 'edit',
        placeId: 456,
        placeName: 'Same Published Place',
        placeKey: 'place:456',
      });
      const second = register(bridge, {
        peerId: 'window-b-edit',
        instanceId: 'instance:window-b',
        role: 'edit',
        placeId: 456,
        placeName: 'Same Published Place',
        placeKey: 'place:456',
      });

      expect(first.instanceId).toBe('instance:window-a');
      expect(second.instanceId).toBe('instance:window-b');
      expect(bridge.getInstances().map((instance) => instance.id)).toEqual([
        'instance:window-a',
        'instance:window-b',
      ]);
      expect(bridge.resolveTarget({})).toMatchObject({
        ok: false,
        error: { code: 'multiple_instances_connected' },
      });
    });

    test('allows separate unpublished-place processes without place aliases', () => {
      register(bridge, {
        peerId: 'anon-a',
        instanceId: 'instance:anon-a',
        role: 'edit',
        placeKey: 'anon:shared-document',
      });
      register(bridge, {
        peerId: 'anon-b',
        instanceId: 'instance:anon-b',
        role: 'edit',
        placeKey: 'anon:shared-document',
      });

      expect(bridge.getPublicInstances().map((instance) => instance.id)).toEqual([
        'instance:anon-a',
        'instance:anon-b',
      ]);
      expect(bridge.resolveTarget({ instance_id: 'anon:shared-document' })).toMatchObject({
        ok: false,
        error: { code: 'unrecognized_instance_id' },
      });
    });

    test('metadata publication never changes Instance or queued Peer identity', async () => {
      register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:stable',
        role: 'edit',
        placeKey: 'anon:document',
      });
      const response = bridge.sendRequest('/api/save', {}, 'edit-peer');

      bridge.updatePeerMetadata('edit-peer', {
        placeId: 987,
        placeName: 'Published',
        placeKey: 'place:987',
      });

      expect(bridge.getPeerById('edit-peer')).toMatchObject({
        peerId: 'edit-peer',
        instanceId: 'instance:stable',
        placeId: 987,
        placeKey: 'place:987',
      });
      const delivery = bridge.claimNextRequestForTransport('edit-peer', 'stream');
      expect(delivery).toMatchObject({ peerId: 'edit-peer', endpoint: '/api/save' });
      bridge.resolveRequest(delivery!.requestId, { saved: true });
      await expect(response).resolves.toEqual({ saved: true });
    });

    test('rejects a duplicate route only within one routing scope', () => {
      register(bridge, {
        peerId: 'first-edit',
        instanceId: 'instance:first',
        role: 'edit',
      });
      const duplicateStandalone = bridge.registerPeer({
        peerId: 'second-edit',
        transportPeerId: 'second-edit',
        instanceId: 'instance:first',
        role: 'edit',
      });
      expect(duplicateStandalone).toMatchObject({
        ok: false,
        error: { code: 'duplicate_scope_role', existing: { peerId: 'first-edit' } },
      });

      register(bridge, {
        peerId: 'group-server',
        instanceId: 'instance:server',
        multiplayerGroupId: 'test:one',
        role: 'server',
      });
      const duplicateGroupRole = bridge.registerPeer({
        peerId: 'other-server',
        transportPeerId: 'other-server',
        instanceId: 'instance:other-server',
        multiplayerGroupId: 'test:one',
        role: 'server',
      });
      expect(duplicateGroupRole).toMatchObject({
        ok: false,
        error: { code: 'duplicate_scope_role', existing: { peerId: 'group-server' } },
      });

      expect(register(bridge, {
        peerId: 'separate-server',
        instanceId: 'instance:separate',
        role: 'server',
      }).assignedRole).toBe('server');
    });

    test('re-registration preserves Peer identity and connectedAt', () => {
      const first = register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:one',
        role: 'edit',
        placeName: 'Before',
      });
      const connectedAt = bridge.getPeerById('edit-peer')!.connectedAt;
      jest.advanceTimersByTime(1000);
      const second = register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:one',
        role: 'edit',
        placeName: 'After',
      });

      expect(second.peerId).toBe(first.peerId);
      expect(bridge.getPeers()).toHaveLength(1);
      expect(bridge.getPeerById('edit-peer')).toMatchObject({ connectedAt, placeName: 'After' });
    });

    test('rejects reuse of a Peer ID for a different process or transport', () => {
      register(bridge, {
        peerId: 'stable-peer',
        instanceId: 'instance:first',
        role: 'edit',
      });

      expect(bridge.registerPeer({
        peerId: 'stable-peer',
        transportPeerId: 'different-transport',
        instanceId: 'instance:second',
        role: 'edit',
      })).toMatchObject({ ok: false, error: { code: 'peer_identity_mismatch' } });
    });
  });

  describe('explicit Multiplayer Groups', () => {
    test('auto-creates from runtime registration and merges the edit controller later', () => {
      register(bridge, {
        peerId: 'server-peer',
        instanceId: 'instance:server',
        multiplayerGroupId: 'test:abc',
        role: 'server',
      });
      register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:edit',
        role: 'edit',
      });

      bridge.createMultiplayerGroup('test:abc', 'instance:edit');

      expect(bridge.getMultiplayerGroups()).toEqual([
        expect.objectContaining({
          id: 'test:abc',
          controllerInstanceId: 'instance:edit',
          instanceIds: ['instance:server', 'instance:edit'],
        }),
      ]);
      expect(bridge.getPeerById('edit-peer')?.multiplayerGroupId).toBe('test:abc');
      expect(bridge.getInstanceIdsInScope('instance:server')).toEqual([
        'instance:server',
        'instance:edit',
      ]);
    });

    test('retains the controller group while publishing only active runtime Peer aliases', () => {
      register(bridge, {
        peerId: 'runtime-server',
        instanceId: 'instance:runtime',
        multiplayerGroupId: 'test:lifetime',
        role: 'server',
      });
      register(bridge, {
        peerId: 'controller-edit',
        instanceId: 'instance:edit',
        role: 'edit',
      });
      bridge.createMultiplayerGroup('test:lifetime', 'instance:edit');

      expect(bridge.getConnectedMultiplayerGroups()[0]?.instances).toEqual({
        'instance:runtime-server': 'runtime-server',
      });

      bridge.unregisterPeer('runtime-server');

      expect(bridge.getConnectedMultiplayerGroups()).toEqual([{
        id: 'test:lifetime',
        controllerInstanceId: 'instance:edit',
        instances: {},
      }]);
      expect(bridge.resolveConnectedInstanceId('instance:runtime-server')).toBeUndefined();
      expect(bridge.getConnectedInstances()).toEqual([
        expect.objectContaining({
          id: 'instance:edit',
          multiplayerGroupId: 'test:lifetime',
          peers: { edit: 'controller-edit' },
        }),
      ]);

      register(bridge, {
        peerId: 'replacement-server',
        instanceId: 'instance:replacement',
        multiplayerGroupId: 'test:lifetime',
        role: 'server',
      });
      expect(bridge.resolveTarget({
        instance_id: 'instance:edit',
        target: 'server',
      })).toMatchObject({
        ok: true,
        targetPeerId: 'replacement-server',
      });
    });

    test('does not repeat grouped runtime Peers on a mixed edit process row', () => {
      register(bridge, {
        peerId: 'mixed-edit',
        instanceId: 'instance:mixed',
        multiplayerGroupId: 'test:mixed',
        role: 'edit',
      });
      register(bridge, {
        peerId: 'mixed-server',
        instanceId: 'instance:mixed',
        multiplayerGroupId: 'test:mixed',
        role: 'server',
      });

      expect(bridge.getConnectedInstances()).toEqual([
        expect.objectContaining({
          id: 'instance:mixed',
          peers: { edit: 'mixed-edit' },
        }),
      ]);
      expect(bridge.getConnectedMultiplayerGroups()[0]?.instances).toEqual({
        'instance:mixed-server': 'mixed-server',
      });
    });

    test('rejects canonical IDs that collide with runtime aliases in either registration order', () => {
      register(bridge, {
        peerId: 'grouped-first',
        instanceId: 'instance:runtime',
        multiplayerGroupId: 'test:collision',
        role: 'server',
      });
      expect(bridge.registerPeer({
        peerId: 'canonical-second',
        transportPeerId: 'canonical-second',
        instanceId: 'instance:runtime-server',
        role: 'edit',
      })).toMatchObject({
        ok: false,
        error: {
          code: 'instance_id_alias_collision',
          existing: { peerId: 'grouped-first' },
        },
      });

      const reverseBridge = new BridgeService();
      register(reverseBridge, {
        peerId: 'canonical-first',
        instanceId: 'instance:runtime-server',
        role: 'edit',
      });
      expect(reverseBridge.registerPeer({
        peerId: 'grouped-second',
        transportPeerId: 'grouped-second',
        instanceId: 'instance:runtime',
        multiplayerGroupId: 'test:collision',
        role: 'server',
      })).toMatchObject({
        ok: false,
        error: {
          code: 'instance_id_alias_collision',
          existing: { peerId: 'canonical-first' },
        },
      });
    });

    test('routes any selected member across the entire group', () => {
      register(bridge, {
        peerId: 'runtime-server',
        instanceId: 'instance:server',
        multiplayerGroupId: 'test:routing',
        role: 'server',
      });
      register(bridge, {
        peerId: 'runtime-client',
        transportPeerId: 'runtime-server',
        instanceId: 'instance:client',
        multiplayerGroupId: 'test:routing',
        role: 'client',
      });
      register(bridge, {
        peerId: 'controller-edit',
        instanceId: 'instance:edit',
        role: 'edit',
      });
      bridge.createMultiplayerGroup('test:routing', 'instance:edit');
      expect(bridge.getConnectedInstances()).toEqual([
        expect.objectContaining({
          id: 'instance:edit',
          multiplayerGroupId: 'test:routing',
          peers: { edit: 'controller-edit' },
        }),
      ]);
      expect(bridge.getConnectedMultiplayerGroups()).toEqual([{
        id: 'test:routing',
        controllerInstanceId: 'instance:edit',
        instances: {
          'instance:server-server': 'runtime-server',
          'instance:client-client-1': 'runtime-client',
        },
      }]);


      expect(bridge.resolveTarget({ instance_id: 'instance:client' })).toEqual({
        ok: true,
        mode: 'single',
        targetPeerId: 'controller-edit',
        targetInstanceId: 'instance:edit',
        targetRole: 'edit',
      });
      expect(bridge.resolveTarget({ instance_id: 'instance:edit', target: 'server' })).toEqual({
        ok: true,
        mode: 'single',
        targetPeerId: 'runtime-server',
        targetInstanceId: 'instance:server',
        targetRole: 'server',
      });
      expect(bridge.resolveTarget({
        instance_id: 'instance:server-server',
        target: 'server',
      })).toEqual({
        ok: true,
        mode: 'single',
        targetPeerId: 'runtime-server',
        targetInstanceId: 'instance:server',
        targetRole: 'server',
      });
      expect(bridge.resolveTarget({ target: 'client-1' })).toEqual({
        ok: true,
        mode: 'single',
        targetPeerId: 'runtime-client',
        targetInstanceId: 'instance:client',
        targetRole: 'client-1',
      });
      const fanout = bridge.resolveTarget({ instance_id: 'instance:server', target: 'all' });
      expect(fanout).toMatchObject({ ok: true, mode: 'fanout' });
      if (!fanout.ok || fanout.mode !== 'fanout') throw new Error('expected fanout');
      expect(fanout.targets.map((target) => target.targetPeerId)).toEqual([
        'runtime-server',
        'runtime-client',
        'controller-edit',
      ]);
    });

    test('allocates client ordinals within a group, not by place or process', () => {
      const first = register(bridge, {
        peerId: 'group-a-client-one',
        instanceId: 'instance:a-client-one',
        multiplayerGroupId: 'test:a',
        role: 'client',
        placeId: 100,
      });
      const second = register(bridge, {
        peerId: 'group-a-client-two',
        instanceId: 'instance:a-client-two',
        multiplayerGroupId: 'test:a',
        role: 'client',
        placeId: 100,
      });
      const otherGroup = register(bridge, {
        peerId: 'group-b-client-one',
        instanceId: 'instance:b-client-one',
        multiplayerGroupId: 'test:b',
        role: 'client',
        placeId: 100,
      });
      const standalone = register(bridge, {
        peerId: 'standalone-client-one',
        instanceId: 'instance:standalone',
        role: 'client',
        placeId: 100,
      });

      expect(first.assignedRole).toBe('client-1');
      expect(second.assignedRole).toBe('client-2');
      expect(otherGroup.assignedRole).toBe('client-1');
      expect(standalone.assignedRole).toBe('client-1');
    });

    test('moving an Instance detaches it from its prior group', () => {
      register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:edit',
        multiplayerGroupId: 'test:old',
        role: 'edit',
      });

      bridge.createMultiplayerGroup('test:new', 'instance:edit');

      expect(bridge.getPeerById('edit-peer')?.multiplayerGroupId).toBe('test:new');
      expect(bridge.getMultiplayerGroups()).toEqual([
        expect.objectContaining({
          id: 'test:new',
          controllerInstanceId: 'instance:edit',
          instanceIds: ['instance:edit'],
        }),
      ]);
    });

    test('removing a group makes every member Instance standalone', () => {
      register(bridge, {
        peerId: 'server-peer',
        instanceId: 'instance:server',
        multiplayerGroupId: 'test:remove',
        role: 'server',
      });
      register(bridge, {
        peerId: 'client-peer',
        instanceId: 'instance:client',
        multiplayerGroupId: 'test:remove',
        role: 'client',
      });

      const removed = bridge.removeMultiplayerGroup('test:remove');

      expect(removed?.instanceIds).toEqual(['instance:server', 'instance:client']);
      expect(bridge.getMultiplayerGroups()).toEqual([]);
      expect(bridge.getInstances()).toEqual([
        expect.objectContaining({ id: 'instance:server', multiplayerGroupId: undefined }),
        expect.objectContaining({ id: 'instance:client', multiplayerGroupId: undefined }),
      ]);
      expect(bridge.resolveTarget({})).toMatchObject({
        ok: false,
        error: { code: 'multiple_instances_connected' },
      });
    });
  });

  describe('routing errors', () => {
    test('reports compact role-keyed Instances and Multiplayer Groups', () => {
      register(bridge, {
        peerId: 'peer:aaa-111',
        instanceId: 'instance:a',
        multiplayerGroupId: 'test:a',
        role: 'edit',
      });
      register(bridge, {
        peerId: 'peer:bbb-222',
        instanceId: 'instance:b',
        role: 'edit',
      });

      const result = bridge.resolveTarget({ target: 'edit' });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'ambiguous_target',
          data: {
            count: 3,
            instances: [
              { id: 'instance:a', peers: { edit: 'peer:aaa-111' } },
              { id: 'instance:b', peers: { edit: 'peer:bbb-222' } },
            ],
            multiplayerGroups: [{ id: 'test:a', instances: {} }],
          },
        },
      });
      if (result.ok) throw new Error('expected routing error');
      expect(result.error.data.instances[0].peers).toEqual({ edit: 'peer:aaa-111' });
    });

    test('explicit Instance selects its scope even for same-place processes', () => {
      register(bridge, {
        peerId: 'first-edit',
        instanceId: 'instance:first',
        role: 'edit',
        placeId: 1,
      });
      register(bridge, {
        peerId: 'second-edit',
        instanceId: 'instance:second',
        role: 'edit',
        placeId: 1,
      });

      expect(bridge.resolveTarget({ instance_id: 'instance:second', target: 'edit' })).toEqual({
        ok: true,
        mode: 'single',
        targetPeerId: 'second-edit',
        targetInstanceId: 'instance:second',
        targetRole: 'edit',
      });
    });
  });

  describe('exact Peer request delivery', () => {
    test('delivers to the exact target Peer through its transport owner', async () => {
      register(bridge, {
        peerId: 'server-peer',
        instanceId: 'instance:server',
        multiplayerGroupId: 'test:proxy',
        role: 'server',
      });
      register(bridge, {
        peerId: 'client-peer',
        transportPeerId: 'server-peer',
        instanceId: 'instance:client',
        multiplayerGroupId: 'test:proxy',
        role: 'client',
      });
      const response = bridge.sendRequest('/api/client-only', { value: 1 }, 'client-peer');

      expect(bridge.claimNextRequestForTransport('unrelated-peer', 'wrong-stream')).toBeNull();
      const delivery = bridge.claimNextRequestForTransport('server-peer', 'server-stream');
      expect(delivery).toMatchObject({
        peerId: 'client-peer',
        target: 'client-1',
        endpoint: '/api/client-only',
        data: { value: 1 },
      });
      bridge.resolveRequest(delivery!.requestId, { reached: 'client-peer' });
      await expect(response).resolves.toEqual({ reached: 'client-peer' });
    });

    test('does not retarget queued work when a different Peer appears', async () => {
      register(bridge, {
        peerId: 'original-peer',
        instanceId: 'instance:one',
        role: 'edit',
      });
      const response = bridge.sendRequest('/api/mutate', {}, 'original-peer');
      const rejected = expect(response).rejects.toThrow('original-peer');

      bridge.unregisterPeer('original-peer');
      register(bridge, {
        peerId: 'replacement-peer',
        instanceId: 'instance:one',
        role: 'edit',
      });

      expect(bridge.claimNextRequestForTransport('replacement-peer', 'replacement-stream')).toBeNull();
      await rejected;
    });

    test('release redelivers the same request to the same transport and Peer', async () => {
      register(bridge, {
        peerId: 'client-peer',
        transportPeerId: 'server-peer',
        instanceId: 'instance:client',
        role: 'client',
      });
      const response = bridge.sendRequest('/api/work', {}, 'client-peer');
      const first = bridge.claimNextRequestForTransport('server-peer', 'old-stream');

      bridge.releaseDeliveryClaims('old-stream');
      const second = bridge.claimNextRequestForTransport('server-peer', 'new-stream');

      expect(second).toEqual(first);
      expect(second?.peerId).toBe('client-peer');
      bridge.resolveRequest(second!.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('timeout emits cancellation only to the transport that received the request', async () => {
      register(bridge, {
        peerId: 'client-peer',
        transportPeerId: 'server-peer',
        instanceId: 'instance:client',
        role: 'client',
      });
      const response = bridge.sendRequest('/api/slow', {}, 'client-peer', 1000);
      const rejected = expect(response).rejects.toThrow('Request timeout');
      const delivery = bridge.claimNextRequestForTransport('server-peer', 'stream');

      jest.advanceTimersByTime(1000);

      expect(bridge.claimNextCancellationForTransport('other-peer', 'other-stream')).toBeNull();
      expect(bridge.claimNextCancellationForTransport('server-peer', 'stream')).toEqual({
        requestId: delivery!.requestId,
        reason: 'timeout',
      });
      await rejected;
    });

    test('settles a request once and retains an accepted tombstone', async () => {
      register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:edit',
        role: 'edit',
      });
      const response = bridge.sendRequest('/api/test', {}, 'edit-peer');
      const delivery = bridge.claimNextRequestForTransport('edit-peer', 'stream')!;

      expect(bridge.resolveRequest(delivery.requestId, { ok: true })).toBe('accepted');
      expect(bridge.rejectRequest(delivery.requestId, new Error('late'))).toBe('already_settled');
      expect(bridge.resolveRequest('unknown', {})).toBe('unknown');
      await expect(response).resolves.toEqual({ ok: true });
    });
  });

  describe('Peer lifecycle', () => {
    test('uses Peer listener and close terminology', () => {
      const registered: string[] = [];
      const closed: string[] = [];
      bridge.onPeerRegistered((peer) => registered.push(peer.peerId));
      bridge.onPeerClosed((peer) => closed.push(`${peer.peerId}:${peer.transportPeerId}`));

      register(bridge, {
        peerId: 'edit-peer',
        instanceId: 'instance:edit',
        role: 'edit',
      });
      bridge.unregisterPeer('edit-peer');

      expect(registered).toEqual(['edit-peer']);
      expect(closed).toEqual(['edit-peer:edit-peer']);
    });

    test('transport Instance removal returns and cascades only its proxied Peers', () => {
      register(bridge, {
        peerId: 'server-peer',
        instanceId: 'instance:server',
        multiplayerGroupId: 'test:cascade',
        role: 'server',
      });
      register(bridge, {
        peerId: 'client-peer',
        transportPeerId: 'server-peer',
        instanceId: 'instance:client',
        multiplayerGroupId: 'test:cascade',
        role: 'client',
      });
      register(bridge, {
        peerId: 'other-peer',
        instanceId: 'instance:other',
        role: 'edit',
      });
      bridge.createMultiplayerGroup('test:cascade', 'instance:other');

      const removed = bridge.unregisterInstanceId('instance:server');

      expect(removed.map((peer) => peer.peerId)).toEqual(['server-peer', 'client-peer']);
      expect(bridge.getPeerById('server-peer')).toBeUndefined();
      expect(bridge.getPeerById('client-peer')).toBeUndefined();
      expect(bridge.getPeerById('other-peer')).toBeDefined();
      expect(bridge.getMultiplayerGroups()).toEqual([]);
    });

    test('unregisterInstanceId removes one process without touching same-place processes', () => {
      register(bridge, {
        peerId: 'first-edit',
        instanceId: 'instance:first',
        role: 'edit',
        placeId: 22,
      });
      register(bridge, {
        peerId: 'second-edit',
        instanceId: 'instance:second',
        role: 'edit',
        placeId: 22,
      });

      const removed = bridge.unregisterInstanceId('instance:first');

      expect(removed.map((peer) => peer.peerId)).toEqual(['first-edit']);
      expect(bridge.getPublicInstances()).toEqual([
        expect.objectContaining({ id: 'instance:second' }),
      ]);
    });

    test('active transport protects its direct and proxied Peers from stale cleanup', () => {
      register(bridge, {
        peerId: 'server-peer',
        instanceId: 'instance:server',
        role: 'server',
      });
      register(bridge, {
        peerId: 'client-peer',
        transportPeerId: 'server-peer',
        instanceId: 'instance:client',
        role: 'client',
      });
      bridge.setDeliveryActive('server-peer', 'stream', true);

      jest.advanceTimersByTime(31_000);
      bridge.cleanupStalePeers();

      expect(bridge.getPeers().map((peer) => peer.peerId)).toEqual(['server-peer', 'client-peer']);
      bridge.setDeliveryActive('server-peer', 'stream', false);
      bridge.cleanupStalePeers();
      expect(bridge.getPeers()).toEqual([]);
    });
  });
});

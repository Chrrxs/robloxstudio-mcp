import { BridgeService } from '../bridge-service.js';

class MirroredBridgeService extends BridgeService {
  constructor(private readonly mirroredInstances: ReturnType<BridgeService['getInstances']>) {
    super();
  }

  override getInstances() {
    return this.mirroredInstances;
  }
}

function register(b: BridgeService, opts: { pluginSessionId: string; physicalSessionId?: string; instanceId: string; role: string; placeId?: number; placeName?: string }) {
  const res = b.registerInstance({
    pluginSessionId: opts.pluginSessionId,
    physicalSessionId: opts.physicalSessionId ?? opts.pluginSessionId,
    instanceId: opts.instanceId,
    role: opts.role,
    placeId: opts.placeId ?? 0,
    placeName: opts.placeName ?? '',
    dataModelName: opts.placeName ?? '',
    isRunning: false,
  });
  if (!res.ok) throw new Error(`registerInstance failed: ${res.error.code}`);
  return res;
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

  describe('Request management', () => {
    test('claims a queued request for the matching physical session', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'place:1', role: 'edit' });
      const response = bridge.sendRequest('/api/test', { hello: 'world' }, 'place:1', 'edit');

      const delivery = bridge.claimNextRequestForPhysical('edit', 'test-delivery');
      expect(delivery).toMatchObject({
        logicalSessionId: 'edit',
        target: 'edit',
        endpoint: '/api/test',
        data: { hello: 'world' },
      });
      expect(bridge.resolveRequest(delivery!.requestId, { ok: true })).toBe('accepted');
      expect(bridge.rejectRequest(delivery!.requestId, 'late duplicate')).toBe('already_settled');
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('settles an error once and reports repeated settlement', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'place:1', role: 'edit' });
      const response = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      response.catch(() => {});
      const delivery = bridge.claimNextRequestForPhysical('edit', 'test-error');

      expect(bridge.rejectRequest(delivery!.requestId, 'failed')).toBe('accepted');
      expect(bridge.resolveRequest(delivery!.requestId, { tooLate: true })).toBe('already_settled');
      await expect(response).rejects.toBe('failed');
    });

    test('reports unknown for a request ID that was never issued', () => {
      expect(bridge.resolveRequest('never-issued', { ok: true })).toBe('unknown');
      expect(bridge.rejectRequest('never-issued', 'failed')).toBe('unknown');
    });

    test('expires accepted request IDs after 60 seconds', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'place:1', role: 'edit' });
      const response = bridge.sendRequest('/api/test', {}, 'place:1', 'edit', 120_000);
      const delivery = bridge.claimNextRequestForPhysical('edit', 'test-expiry');

      expect(bridge.resolveRequest(delivery!.requestId, { ok: true })).toBe('accepted');
      await expect(response).resolves.toEqual({ ok: true });
      jest.advanceTimersByTime(59_999);
      expect(bridge.resolveRequest(delivery!.requestId, { duplicate: true })).toBe('already_settled');
      jest.advanceTimersByTime(1);
      expect(bridge.resolveRequest(delivery!.requestId, { duplicate: true })).toBe('unknown');
    });

    test('retains only the 4096 most recently accepted request IDs', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'place:1', role: 'edit' });
      const responses: Promise<unknown>[] = [];
      let oldestRequestId = '';
      let newestRequestId = '';
      for (let index = 0; index < 4097; index += 1) {
        const response = bridge.sendRequest('/api/test', { index }, 'place:1', 'edit');
        responses.push(response);
        const delivery = bridge.claimNextRequestForPhysical('edit', `test-cap-${index}`)!;
        if (index === 0) oldestRequestId = delivery.requestId;
        newestRequestId = delivery.requestId;
        if (bridge.resolveRequest(delivery.requestId, { index }) !== 'accepted') {
          throw new Error(`Request ${index} was not accepted`);
        }
      }
      await expect(Promise.all(responses)).resolves.toHaveLength(4097);

      expect(bridge.resolveRequest(oldestRequestId, {})).toBe('unknown');
      expect(bridge.resolveRequest(newestRequestId, {})).toBe('already_settled');
    });

    test('does not claim requests for a different role or physical session', async () => {
      register(bridge, { pluginSessionId: 'edit-a', instanceId: 'place:A', role: 'edit' });
      register(bridge, { pluginSessionId: 'server-a', instanceId: 'place:A', role: 'server' });
      register(bridge, { pluginSessionId: 'edit-b', instanceId: 'place:B', role: 'edit' });
      const response = bridge.sendRequest('/api/test', {}, 'place:A', 'edit');

      expect(bridge.claimNextRequestForPhysical('server-a', 'wrong-role')).toBeNull();
      expect(bridge.claimNextRequestForPhysical('edit-b', 'wrong-instance')).toBeNull();
      const delivery = bridge.claimNextRequestForPhysical('edit-a', 'matching-session');
      expect(delivery?.logicalSessionId).toBe('edit-a');
      bridge.resolveRequest(delivery!.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('holds a claimed request until response or owner release', async () => {
      register(bridge, { pluginSessionId: 'server', instanceId: 'place:1', role: 'server' });
      const response = bridge.sendRequest('/api/test', { mutates: true }, 'place:1', 'server');

      const first = bridge.claimNextRequestForPhysical('server', 'stream-generation-1');
      expect(first).not.toBeNull();
      expect(bridge.claimNextRequestForPhysical('server', 'stream-generation-2')).toBeNull();

      bridge.releaseDeliveryClaims('stream-generation-1');
      const redelivery = bridge.claimNextRequestForPhysical('server', 'stream-generation-2');
      expect(redelivery).toEqual(first);
      bridge.resolveRequest(redelivery!.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('claims requests in FIFO order within a routed role', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'place:1', role: 'edit' });
      const firstResponse = bridge.sendRequest('/api/a', { order: 1 }, 'place:1', 'edit');
      jest.advanceTimersByTime(10);
      const secondResponse = bridge.sendRequest('/api/b', { order: 2 }, 'place:1', 'edit');

      const first = bridge.claimNextRequestForPhysical('edit', 'stream');
      expect(first?.data).toEqual({ order: 1 });
      bridge.resolveRequest(first!.requestId, { ok: 1 });
      const second = bridge.claimNextRequestForPhysical('edit', 'stream');
      expect(second?.data).toEqual({ order: 2 });
      bridge.resolveRequest(second!.requestId, { ok: 2 });
      await expect(Promise.all([firstResponse, secondResponse])).resolves.toEqual([
        { ok: 1 },
        { ok: 2 },
      ]);
    });

    test('notifies the physical stream when logical-client work is queued', async () => {
      register(bridge, { pluginSessionId: 'server', instanceId: 'place:1', role: 'server' });
      register(bridge, {
        pluginSessionId: 'client',
        physicalSessionId: 'server',
        instanceId: 'place:1',
        role: 'client',
      });
      const available = jest.fn();
      bridge.onRequestAvailable(available);

      const response = bridge.sendRequest('/api/test', {}, 'place:1', 'client-1');
      expect(available).toHaveBeenCalledWith('server');
      const delivery = bridge.claimNextRequestForPhysical('server', 'stream');
      expect(delivery).toMatchObject({
        logicalSessionId: 'client',
        target: 'client-1',
      });
      bridge.resolveRequest(delivery!.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('keeps request timeout semantics after delivery', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'place:1', role: 'edit' });
      const response = bridge.sendRequest('/api/slow', {}, 'place:1', 'edit');
      const delivery = bridge.claimNextRequestForPhysical('edit', 'stream')!;

      jest.advanceTimersByTime(31_000);
      await expect(response).rejects.toThrow('Request timeout');
      expect(bridge.resolveRequest(delivery.requestId, {})).toBe('unknown');
    });

    test('migrates queued work when an anonymous session becomes published', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'anon:old', role: 'edit' });
      const response = bridge.sendRequest('/api/test', {}, 'anon:old', 'edit');

      bridge.updateInstanceMetadata('edit', { placeId: 52 });
      const delivery = bridge.claimNextRequestForPhysical('edit', 'stream');
      expect(delivery?.logicalSessionId).toBe('edit');
      bridge.resolveRequest(delivery!.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('bridge shutdown rejects every queued request', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'place:1', role: 'edit' });
      const first = bridge.sendRequest('/api/a', {}, 'place:1', 'edit');
      const second = bridge.sendRequest('/api/b', {}, 'place:1', 'edit');
      first.catch(() => {});
      second.catch(() => {});
      const firstDelivery = bridge.claimNextRequestForPhysical('edit', 'shutdown-1')!;
      const secondDelivery = bridge.claimNextRequestForPhysical('edit', 'shutdown-2')!;

      bridge.clearAllPendingRequests();
      await expect(first).rejects.toThrow('Connection closed');
      await expect(second).rejects.toThrow('Connection closed');
      expect(bridge.getPendingRequestCount()).toBe(0);
      expect(bridge.resolveRequest(firstDelivery.requestId, {})).toBe('unknown');
      expect(bridge.rejectRequest(secondDelivery.requestId, 'late')).toBe('unknown');
    });
  });

  describe('registerInstance', () => {

    test('keeps logical proxies live while their mapped physical delivery is active', () => {
      register(bridge, { pluginSessionId: 'server', instanceId: 'place:1', role: 'server' });
      register(bridge, {
        pluginSessionId: 'client',
        physicalSessionId: 'server',
        instanceId: 'place:1',
        role: 'client',
      });
      bridge.setDeliveryActive('server', 'sse-generation', true);

      jest.advanceTimersByTime(31_000);
      bridge.cleanupStaleInstances();
      expect(bridge.getInstances().map((instance) => instance.pluginSessionId).sort()).toEqual([
        'client',
        'server',
      ]);

      bridge.setDeliveryActive('server', 'sse-generation', false);
      bridge.cleanupStaleInstances();
      expect(bridge.getInstances()).toEqual([]);
    });

    test('transport observer failures cannot break registration, delivery, or cleanup', async () => {
      bridge.onRequestAvailable(() => {
        throw new Error('request observer failed');
      });
      bridge.onSessionClosed(() => {
        throw new Error('close observer failed');
      });

      expect(() => register(bridge, {
        pluginSessionId: 'edit',
        instanceId: 'place:1',
        role: 'edit',
      })).not.toThrow();
      const response = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      const delivery = bridge.claimNextRequestForPhysical('edit', 'observer-test');
      expect(delivery).not.toBeNull();
      bridge.resolveRequest(delivery!.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
      expect(() => bridge.unregisterInstance('edit')).not.toThrow();
      expect(bridge.getInstances()).toEqual([]);
    });
    test('canonicalizes published places when a stale anon id is reported', () => {
      const r = register(bridge, {
        pluginSessionId: 'edit',
        instanceId: 'anon:old-file-id',
        role: 'edit',
        placeId: 12345,
      });

      expect(r.instanceId).toBe('place:12345');
      expect(bridge.getPublicInstances()[0].instanceId).toBe('place:12345');

      const resolved = bridge.resolveTarget({ instance_id: 'anon:old-file-id', target: 'edit' });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok || resolved.mode !== 'single') throw new Error('expected single');
      expect(resolved.targetInstanceId).toBe('place:12345');
      expect(resolved.targetRole).toBe('edit');
    });

    test('metadata updates migrate stale anon edit to the published place id', () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'anon:old-file-id', role: 'edit' });
      bridge.updateInstanceMetadata('edit', { placeId: 12345 });
      register(bridge, { pluginSessionId: 'server', instanceId: 'place:12345', role: 'server', placeId: 12345 });

      expect(bridge.getPublicInstances().map((inst) => inst.instanceId).sort()).toEqual(['place:12345', 'place:12345']);

      const editFromPublished = bridge.resolveTarget({ instance_id: 'place:12345', target: 'edit' });
      expect(editFromPublished.ok).toBe(true);
      if (!editFromPublished.ok || editFromPublished.mode !== 'single') throw new Error('expected single');
      expect(editFromPublished.targetInstanceId).toBe('place:12345');
      expect(editFromPublished.targetRole).toBe('edit');

      const serverFromAnon = bridge.resolveTarget({ instance_id: 'anon:old-file-id', target: 'server' });
      expect(serverFromAnon.ok).toBe(true);
      if (!serverFromAnon.ok || serverFromAnon.mode !== 'single') throw new Error('expected single');
      expect(serverFromAnon.targetInstanceId).toBe('place:12345');
      expect(serverFromAnon.targetRole).toBe('server');

      const omittedInstance = bridge.resolveTarget({ target: 'edit' });
      expect(omittedInstance.ok).toBe(true);
      if (!omittedInstance.ok || omittedInstance.mode !== 'single') throw new Error('expected single');
      expect(omittedInstance.targetInstanceId).toBe('place:12345');
      expect(omittedInstance.targetRole).toBe('edit');
    });

    test('migrates pending requests when an anon place becomes published', async () => {
      register(bridge, { pluginSessionId: 'edit', instanceId: 'anon:old-file-id', role: 'edit' });
      const pending = bridge.sendRequest('/api/test', {}, 'anon:old-file-id', 'edit');

      const r = register(bridge, {
        pluginSessionId: 'edit',
        instanceId: 'anon:old-file-id',
        role: 'edit',
        placeId: 12345,
      });
      expect(r.instanceId).toBe('place:12345');

      const delivery = bridge.claimNextRequestForPhysical('edit', 'migration-test');
      expect(delivery).toBeTruthy();
      bridge.resolveRequest(delivery!.requestId, { ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    test('routing works for proxy-style bridges that mirror instances via getInstances', () => {
      const mirrored = new MirroredBridgeService([
        {
          pluginSessionId: 'edit',
          physicalSessionId: 'edit',
          instanceId: 'anon:mirrored-place-id',
          role: 'edit',
          placeId: 0,
          placeName: 'MirroredPlace',
          dataModelName: 'MirroredPlace',
          isRunning: false,
          pluginVersion: '2.16.1',
          pluginVariant: 'main',
          serverVersion: '2.16.1',
          lastActivity: Date.now(),
          connectedAt: Date.now(),
        },
      ]);

      const resolved = mirrored.resolveTarget({ instance_id: 'anon:mirrored-place-id', target: 'edit' });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok || resolved.mode !== 'single') throw new Error('expected single');
      expect(resolved.targetInstanceId).toBe('anon:mirrored-place-id');
      expect(resolved.targetRole).toBe('edit');
    });

    test('first client gets client-1', () => {
      const r = register(bridge, { pluginSessionId: 'a', instanceId: 'place:1', role: 'client' });
      expect(r.assignedRole).toBe('client-1');
    });

    test('sequential clients get sequential indices', () => {
      expect(register(bridge, { pluginSessionId: 'a', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-1');
      expect(register(bridge, { pluginSessionId: 'b', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-2');
      expect(register(bridge, { pluginSessionId: 'c', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-3');
    });

    test('client indices are scoped per instance_id', () => {
      expect(register(bridge, { pluginSessionId: 'a', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-1');
      expect(register(bridge, { pluginSessionId: 'b', instanceId: 'place:2', role: 'client' }).assignedRole).toBe('client-1');
      expect(register(bridge, { pluginSessionId: 'c', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-2');
      expect(register(bridge, { pluginSessionId: 'd', instanceId: 'place:2', role: 'client' }).assignedRole).toBe('client-2');
    });

    test('client refresh preserves assigned role', () => {
      expect(register(bridge, { pluginSessionId: 'a', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-1');
      expect(register(bridge, { pluginSessionId: 'b', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-2');
      expect(register(bridge, { pluginSessionId: 'a', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-1');
      expect(bridge.getInstances()).toHaveLength(2);
    });

    test('disconnecting a middle client fills the hole', () => {
      register(bridge, { pluginSessionId: 'a', instanceId: 'place:1', role: 'client' });
      register(bridge, { pluginSessionId: 'b', instanceId: 'place:1', role: 'client' });
      register(bridge, { pluginSessionId: 'c', instanceId: 'place:1', role: 'client' });
      bridge.unregisterInstance('b');
      expect(register(bridge, { pluginSessionId: 'd', instanceId: 'place:1', role: 'client' }).assignedRole).toBe('client-2');
    });

    test('rejects duplicate (instanceId, role) tuple', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const dup = bridge.registerInstance({
        pluginSessionId: 'p2',
        physicalSessionId: 'p2',
        instanceId: 'place:1',
        role: 'edit',
      });
      expect(dup.ok).toBe(false);
      if (dup.ok) return;
      expect(dup.error.code).toBe('duplicate_instance_role');
      expect(dup.error.existing.instanceId).toBe('place:1');
      expect(dup.error.existing.role).toBe('edit');
    });

    test('fast relaunch takes over an inactive predecessor and rejects its pending requests', async () => {
      register(bridge, { pluginSessionId: 'old-session', instanceId: 'anon:relaunch', role: 'edit' });
      const pending = bridge.sendRequest('/api/test', { generation: 'old' }, 'anon:relaunch', 'edit');
      const delivery = bridge.claimNextRequestForPhysical('old-session', 'old-delivery')!;

      jest.advanceTimersByTime(3_001);
      const relaunched = bridge.registerInstance({
        pluginSessionId: 'new-session',
        physicalSessionId: 'new-session',
        instanceId: 'anon:relaunch',
        role: 'edit',
      });

      expect(relaunched.ok).toBe(true);
      expect(bridge.getInstanceBySessionId('old-session')).toBeUndefined();
      expect(bridge.getInstanceBySessionId('new-session')).toBeDefined();
      expect(bridge.getPendingRequestCount()).toBe(0);
      await expect(pending).rejects.toThrow(/disconnected/);
      expect(bridge.resolveRequest(delivery.requestId, {})).toBe('unknown');
    });

    test('recent stream activity prevents an active duplicate from being taken over', () => {
      register(bridge, { pluginSessionId: 'active-session', instanceId: 'anon:active', role: 'edit' });
      jest.advanceTimersByTime(2_500);
      bridge.updateInstanceActivity('active-session');
      jest.advanceTimersByTime(2_500);

      const duplicate = bridge.registerInstance({
        pluginSessionId: 'duplicate-session',
        physicalSessionId: 'duplicate-session',
        instanceId: 'anon:active',
        role: 'edit',
      });

      expect(duplicate.ok).toBe(false);
      expect(bridge.getInstanceBySessionId('active-session')).toBeDefined();
      expect(bridge.getInstanceBySessionId('duplicate-session')).toBeUndefined();
    });

    test('rejects duplicate explicit client role within the same instance_id', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'client' });
      const dup = bridge.registerInstance({
        pluginSessionId: 'p2',
        physicalSessionId: 'p2',
        instanceId: 'place:1',
        role: 'client-1',
      });
      expect(dup.ok).toBe(false);
      if (dup.ok) return;
      expect(dup.error.code).toBe('duplicate_instance_role');
      expect(dup.error.existing.role).toBe('client-1');
    });

    test('re-registering same pluginSessionId is allowed (refresh)', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const refresh = bridge.registerInstance({
        pluginSessionId: 'p1',
        physicalSessionId: 'p1',
        instanceId: 'place:1',
        role: 'edit',
      });
      expect(refresh.ok).toBe(true);
      expect(bridge.getInstances()).toHaveLength(1);
    });

    test('two edit plugins of different places coexist', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const r = bridge.registerInstance({
        pluginSessionId: 'p2',
        physicalSessionId: 'p2',
        instanceId: 'place:2',
        role: 'edit',
      });
      expect(r.ok).toBe(true);
      expect(bridge.getInstances()).toHaveLength(2);
    });
  });

  describe('resolveTarget', () => {
    test('omitted/omitted with single instance auto-routes', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const r = bridge.resolveTarget({});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.mode).toBe('single');
      if (r.mode !== 'single') return;
      expect(r.targetInstanceId).toBe('place:1');
      expect(r.targetRole).toBe('edit');
    });

    test('omitted/omitted with multiple instances errors multiple_instances_connected', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:2', role: 'edit' });
      const r = bridge.resolveTarget({});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('multiple_instances_connected');
      expect(r.error.data.count).toBe(2);
      expect(r.error.data.instances).toHaveLength(2);
    });

    test('target=role with multiple matching instances errors ambiguous_target', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:2', role: 'edit' });
      const r = bridge.resolveTarget({ target: 'edit' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('ambiguous_target');
      expect(r.error.message).toContain('multiple Studio places are connected');
      expect(r.error.message).toContain('Pass instance_id');
      expect(r.error.data.count).toBe(2);
    });

    test('instance_id picks the place', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:2', role: 'edit' });
      const r = bridge.resolveTarget({ instance_id: 'place:2' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.mode).toBe('single');
      if (r.mode !== 'single') return;
      expect(r.targetInstanceId).toBe('place:2');
      expect(r.targetRole).toBe('edit');
    });

    test('unknown instance_id errors unrecognized_instance_id with full list', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const r = bridge.resolveTarget({ instance_id: 'place:does-not-exist' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('unrecognized_instance_id');
      expect(r.error.data.instances).toHaveLength(1);
      expect(r.error.data.instances[0].instanceId).toBe('place:1');
    });

    test('instance_id with role picks (instance, role) tuple', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:1', role: 'server' });
      register(bridge, { pluginSessionId: 'p3', instanceId: 'place:1', role: 'client' });
      const r = bridge.resolveTarget({ instance_id: 'place:1', target: 'server' });
      expect(r.ok).toBe(true);
      if (!r.ok || r.mode !== 'single') throw new Error('expected single');
      expect(r.targetRole).toBe('server');
    });

    test('instance_id with client role picks that place client even when another place has same client role', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'client' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:2', role: 'client' });
      const r = bridge.resolveTarget({ instance_id: 'place:2', target: 'client-1' });
      expect(r.ok).toBe(true);
      if (!r.ok || r.mode !== 'single') throw new Error('expected single');
      expect(r.targetInstanceId).toBe('place:2');
      expect(r.targetRole).toBe('client-1');
    });

    test('instance_id with role that does not exist on instance errors target_role_not_present_on_instance', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const r = bridge.resolveTarget({ instance_id: 'place:1', target: 'server' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('target_role_not_present_on_instance');
    });

    test('instance_id without role on multi-role instance prefers edit', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:1', role: 'server' });
      const r = bridge.resolveTarget({ instance_id: 'place:1' });
      expect(r.ok).toBe(true);
      if (!r.ok || r.mode !== 'single') throw new Error('expected single');
      expect(r.targetRole).toBe('edit');
    });

    test('instance_id without role on multi-role no-edit instance errors target_role_required', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'server' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:1', role: 'client' });
      const r = bridge.resolveTarget({ instance_id: 'place:1' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('target_role_required');
    });

    test('target=all with single instance fans out across its roles', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:1', role: 'server' });
      register(bridge, { pluginSessionId: 'p3', instanceId: 'place:1', role: 'client' });
      const r = bridge.resolveTarget({ target: 'all' });
      expect(r.ok).toBe(true);
      if (!r.ok || r.mode !== 'fanout') throw new Error('expected fanout');
      expect(r.targets).toHaveLength(3);
      const roles = r.targets.map((t) => t.targetRole).sort();
      expect(roles).toEqual(['client-1', 'edit', 'server']);
      r.targets.forEach((t) => expect(t.targetInstanceId).toBe('place:1'));
    });

    test('target=all with multiple instances errors multiple_instances_connected', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:2', role: 'edit' });
      const r = bridge.resolveTarget({ target: 'all' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('multiple_instances_connected');
    });

    test('instance_id + target=all fans out only across that instance', () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:1', role: 'server' });
      register(bridge, { pluginSessionId: 'p3', instanceId: 'place:2', role: 'edit' });
      const r = bridge.resolveTarget({ instance_id: 'place:1', target: 'all' });
      expect(r.ok).toBe(true);
      if (!r.ok || r.mode !== 'fanout') throw new Error('expected fanout');
      expect(r.targets).toHaveLength(2);
      r.targets.forEach((t) => expect(t.targetInstanceId).toBe('place:1'));
    });

    test('no instances connected errors with empty list', () => {
      const r = bridge.resolveTarget({});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('unrecognized_instance_id');
      expect(r.error.data.count).toBe(0);
    });
  });

  describe('cleanup', () => {
    test('cleanupOldRequests rejects timed-out requests', async () => {
      const a = bridge.sendRequest('/api/a', {}, 'place:1', 'edit');
      const b = bridge.sendRequest('/api/b', {}, 'place:1', 'edit');
      jest.advanceTimersByTime(31000);
      bridge.cleanupOldRequests();
      await expect(a).rejects.toThrow('Request timeout');
      await expect(b).rejects.toThrow('Request timeout');
    });

    test('clearAllPendingRequests rejects everything', async () => {
      const a = bridge.sendRequest('/api/a', {}, 'place:1', 'edit');
      bridge.clearAllPendingRequests();
      await expect(a).rejects.toThrow('Connection closed');
    });

    test('unregisterInstance rejects requests targeting the removed (instanceId, role)', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const req = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      const delivery = bridge.claimNextRequestForPhysical('p1', 'disconnecting-delivery')!;
      bridge.unregisterInstance('p1');
      await expect(req).rejects.toThrow(/disconnected/);
      expect(bridge.resolveRequest(delivery.requestId, {})).toBe('unknown');
    });

    test('unregisterInstance leaves requests alone if another plugin still holds the tuple', async () => {
      // Two plugins both registering the same (instance, role) would be
      // duplicate_instance_role and rejected — this test exercises the case
      // where role differs.
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:1', role: 'server' });
      const editReq = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      const serverReq = bridge.sendRequest('/api/test', {}, 'place:1', 'server');

      bridge.unregisterInstance('p2'); // remove server plugin
      // edit request should still be pending (edit plugin still here)
      const stillPending = bridge.claimNextRequestForPhysical('p1', 'unregister-test');
      expect(stillPending).toBeTruthy();

      // server request should have been rejected
      await expect(serverReq).rejects.toThrow(/disconnected/);

      // Clean up the edit request to avoid hanging promise.
      bridge.resolveRequest(stillPending!.requestId, {});
      await editReq;
    });

    test('unregisterInstanceId immediately removes every role for an instance', async () => {
      register(bridge, { pluginSessionId: 'edit-1', instanceId: 'anon:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'server-1', instanceId: 'anon:1', role: 'server' });
      register(bridge, { pluginSessionId: 'client-1', instanceId: 'anon:1', role: 'client' });
      register(bridge, { pluginSessionId: 'edit-2', instanceId: 'anon:2', role: 'edit' });

      const removed = bridge.unregisterInstanceId('anon:1');

      expect(removed.map((inst) => inst.role).sort()).toEqual(['client-1', 'edit', 'server']);
      expect(bridge.getPublicInstances().map((inst) => inst.instanceId)).toEqual(['anon:2']);
    });
  });
});

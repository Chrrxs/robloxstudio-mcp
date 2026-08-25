import { BridgeService } from '../bridge-service.js';

class MirroredBridgeService extends BridgeService {
  constructor(private readonly mirroredInstances: ReturnType<BridgeService['getInstances']>) {
    super();
  }

  override getInstances() {
    return this.mirroredInstances;
  }
}

function register(b: BridgeService, opts: { pluginSessionId: string; instanceId: string; role: string; placeId?: number; placeName?: string }) {
  const res = b.registerInstance({
    pluginSessionId: opts.pluginSessionId,
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
    test('queues a request and returns it on matching poll', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      bridge.sendRequest('/api/test', { hello: 'world' }, 'place:1', 'edit');

      const pending = bridge.getPendingRequest('place:1', 'edit');
      expect(pending).toBeTruthy();
      expect(pending!.request.endpoint).toBe('/api/test');
      expect(pending!.request.data).toEqual({ hello: 'world' });
    });

    test('does not return request to non-matching role', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:1', role: 'server' });
      bridge.sendRequest('/api/test', {}, 'place:1', 'edit');

      expect(bridge.getPendingRequest('place:1', 'server')).toBeNull();
      expect(bridge.getPendingRequest('place:1', 'edit')).toBeTruthy();
    });

    test('does not return request to non-matching instanceId', async () => {
      bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      expect(bridge.getPendingRequest('place:2', 'edit')).toBeNull();
      expect(bridge.getPendingRequest('place:1', 'edit')).toBeTruthy();
    });

    test('does not return the same request twice while response is in flight', async () => {
      bridge.sendRequest('/api/test', { mutates: true }, 'place:1', 'server');

      const first = bridge.getPendingRequest('place:1', 'server');
      expect(first).toBeTruthy();
      expect(bridge.getPendingRequest('place:1', 'server')).toBeNull();

      bridge.resolveRequest(first!.requestId, { ok: true });
      expect(bridge.getPendingRequest('place:1', 'server')).toBeNull();
    });

    test('resolves request when response received', async () => {
      const promise = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      const pending = bridge.getPendingRequest('place:1', 'edit');
      // Use the public API
      bridge.resolveRequest(pending!.requestId, { ok: true });
      await expect(promise).resolves.toEqual({ ok: true });
      // The promise inside sendRequest is fulfilled — verify by re-querying.
      expect(bridge.getPendingRequest('place:1', 'edit')).toBeNull();
    });

    test('times out request after 30s', async () => {
      const promise = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      jest.advanceTimersByTime(31000);
      await expect(promise).rejects.toThrow('Request timeout');
    });

    test('FIFO ordering within (instanceId, role)', async () => {
      bridge.sendRequest('/api/a', { order: 1 }, 'place:1', 'edit');
      jest.advanceTimersByTime(10);
      bridge.sendRequest('/api/b', { order: 2 }, 'place:1', 'edit');
      jest.advanceTimersByTime(10);
      bridge.sendRequest('/api/c', { order: 3 }, 'place:1', 'edit');

      const first = bridge.getPendingRequest('place:1', 'edit');
      expect(first!.request.data.order).toBe(1);
      bridge.resolveRequest(first!.requestId, {});

      const second = bridge.getPendingRequest('place:1', 'edit');
      expect(second!.request.data.order).toBe(2);
    });

    test('wakes a waiting poll when a matching request is queued', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const poll = bridge.waitForPendingRequest('p1');
      const response = bridge.sendRequest('/api/test', { hello: 'world' }, 'place:1', 'edit');

      const delivery = await poll;
      expect(delivery.kind).toBe('request');
      if (delivery.kind !== 'request') throw new Error('expected request delivery');
      expect(delivery.request).toEqual({
        endpoint: '/api/test',
        data: { hello: 'world' },
      });

      bridge.resolveRequest(delivery.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('claims work queued before polling without retaining a poll deadline', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const response = bridge.sendRequest('/api/test', { queued: true }, 'place:1', 'edit');

      const delivery = await bridge.waitForPendingRequest('p1');
      expect(delivery.kind).toBe('request');
      if (delivery.kind !== 'request') throw new Error('expected request delivery');
      expect(delivery.request.data).toEqual({ queued: true });

      bridge.resolveRequest(delivery.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
      expect(jest.getTimerCount()).toBe(0);
    });

    test('isolates concurrent waiting polls across 12 active Studio instances', async () => {
      const instanceNumbers = Array.from({ length: 12 }, (_, index) => index + 1);
      const polls = instanceNumbers.map((number) => {
        register(bridge, {
          pluginSessionId: `session-${number}`,
          instanceId: `place:${number}`,
          role: 'edit',
        });
        return bridge.waitForPendingRequest(`session-${number}`);
      });

      const responses = [...instanceNumbers]
        .reverse()
        .map((number) => bridge.sendRequest(
          '/api/test',
          { instance: number },
          `place:${number}`,
          'edit',
        ));
      const deliveries = await Promise.all(polls);

      for (const [index, delivery] of deliveries.entries()) {
        expect(delivery.kind).toBe('request');
        if (delivery.kind !== 'request') throw new Error('expected request delivery');
        expect(delivery.request.data).toEqual({ instance: index + 1 });
        bridge.resolveRequest(delivery.requestId, { ok: true });
      }
      await expect(Promise.all(responses)).resolves.toHaveLength(12);
    });

    test('one plugin session cannot hold more than one waiting poll', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const firstPoll = bridge.waitForPendingRequest('p1');
      const secondPoll = bridge.waitForPendingRequest('p1');

      await expect(firstPoll).resolves.toEqual({ kind: 'superseded' });
      const response = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      const delivery = await secondPoll;
      expect(delivery.kind).toBe('request');
      if (delivery.kind !== 'request') throw new Error('expected request delivery');
      bridge.resolveRequest(delivery.requestId, {});
      await expect(response).resolves.toEqual({});
    });

    test('an open poll remains live past the duplicate takeover threshold', async () => {
      register(bridge, { pluginSessionId: 'active-session', instanceId: 'anon:active', role: 'edit' });
      const controller = new AbortController();
      const poll = bridge.waitForPendingRequest('active-session', { signal: controller.signal });
      jest.advanceTimersByTime(10_000);

      const duplicate = bridge.registerInstance({
        pluginSessionId: 'duplicate-session',
        instanceId: 'anon:active',
        role: 'edit',
      });
      expect(duplicate.ok).toBe(false);
      expect(bridge.getInstanceBySessionId('active-session')).toBeDefined();

      controller.abort();
      await expect(poll).resolves.toEqual({ kind: 'aborted' });
      const replacement = bridge.registerInstance({
        pluginSessionId: 'replacement-session',
        instanceId: 'anon:active',
        role: 'edit',
      });
      expect(replacement.ok).toBe(true);
    });

    test('a timed-out poll refreshes session liveness at the completed exchange', async () => {
      register(bridge, { pluginSessionId: 'active-session', instanceId: 'anon:active', role: 'edit' });
      const poll = bridge.waitForPendingRequest('active-session', { timeoutMs: 15_000 });
      jest.advanceTimersByTime(15_000);
      await expect(poll).resolves.toEqual({ kind: 'timeout' });

      jest.advanceTimersByTime(2_500);
      const premature = bridge.registerInstance({
        pluginSessionId: 'replacement-session',
        instanceId: 'anon:active',
        role: 'edit',
      });
      expect(premature.ok).toBe(false);

      jest.advanceTimersByTime(501);
      const replacement = bridge.registerInstance({
        pluginSessionId: 'replacement-session',
        instanceId: 'anon:active',
        role: 'edit',
      });
      expect(replacement.ok).toBe(true);
    });

    test('disconnecting a plugin releases its waiting poll', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const poll = bridge.waitForPendingRequest('p1');
      bridge.unregisterInstance('p1');
      await expect(poll).resolves.toEqual({ kind: 'session_closed' });
    });

    test('does not redeliver a mutating request after a poll claims it', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const response = bridge.sendRequest('/api/test', { mutates: true }, 'place:1', 'edit');
      const firstDelivery = await bridge.waitForPendingRequest('p1');
      expect(firstDelivery.kind).toBe('request');
      if (firstDelivery.kind !== 'request') throw new Error('expected request delivery');

      const retryPoll = bridge.waitForPendingRequest('p1', { timeoutMs: 100 });
      jest.advanceTimersByTime(100);
      await expect(retryPoll).resolves.toEqual({ kind: 'timeout' });

      bridge.resolveRequest(firstDelivery.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('aborting an idle poll removes only its waiter', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      const controller = new AbortController();
      const abortedPoll = bridge.waitForPendingRequest('p1', { signal: controller.signal });
      controller.abort();
      await expect(abortedPoll).resolves.toEqual({ kind: 'aborted' });

      const response = bridge.sendRequest('/api/test', {}, 'place:1', 'edit');
      const nextDelivery = await bridge.waitForPendingRequest('p1');
      expect(nextDelivery.kind).toBe('request');
      if (nextDelivery.kind !== 'request') throw new Error('expected request delivery');
      bridge.resolveRequest(nextDelivery.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('bridge shutdown releases all idle polls', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'place:1', role: 'edit' });
      register(bridge, { pluginSessionId: 'p2', instanceId: 'place:2', role: 'edit' });
      const polls = [
        bridge.waitForPendingRequest('p1'),
        bridge.waitForPendingRequest('p2'),
      ];

      bridge.clearAllPendingRequests();
      await expect(Promise.all(polls)).resolves.toEqual([
        { kind: 'bridge_closed' },
        { kind: 'bridge_closed' },
      ]);
    });

    test('a waiting session follows anon-to-published identity migration', async () => {
      register(bridge, { pluginSessionId: 'p1', instanceId: 'anon:old', role: 'edit' });
      const poll = bridge.waitForPendingRequest('p1');
      bridge.updateInstanceMetadata('p1', { placeId: 52 });
      const response = bridge.sendRequest('/api/test', {}, 'place:52', 'edit');

      const delivery = await poll;
      expect(delivery.kind).toBe('request');
      if (delivery.kind !== 'request') throw new Error('expected request delivery');
      bridge.resolveRequest(delivery.requestId, { ok: true });
      await expect(response).resolves.toEqual({ ok: true });
    });

    test('bounds tokenless held polls above the 12-Studio operating envelope', async () => {
      const polls = Array.from({ length: 128 }, (_, index) => {
        register(bridge, {
          pluginSessionId: `session-${index}`,
          instanceId: `place:${index}`,
          role: 'edit',
        });
        return bridge.waitForPendingRequest(`session-${index}`);
      });
      register(bridge, {
        pluginSessionId: 'overflow-session',
        instanceId: 'place:overflow',
        role: 'edit',
      });

      await expect(bridge.waitForPendingRequest('overflow-session')).resolves.toEqual({
        kind: 'capacity',
      });
      bridge.clearAllPendingRequests();
      const settled = await Promise.all(polls);
      expect(settled.every((result) => result.kind === 'bridge_closed')).toBe(true);
    });
  });

  describe('registerInstance', () => {
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

      const polled = bridge.getPendingRequest('place:12345', 'edit');
      expect(polled).toBeTruthy();
      bridge.resolveRequest(polled!.requestId, { ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    test('routing works for proxy-style bridges that mirror instances via getInstances', () => {
      const mirrored = new MirroredBridgeService([
        {
          pluginSessionId: 'edit',
          instanceId: 'anon:mirrored-place-id',
          role: 'edit',
          placeId: 0,
          placeName: 'MirroredPlace',
          dataModelName: 'MirroredPlace',
          isRunning: false,
          pluginVersion: '2.16.1',
          pluginVariant: 'main',
          serverVersion: '2.16.1',
          versionMismatch: false,
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

      jest.advanceTimersByTime(3_001);
      const relaunched = bridge.registerInstance({
        pluginSessionId: 'new-session',
        instanceId: 'anon:relaunch',
        role: 'edit',
      });

      expect(relaunched.ok).toBe(true);
      expect(bridge.getInstanceBySessionId('old-session')).toBeUndefined();
      expect(bridge.getInstanceBySessionId('new-session')).toBeDefined();
      expect(bridge.getPendingRequest('anon:relaunch', 'edit')).toBeNull();
      await expect(pending).rejects.toThrow(/disconnected/);
    });

    test('recent polling prevents an active duplicate from being taken over', () => {
      register(bridge, { pluginSessionId: 'active-session', instanceId: 'anon:active', role: 'edit' });
      jest.advanceTimersByTime(2_500);
      bridge.updateInstanceActivity('active-session');
      jest.advanceTimersByTime(2_500);

      const duplicate = bridge.registerInstance({
        pluginSessionId: 'duplicate-session',
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
      bridge.unregisterInstance('p1');
      await expect(req).rejects.toThrow(/disconnected/);
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
      const stillPending = bridge.getPendingRequest('place:1', 'edit');
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

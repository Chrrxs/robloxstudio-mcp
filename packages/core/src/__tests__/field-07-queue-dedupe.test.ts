import { BridgeService } from '../bridge-service.js';
import type { RegisterPeerInput } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

class QueueTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

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

describe('field #7 queue position and timeout guidance', () => {
  let bridge: BridgeService;

  beforeEach(() => {
    bridge = new QueueTestBridge();
    jest.useFakeTimers();
    register(bridge, { peerId: 'edit-peer', instanceId: 'instance:queue', role: 'edit' });
    register(bridge, { peerId: 'server-peer', transportPeerId: 'edit-peer', instanceId: 'instance:queue', role: 'server' });
    register(bridge, { peerId: 'other-edit', instanceId: 'instance:other', role: 'edit' });
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test('queuedAhead counts unsettled requests sharing the target transport at enqueue time', async () => {
    const ids = ['q0', 'q1', 'q2', 'q3', 'q4'];
    const promises = ids.map((id, index) => bridge.sendRequest('/api/execute-luau', { code: `return ${index}` }, index === 2 ? 'server-peer' : 'edit-peer', 30_000, undefined, id));
    const other = bridge.sendRequest('/api/execute-luau', { code: 'return 9' }, 'other-edit', 30_000, undefined, 'other');
    expect(ids.map((id) => bridge.getRequestStatus(id)?.queuedAhead)).toEqual([0, 1, 2, 3, 4]);
    expect(bridge.getRequestStatus('other')?.queuedAhead).toBe(0);
    for (let claimed = bridge.claimNextRequestForTransport('edit-peer', 'socket'); claimed; claimed = bridge.claimNextRequestForTransport('edit-peer', 'socket')) {
      expect(bridge.settleTransportResponse('edit-peer', claimed.requestId, { success: true })).toBe('accepted');
    }
    await Promise.all(promises);
    const late = bridge.sendRequest('/api/execute-luau', { code: 'return late' }, 'edit-peer', 30_000, undefined, 'late');
    expect(bridge.getRequestStatus('late')?.queuedAhead).toBe(0);
    bridge.claimNextRequestForTransport('edit-peer', 'socket');
    bridge.settleTransportResponse('edit-peer', 'late', { success: true });
    bridge.claimNextRequestForTransport('other-edit', 'socket');
    bridge.settleTransportResponse('other-edit', 'other', { success: true });
    await Promise.all([late, other]);
  });

  test('a timed-out waiter names get_request_status and the operation id', async () => {
    const pending = bridge.sendRequest('/api/execute-luau', { code: 'task.wait(60)' }, 'edit-peer', 30_000, undefined, 'slow-op');
    const failure = expect(pending).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('call get_request_status with operation_id slow-op; do not resend'),
      details: { requestId: 'slow-op', stage: 'dispatched', outcome: 'unknown' },
    });
    expect(bridge.claimNextRequestForTransport('edit-peer', 'socket')?.requestId).toBe('slow-op');
    await jest.advanceTimersByTimeAsync(30_000);
    await failure;
  });
});

describe('field #7 automatic execute_luau dedupe without operation_id', () => {
  const code = 'Instance.new("Folder", workspace)';
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  const flush = () => jest.advanceTimersByTimeAsync(0);
  const settleNext = (value: unknown) => {
    const delivery = bridge.claimNextRequestForTransport('edit', 'socket');
    if (!delivery) return undefined;
    expect(bridge.settleTransportResponse('edit', delivery.requestId, { success: true, returnValue: value })).toBe('accepted');
    return delivery.requestId;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new QueueTestBridge();
    tools = new RobloxStudioTools(bridge);
    register(bridge, { peerId: 'edit', instanceId: 'instance:recovery', role: 'edit', placeName: 'Recovery' });
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test('identical code while the first is still pending → one dispatch; second result carries deduplicatedFrom', async () => {
    const first = tools.executeLuau(code, 'edit', 'instance:recovery');
    const second = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    const dispatchedId = settleNext('one');
    expect(dispatchedId).toMatch(/^auto-[0-9a-f]{64}$/);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    const firstBody = JSON.parse((await first).content[0].text);
    const secondBody = JSON.parse((await second).content[0].text);
    expect(firstBody).toMatchObject({ returnValue: 'one', operationId: dispatchedId, dedupe: 'auto', queued_ahead: 0 });
    expect(firstBody.deduplicatedFrom).toBeUndefined();
    expect(secondBody).toMatchObject({ returnValue: 'one', operationId: dispatchedId, dedupe: 'auto', deduplicatedFrom: dispatchedId });
  });

  test('a delivered result never dedupes the next identical call → two dispatches, no deduplicatedFrom', async () => {
    const first = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    const firstId = settleNext('one');
    expect(JSON.parse((await first).content[0].text)).toMatchObject({ returnValue: 'one', operationId: firstId });
    const second = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    const secondId = settleNext('two');
    expect(secondId).toBe(`${firstId}-2`);
    const secondBody = JSON.parse((await second).content[0].text);
    expect(secondBody).toMatchObject({ returnValue: 'two', operationId: secondId, dedupe: 'auto' });
    expect(secondBody.deduplicatedFrom).toBeUndefined();
    const third = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    expect(settleNext('three')).toBe(`${firstId}-3`);
    expect(JSON.parse((await third).content[0].text)).toMatchObject({ returnValue: 'three' });
  });

  test('a result settled after its waiter timed out (undelivered) dedupes the next identical call', async () => {
    const first = tools.executeLuau(code, 'edit', 'instance:recovery');
    const failure = expect(first).rejects.toMatchObject({ code: 'request_timeout' });
    await flush();
    const delivery = bridge.claimNextRequestForTransport('edit', 'socket');
    expect(delivery?.requestId).toMatch(/^auto-[0-9a-f]{64}$/);
    await jest.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(bridge.settleTransportResponse('edit', delivery!.requestId, { success: true, returnValue: 'late' })).toBe('accepted');
    expect(bridge.getRequestStatus(delivery!.requestId)).toMatchObject({ state: 'settled', waiterEndedAt: expect.any(Number) });
    const retry = tools.executeLuau(code, 'edit', 'instance:recovery');
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    expect(JSON.parse((await retry).content[0].text)).toMatchObject({
      returnValue: 'late', operationId: delivery!.requestId, dedupe: 'auto', deduplicatedFrom: delivery!.requestId,
    });
  });

  test('different code → two dispatches with distinct auto ids', async () => {
    const a = tools.executeLuau('return 1', 'edit', 'instance:recovery');
    const b = tools.executeLuau('return 2', 'edit', 'instance:recovery');
    await flush();
    const idA = settleNext(1);
    const idB = settleNext(2);
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
    expect(JSON.parse((await a).content[0].text)).toMatchObject({ returnValue: 1, operationId: idA, queued_ahead: 0 });
    expect(JSON.parse((await b).content[0].text)).toMatchObject({ returnValue: 2, operationId: idB, queued_ahead: 1 });
  });

  test('dedupe:false or a new operation_id re-runs identical code', async () => {
    const first = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    const autoId = settleNext('one');
    await first;
    const forced = tools.executeLuau(code, 'edit', 'instance:recovery', undefined, undefined, false);
    await flush();
    const forcedId = settleNext('two');
    expect(forcedId).toBeDefined();
    expect(forcedId).not.toBe(autoId);
    const forcedBody = JSON.parse((await forced).content[0].text);
    expect(forcedBody).toMatchObject({ returnValue: 'two', operationId: forcedId });
    expect(forcedBody.dedupe).toBeUndefined();
    expect(forcedBody.deduplicatedFrom).toBeUndefined();
    const explicit = tools.executeLuau(code, 'edit', 'instance:recovery', 'explicit-rerun');
    await flush();
    expect(settleNext('three')).toBe('explicit-rerun');
    expect(JSON.parse((await explicit).content[0].text)).toMatchObject({ returnValue: 'three', operationId: 'explicit-rerun' });
  });

  test('after the 5 minute retention window identical code runs again', async () => {
    const first = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    const autoId = settleNext('one');
    await first;
    await jest.advanceTimersByTimeAsync(5 * 60_000 + 1);
    const again = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    expect(settleNext('fresh')).toBe(autoId);
    const body = JSON.parse((await again).content[0].text);
    expect(body).toMatchObject({ returnValue: 'fresh', operationId: autoId, dedupe: 'auto' });
    expect(body.deduplicatedFrom).toBeUndefined();
  });

  test('timed-out dispatched code with unknown outcome is not re-run automatically', async () => {
    const first = tools.executeLuau(code, 'edit', 'instance:recovery');
    const failure = expect(first).rejects.toMatchObject({ code: 'request_timeout' });
    await flush();
    const delivery = bridge.claimNextRequestForTransport('edit', 'socket');
    expect(delivery).toBeDefined();
    await jest.advanceTimersByTimeAsync(30_000);
    await failure;
    await expect(tools.executeLuau(code, 'edit', 'instance:recovery')).rejects.toMatchObject({
      code: 'operation_not_replayed',
      message: expect.stringContaining(`call get_request_status with operation_id ${delivery!.requestId}; do not resend`),
    });
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    const forced = tools.executeLuau(code, 'edit', 'instance:recovery', undefined, undefined, false);
    await flush();
    expect(settleNext('forced')).not.toBe(delivery!.requestId);
    expect(JSON.parse((await forced).content[0].text)).toMatchObject({ returnValue: 'forced' });
  });

  test('a queued request that never dispatched moves to the next auto id and runs', async () => {
    const first = tools.executeLuau(code, 'edit', 'instance:recovery');
    const failure = expect(first).rejects.toMatchObject({ code: 'request_timeout', details: { outcome: 'not_executed' } });
    await jest.advanceTimersByTimeAsync(30_000);
    await failure;
    const retry = tools.executeLuau(code, 'edit', 'instance:recovery');
    await flush();
    const retryId = settleNext('ran');
    expect(retryId).toMatch(/^auto-[0-9a-f]{64}-2$/);
    expect(JSON.parse((await retry).content[0].text)).toMatchObject({ returnValue: 'ran', operationId: retryId, dedupe: 'auto' });
  });

  test('execute_luau truncates the return value to max_output_bytes with accounting', async () => {
    const pending = tools.executeLuau('return big', 'edit', 'instance:recovery', 'big-return', 1000);
    await flush();
    settleNext('x'.repeat(200_000));
    const body = JSON.parse((await pending).content[0].text);
    expect(body).toMatchObject({ truncated: true, totalBytes: 200_000, returnedBytes: 1000, maxOutputBytes: 1000 });
    expect(body.returnValue).toBe('x'.repeat(1000));
    await expect(tools.executeLuau('return 1', 'edit', 'instance:recovery', undefined, 60 * 1024 * 1024)).rejects.toThrow('max_output_bytes');
    await expect(tools.executeLuau('return 1', 'edit', 'instance:recovery', undefined, undefined, 'always' as unknown as false)).rejects.toThrow('dedupe');
  });
});

import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

class RecoveryTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

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
  });
  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test.each(['execute_luau', 'set_properties'])('%s recovers a late result using caller operation identity', async tool => {
    const operationId = `recovery-${tool}`;
    const invoke = () => tool === 'execute_luau'
      ? tools.executeLuau('return 42', 'edit', 'instance:recovery', operationId)
      : tools.setProperties('game.Workspace.Text', { Value: 'recipe' }, 'instance:recovery', operationId);
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

  test('unknown and expired IDs never claim the mutation was unexecuted', async () => {
    const result = await tools.getRequestStatus('unknown');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ state: 'unknown', outcome: 'unknown' });
    await expect(tools.getRequestStatus('')).rejects.toThrow('request_id');
  });
});

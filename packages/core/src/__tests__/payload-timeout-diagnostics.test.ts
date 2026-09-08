import { BridgeService, RequestFailure } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

class DiagnosticBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated peers must not touch the machine's managed Studio registry.
  }
}

// Transport fault injections: no claim about Studio's own payload limit.
describe('issue 75 mutation timeout diagnostics', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new DiagnosticBridge();
    tools = new RobloxStudioTools(bridge);
    const registered = bridge.registerPeer({
      peerId: 'edit-peer', transportPeerId: 'edit-peer',
      instanceId: 'instance:payload', role: 'edit', placeId: 0, placeName: 'Payload',
    });
    expect(registered.ok).toBe(true);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test.each(['execute_luau', 'set_properties'])('%s preserves timeout attribution and recovers a late result without replay', async (tool) => {
    const text = 'a'.repeat(10_000);
    const invoke = (operationId: string) => tool === 'execute_luau'
      ? tools.executeLuau(`workspace:SetAttribute('Chunk', '${text}')`, 'edit', 'instance:payload', operationId)
      : tools.setProperties('game.Workspace.Text', { Value: text }, 'instance:payload', operationId);
    const failure = (pending: Promise<unknown>) => pending.then(
      () => { throw new Error('Expected injected timeout'); },
      (error: unknown) => {
        if (!(error instanceof RequestFailure)) throw error;
        return error;
      },
    );

    const queued = failure(invoke('queued-mutation'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect((await queued).details).toMatchObject({
      requestId: 'queued-mutation', stage: 'queued', outcome: 'not_executed',
    });
    expect(bridge.claimNextRequestForTransport('edit-peer', 'socket')).toBeNull();

    const delivered = failure(invoke('dispatched-mutation'));
    const command = bridge.claimNextRequestForTransport('edit-peer', 'socket');
    expect(command?.requestId).toBe('dispatched-mutation');
    await jest.advanceTimersByTimeAsync(30_000);
    expect((await delivered).details).toMatchObject({
      requestId: 'dispatched-mutation', stage: 'dispatched', outcome: 'unknown',
    });
    expect(bridge.getPublicInstances()).toEqual([
      expect.objectContaining({ id: 'instance:payload' }),
    ]);
    const lateResponse = bridge.settleTransportResponse('edit-peer', 'dispatched-mutation', { success: true });
    expect(lateResponse).toBe('accepted');
    expect(bridge.getRequestStatus('dispatched-mutation')).toMatchObject({
      outcome: 'success', response: { success: true },
    });
    await expect(invoke('dispatched-mutation')).resolves.toMatchObject({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
    });
    expect(bridge.claimNextRequestForTransport('edit-peer', 'reconnected-socket')).toBeNull();
  });
});

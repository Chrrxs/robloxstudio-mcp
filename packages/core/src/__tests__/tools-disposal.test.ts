import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';

test('disposal drains pending associations and unsubscribes from future peers', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<StudioInstanceManager['pendingLaunches']>>>();
  const lookup = jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockReturnValue(pending.promise);
  const bridge = new BridgeService();
  const tools = new RobloxStudioTools(bridge);
  const register = (id: string) => bridge.registerPeer({ peerId: id, transportPeerId: id, instanceId: id, role: 'edit' });
  try {
    register('first');
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(1);
    let disposed = false;
    const disposal = tools.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    pending.resolve([]);
    await disposal;
    register('second');
    await tools.dispose();
    expect(lookup).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve([]);
    await tools.dispose();
    lookup.mockRestore();
  }
});

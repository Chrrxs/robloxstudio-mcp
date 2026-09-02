import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

function registerRole(
  bridge: BridgeService,
  peerId: string,
  role: string,
  isRunning: boolean,
  transportPeerId = peerId,
) {
  const result = bridge.registerPeer({
    peerId,
    transportPeerId,
    instanceId: 'instance:test',
    role,
    placeId: 0,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning,
  });
  if (!result.ok) throw new Error(`registerPeer failed: ${result.error.code}`);
}

describe('selection lifecycle tool', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('routes get and set to edit while view follows the screenshot viewport', async () => {
    const bridge = new BridgeService();
    registerRole(bridge, 'edit-session', 'edit', false);
    registerRole(bridge, 'server-session', 'server', true);
    registerRole(bridge, 'client-session', 'client-1', true, 'server-session');

    const request = jest.spyOn(StudioHttpClient.prototype, 'request')
      .mockResolvedValue({ success: true });
    const tools = new RobloxStudioTools(bridge);

    await tools.selection('get', {}, 'instance:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/get-selection',
      {},
      'edit-session',
      undefined,
      undefined,
    );

    await tools.selection('set', { paths: [], mode: 'set' }, 'instance:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/set-selection',
      { paths: [], mode: 'set' },
      'edit-session',
      undefined,
      undefined,
    );

    await tools.selection('view', {
      path: 'game.Workspace.Subject',
      padding: 1.25,
    }, 'instance:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/focus-viewport',
      {
        path: 'game.Workspace.Subject',
        from: undefined,
        padding: 1.25,
        angleY: undefined,
      },
      'client-session',
      undefined,
      undefined,
    );
  });

  test('rejects invalid lifecycle arguments before dispatch', async () => {
    const tools = new RobloxStudioTools(new BridgeService());

    await expect(tools.selection('set', { paths: [''] }, 'instance:test'))
      .rejects.toThrow('non-empty instance paths');
    await expect(tools.selection('view', { path: 'game.Workspace.Subject', padding: 0 }, 'instance:test'))
      .rejects.toThrow('greater than 0');
    await expect(tools.selection('view', { path: 'game.Workspace.Subject', angleY: 90 }, 'instance:test'))
      .rejects.toThrow('between -89 and 89');
    await expect(tools.selection('unknown', {}, 'instance:test'))
      .rejects.toThrow('action=get|set|view');
  });
});

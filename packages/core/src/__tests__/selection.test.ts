import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';

function registerRole(bridge: BridgeService, pluginSessionId: string, role: string, isRunning: boolean) {
  const result = bridge.registerInstance({
    pluginSessionId,
    instanceId: 'place:test',
    role,
    placeId: 0,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning,
  });
  if (!result.ok) throw new Error(`registerInstance failed: ${result.error.code}`);
}

describe('selection lifecycle tool', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('routes get and set to edit while view follows the screenshot viewport', async () => {
    const bridge = new BridgeService();
    registerRole(bridge, 'edit-session', 'edit', false);
    registerRole(bridge, 'client-session', 'client-1', true);

    const request = jest.spyOn(StudioHttpClient.prototype, 'request')
      .mockResolvedValue({ success: true });
    const tools = new RobloxStudioTools(bridge);

    await tools.selection('get', {}, 'place:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/get-selection',
      {},
      'place:test',
      'edit',
      undefined,
    );

    await tools.selection('set', { paths: [], mode: 'set' }, 'place:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/set-selection',
      { paths: [], mode: 'set' },
      'place:test',
      'edit',
      undefined,
    );

    await tools.selection('view', {
      path: 'game.Workspace.Subject',
      padding: 1.25,
    }, 'place:test');
    expect(request).toHaveBeenLastCalledWith(
      '/api/focus-viewport',
      {
        path: 'game.Workspace.Subject',
        from: undefined,
        padding: 1.25,
        angleY: undefined,
      },
      'place:test',
      'client-1',
      undefined,
    );
  });

  test('rejects invalid lifecycle arguments before dispatch', async () => {
    const tools = new RobloxStudioTools(new BridgeService());

    await expect(tools.selection('set', { paths: [''] }, 'place:test'))
      .rejects.toThrow('non-empty instance paths');
    await expect(tools.selection('view', { path: 'game.Workspace.Subject', padding: 0 }, 'place:test'))
      .rejects.toThrow('greater than 0');
    await expect(tools.selection('view', { path: 'game.Workspace.Subject', angleY: 90 }, 'place:test'))
      .rejects.toThrow('between -89 and 89');
    await expect(tools.selection('unknown', {}, 'place:test'))
      .rejects.toThrow('action=get|set|view');
  });
});

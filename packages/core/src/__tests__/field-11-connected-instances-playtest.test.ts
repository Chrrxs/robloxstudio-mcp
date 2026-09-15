// Field report #11 (+ the instances half of #9): get_connected_instances reports playtest
// {active, mode, startedAt} from the runtime peers and windowTitle/processId from a faked
// Studio process snapshot (no PowerShell in unit tests).
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { StudioProcessInfo, StudioProcessSnapshot } from '../studio-instance-manager.js';

const EDIT_PEER = {
  peerId: 'edit-1',
  transportPeerId: 'edit-1',
  instanceId: 'instance:restart',
  role: 'edit',
  placeId: 0,
  placeName: 'RestartPlace.rbxl',
  dataModelName: 'RestartPlace',
  isRunning: false,
  pluginVersion: 'test-version',
  pluginVariant: 'main',
  timestamp: Date.now(),
};

function runtimePeer(role: 'server' | 'client', peerId: string, transportPeerId = 'server-1') {
  return { ...EDIT_PEER, peerId, transportPeerId, role, isRunning: true };
}

function parse(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? '{}') as Record<string, unknown>;
}

function toolsWithWindows(bridge: BridgeService, processes: StudioProcessInfo[] = []): RobloxStudioTools {
  const tools = new RobloxStudioTools(bridge);
  (tools as unknown as { studioWindowLookup: () => Promise<StudioProcessSnapshot> }).studioWindowLookup =
    async () => ({ status: 'ok', observedAt: Date.now(), processes });
  return tools;
}

describe('field #11 / #9 get_connected_instances playtest and window fields', () => {
  test('idle instance reports playtest.active=false and no window when none is found', async () => {
    const bridge = new BridgeService();
    const tools = toolsWithWindows(bridge);
    bridge.registerPeer(EDIT_PEER);

    const body = parse(await tools.getConnectedInstances());
    const instances = body.instances as Array<Record<string, unknown>>;
    expect(instances).toHaveLength(1);
    expect(instances[0].playtest).toEqual({ active: false });
    expect(instances[0]).not.toHaveProperty('windowTitle');
    expect(instances[0]).not.toHaveProperty('processId');
  });

  test('play session reports mode play with an ISO startedAt from the earliest runtime peer', async () => {
    const bridge = new BridgeService();
    const tools = toolsWithWindows(bridge);
    bridge.registerPeer(EDIT_PEER);
    const before = Date.now();
    bridge.registerPeer(runtimePeer('server', 'server-1'));
    bridge.registerPeer(runtimePeer('client', 'client-1'));

    const body = parse(await tools.getConnectedInstances());
    const playtest = (body.instances as Array<{ playtest: { active: boolean; mode?: string; startedAt?: string } }>)[0].playtest;
    expect(playtest.active).toBe(true);
    expect(playtest.mode).toBe('play');
    const startedAt = Date.parse(playtest.startedAt ?? '');
    expect(startedAt).toBeGreaterThanOrEqual(before - 1);
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 1);
  });

  test('server-only session reports mode run', async () => {
    const bridge = new BridgeService();
    const tools = toolsWithWindows(bridge);
    bridge.registerPeer(EDIT_PEER);
    bridge.registerPeer(runtimePeer('server', 'server-1'));

    const body = parse(await tools.getConnectedInstances());
    expect((body.instances as Array<{ playtest: unknown }>)[0].playtest).toMatchObject({ active: true, mode: 'run' });
  });

  test.each([
    ['published place title', 'RestartPlace - Roblox Studio'],
    ['local file title with a full path', String.raw`C:\places\RestartPlace.rbxl - Roblox Studio`],
  ])('window title and process id are matched by place name (%s)', async (_label, title) => {
    const bridge = new BridgeService();
    const tools = toolsWithWindows(bridge, [
      { Id: 4242, Name: 'RobloxStudioBeta', MainWindowTitle: String.raw`C:\places\OtherPlace.rbxl - Roblox Studio` },
      { Id: 1337, Name: 'RobloxStudioBeta', MainWindowTitle: title },
    ]);
    bridge.registerPeer(EDIT_PEER);

    const body = parse(await tools.getConnectedInstances());
    expect((body.instances as Array<Record<string, unknown>>)[0]).toMatchObject({
      windowTitle: title,
      processId: 1337,
    });
  });

  test('ambiguous window titles leave the window fields out', async () => {
    const bridge = new BridgeService();
    const tools = toolsWithWindows(bridge, [
      { Id: 1, Name: 'RobloxStudioBeta', MainWindowTitle: 'RestartPlace - Roblox Studio' },
      { Id: 2, Name: 'RobloxStudioBeta', MainWindowTitle: 'RestartPlace - Roblox Studio' },
    ]);
    (tools as unknown as { instanceManager: unknown }).instanceManager = { get: async () => undefined };
    bridge.registerPeer(EDIT_PEER);

    const instance = (parse(await tools.getConnectedInstances()).instances as Array<Record<string, unknown>>)[0];
    expect(instance).not.toHaveProperty('windowTitle');
    expect(instance).not.toHaveProperty('processId');
  });
});

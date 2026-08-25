import { ProxyBridgeService } from '../proxy-bridge-service.js';
import type { PluginInstance, PublicPluginInstance } from '../bridge-service.js';

function publicInstance(instance: PluginInstance): PublicPluginInstance {
  return {
    instanceId: instance.instanceId,
    role: instance.role,
    placeId: instance.placeId,
    placeName: instance.placeName,
    dataModelName: instance.dataModelName,
    isRunning: instance.isRunning,
    pluginVersion: instance.pluginVersion,
    pluginVariant: instance.pluginVariant,
    serverVersion: instance.serverVersion,
    versionMismatch: instance.versionMismatch,
    lastActivity: instance.lastActivity,
    connectedAt: instance.connectedAt,
  };
}

describe('ProxyBridgeService', () => {
  test('replays cached peers and reports peers discovered after subscription', async () => {
    const now = Date.now();
    const instances: PluginInstance[] = [
      {
        pluginSessionId: 'edit-session',
        instanceId: 'anon:proxy-place',
        role: 'edit',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'ProxyPlace',
        isRunning: false,
        pluginVersion: '2.21.0',
        pluginVariant: 'main',
        serverVersion: '2.21.0',
        versionMismatch: false,
        lastActivity: now,
        connectedAt: now,
      },
    ];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      if (String(input) === 'http://primary/instances') {
        return { ok: true, json: async () => ({ instances: instances.map((instance) => ({ ...instance })) }) } as any;
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      const observed: string[] = [];
      proxy.onInstanceRegistered((instance) => observed.push(`${instance.instanceId}:${instance.role}`));
      expect(observed).toEqual(['anon:proxy-place:edit']);

      instances.push({
        ...instances[0],
        pluginSessionId: 'server-session',
        role: 'server',
        isRunning: true,
        connectedAt: now + 1,
      });
      await (proxy as any).refreshInstances();
      expect(observed).toEqual(['anon:proxy-place:edit', 'anon:proxy-place:server']);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('unregisterInstanceIdEverywhere removes peers from the primary bridge', async () => {
    const now = Date.now();
    const instances: PluginInstance[] = [
      {
        pluginSessionId: 'edit-session',
        instanceId: 'anon:proxy-place',
        role: 'edit',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'ProxyPlace',
        isRunning: false,
        pluginVersion: '2.20.0',
        pluginVariant: 'main',
        serverVersion: '2.20.0',
        versionMismatch: false,
        lastActivity: now,
        connectedAt: now,
      },
      {
        pluginSessionId: 'server-session',
        instanceId: 'anon:proxy-place',
        role: 'server',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'Game',
        isRunning: true,
        pluginVersion: '2.20.0',
        pluginVariant: 'main',
        serverVersion: '2.20.0',
        versionMismatch: false,
        lastActivity: now,
        connectedAt: now,
      },
    ];
    const removed = instances.map(publicInstance);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url === 'http://primary/instances') {
        return { ok: true, json: async () => ({ instances }) } as any;
      }
      if (url === 'http://primary/unregister-instance-id') {
        expect(init).toMatchObject({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        expect(JSON.parse(String(init.body))).toEqual({ instanceId: 'anon:proxy-place' });
        return { ok: true, json: async () => ({ success: true, removed }) } as any;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();

      expect(proxy.getPublicInstances().map((inst) => inst.role).sort()).toEqual(['edit', 'server']);
      await expect(proxy.unregisterInstanceIdEverywhere('anon:proxy-place')).resolves.toEqual(removed);
      expect(proxy.getPublicInstances()).toEqual([]);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });
});

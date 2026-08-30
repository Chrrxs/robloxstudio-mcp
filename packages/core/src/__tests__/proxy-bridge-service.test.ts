import { EventEmitter, once } from 'node:events';
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
        physicalSessionId: 'edit-session',
        instanceId: 'anon:proxy-place',
        role: 'edit',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'ProxyPlace',
        isRunning: false,
        pluginVersion: '2.21.0',
        pluginVariant: 'main',
        serverVersion: '2.21.0',
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
        physicalSessionId: 'server-session',
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
        physicalSessionId: 'edit-session',
        instanceId: 'anon:proxy-place',
        role: 'edit',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'ProxyPlace',
        isRunning: false,
        pluginVersion: '2.20.0',
        pluginVariant: 'main',
        serverVersion: '2.20.0',
        lastActivity: now,
        connectedAt: now,
      },
      {
        pluginSessionId: 'server-session',
        physicalSessionId: 'server-session',
        instanceId: 'anon:proxy-place',
        role: 'server',
        placeId: 0,
        placeName: 'ProxyPlace',
        dataModelName: 'Game',
        isRunning: true,
        pluginVersion: '2.20.0',
        pluginVariant: 'main',
        serverVersion: '2.20.0',
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

  test('forwards request-specific timeouts to the primary bridge', async () => {
    const timeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url === 'http://primary/instances') {
        return { ok: true, json: async () => ({ instances: [] }) } as any;
      }
      if (url === 'http://primary/proxy') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          endpoint: '/api/grep-scripts',
          targetInstanceId: 'place:test',
          targetRole: 'edit',
          timeoutMs: 120_000,
        });
        return { ok: true, json: async () => ({ response: { results: [] } }) } as any;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      await expect(proxy.sendRequest(
        '/api/grep-scripts',
        { pattern: 'needle' },
        'place:test',
        'edit',
        120_000,
      )).resolves.toEqual({ results: [] });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 125_000);
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  test('aborts the primary request when the proxy caller aborts', async () => {
    const lifecycle = new EventEmitter();
    const proxyStarted = once(lifecycle, 'proxy-started');
    const fetchAborted = once(lifecycle, 'fetch-aborted');
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'http://primary/instances') {
        return new Response(JSON.stringify({ instances: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'http://primary/proxy') {
        const requestSignal = init?.signal;
        if (!requestSignal) throw new Error('expected proxy fetch signal');
        requestSignal.addEventListener('abort', () => lifecycle.emit('fetch-aborted'), { once: true });
        lifecycle.emit('proxy-started');
        await once(lifecycle, 'release');
        if (requestSignal.aborted) throw new DOMException('aborted', 'AbortError');
        return new Response(JSON.stringify({ response: { results: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const proxy = new ProxyBridgeService('http://primary');
    const controller = new AbortController();

    try {
      await proxy.waitForInitialRefresh();
      const response = proxy.sendRequest(
        '/api/grep-scripts',
        { pattern: 'needle' },
        'place:test',
        'edit',
        120_000,
        controller.signal,
      );
      response.catch(() => {});
      await proxyStarted;

      controller.abort();

      await fetchAborted;
      lifecycle.emit('release');
      await expect(response).rejects.toThrow('Request aborted');
    } finally {
      lifecycle.emit('release');
      proxy.stop();
      fetchMock.mockRestore();
    }
  });
});

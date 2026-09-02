import { EventEmitter, once } from 'node:events';
import { request as nodeRequest } from 'node:http';
import request from 'supertest';
import { TOOL_HANDLERS, createHttpServer, type RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { detectStudioPlatform } from '../studio-platform.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

class HttpTestBridgeService extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // HTTP route tests do not need managed-Studio lifecycle association.
  }
}

const READY_BODY = {
  peerId: 'peer-1',
  transportPeerId: 'peer-1',
  instanceId: 'instance:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
  pluginVersion: 'test-version',
  pluginVariant: 'main',
  timestamp: 1_700_000_000_000,
};

const TEST_SERVER_CONFIG = {
  name: 'robloxstudio-mcp',
  version: READY_BODY.pluginVersion,
  tools: [],
};

describe('HTTP Server', () => {
  let app: RobloxStudioHttpApp;
  let bridge: HttpTestBridgeService;
  let tools: RobloxStudioTools;
  beforeEach(() => {
    bridge = new HttpTestBridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge, undefined, TEST_SERVER_CONFIG);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  describe('Health Check', () => {
    test('returns health status', async () => {
      const response = await request(app).get('/health').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'robloxstudio-mcp',
        serverName: 'robloxstudio-mcp',
        capabilities: {
          studioLifecycle: {
            protocolVersion: 3,
            endpoint: '/mcp/manage_instance',
          },
        },
        pluginConnected: false,
        instanceCount: 0,
        peerCount: 0,
        instances: [],
        peers: [],
        multiplayerGroups: [],
        mcpServerActive: false,
        activeEventStreams: 0,
      });
    });

    test('advertises Studio lifecycle only when manage_instance is callable', async () => {
      const inspectorApp = createHttpServer(
        tools,
        bridge,
        new Set(['get_place_info']),
        { name: 'robloxstudio-mcp-inspector', version: '2.0.0', tools: [] },
      );

      const response = await request(inspectorApp).get('/health').expect(200);
      expect(response.body.serverName).toBe('robloxstudio-mcp-inspector');
      expect(response.body.capabilities.studioLifecycle).toBeUndefined();
      await request(inspectorApp).post('/mcp/manage_instance').send({ action: 'status' }).expect(404);
    });

    test('advertises the live process-identity launcher capability', async () => {
      const response = await request(app).get('/health').expect(200);
      expect(response.body.capabilities.studioLifecycle).toMatchObject({
        hostPlatform: expect.any(String),
        windowsInteropAvailable: expect.any(Boolean),
        processIdentity: {
          supported: expect.any(Boolean),
          launcher: expect.any(String),
        },
      });
    });

    test('returns a structured guaranteed pre-spawn rejection when process identity is unavailable', async () => {
      const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-registry-'));
      const unsupportedTools = new RobloxStudioTools(bridge);
      Object.defineProperty(unsupportedTools, 'instanceManager', {
        value: new StudioInstanceManager({
          registryDir,
          platformCapabilities: detectStudioPlatform({
            platform: 'linux',
            kernelVersion: 'Linux version 6.8.0-generic',
            windowsInteropAvailable: false,
          }),
          processAdapter: {
            currentBootId: () => 'boot-1',
            observeStudioProcesses: () => ({
              status: 'ok',
              observedAt: Date.now(),
              processes: [],
            }),
          },
        }),
      });
      const unsupportedApp = createHttpServer(
        unsupportedTools,
        bridge,
        new Set(['manage_instance']),
      );

      try {
        const health = await request(unsupportedApp).get('/health').expect(200);
        expect(health.body.capabilities.studioLifecycle.processIdentity).toMatchObject({
          supported: false,
          launcher: 'unavailable',
        });

        const response = await request(unsupportedApp)
          .post('/mcp/manage_instance')
          .send({
            action: 'launch',
            source: 'baseplate',
            require_process_identity: true,
          })
          .expect(409);
        expect(response.body).toEqual(expect.objectContaining({
          error: 'process_identity_unavailable',
          launch_stage: 'pre_spawn',
          process_created: false,
          safe_to_fallback: true,
          launcher: 'unavailable',
          message: expect.stringContaining('require_process_identity'),
          remediation: expect.any(String),
        }));
      } finally {
        fs.rmSync(registryDir, { recursive: true, force: true });
      }
    });
  });

  describe('Tool Handlers', () => {
    test('get_script_source only accepts line_range for range selection', async () => {
      const getScriptSource = jest.fn(async () => ({ content: [] }));
      const fakeTools = { getScriptSource } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.get_script_source(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '10-12',
        instance_id: 'place:test',
      });
      expect(getScriptSource).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 10, 12, 'place:test');

      await TOOL_HANDLERS.get_script_source(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        startLine: 20,
        endLine: 25,
        lineRange: '30-35',
        instance_id: 'place:test',
      });
      expect(getScriptSource).toHaveBeenLastCalledWith('game.ServerScriptService.Main', undefined, undefined, 'place:test');
    });

    test('script line tools parse line_range through the shared handler helpers', async () => {
      const editScriptLines = jest.fn(async () => ({ content: [] }));
      const deleteScriptLines = jest.fn(async () => ({ content: [] }));
      const fakeTools = { editScriptLines, deleteScriptLines } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'old',
        new_string: 'new',
        line_range: '42',
        instance_id: 'place:test',
      });
      expect(editScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 'old', 'new', 42, 'place:test');

      await TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '10-12',
        instance_id: 'place:test',
      });
      expect(deleteScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 10, 12, 'place:test');

      await TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'old',
        new_string: 'new',
        startLine: 99,
        instance_id: 'place:test',
      });
      expect(editScriptLines).toHaveBeenLastCalledWith('game.ServerScriptService.Main', 'old', 'new', undefined, 'place:test');
    });

    test('script line tools reject unsupported line_range shapes', async () => {
      const editScriptLines = jest.fn(async () => ({ content: [] }));
      const deleteScriptLines = jest.fn(async () => ({ content: [] }));
      const fakeTools = { editScriptLines, deleteScriptLines } as unknown as RobloxStudioTools;

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.edit_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        old_string: 'old',
        new_string: 'new',
        line_range: '10-12',
      }))).rejects.toThrow(/single line/);
      expect(editScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '10-',
      }))).rejects.toThrow(/requires line_range/);
      expect(deleteScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '0',
      }))).rejects.toThrow(/line_range must/);
      expect(deleteScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        line_range: '12-10',
      }))).rejects.toThrow(/line_range must/);
      expect(deleteScriptLines).not.toHaveBeenCalled();

      await expect(Promise.resolve().then(() => TOOL_HANDLERS.delete_script_lines(fakeTools, {
        instancePath: 'game.ServerScriptService.Main',
        startLine: 10,
        endLine: 12,
      }))).rejects.toThrow(/requires line_range/);
      expect(deleteScriptLines).not.toHaveBeenCalled();
    });

    test('multiplayer handler forwards only supported start arguments', async () => {
      const multiplayerPlaytest = jest.fn(async () => ({ content: [] }));
      const fakeTools = { multiplayerPlaytest } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.multiplayer_playtest(fakeTools, {
        action: 'start',
        numPlayers: 2,
        timeout: 5,
        instance_id: 'place:test',
      });
      expect(multiplayerPlaytest).toHaveBeenLastCalledWith('start', 2, undefined, undefined, undefined, 5, 'place:test');
    });

    test('selection handler forwards the lifecycle action and options together', async () => {
      const selection = jest.fn(async () => ({ content: [] }));
      const fakeTools = { selection } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.selection(fakeTools, {
        action: 'view',
        path: 'game.Workspace.Subject',
        padding: 1.25,
        instance_id: 'place:test',
      });

      expect(selection).toHaveBeenLastCalledWith(
        'view',
        expect.objectContaining({
          action: 'view',
          path: 'game.Workspace.Subject',
          padding: 1.25,
          instance_id: 'place:test',
        }),
        'place:test',
      );
    });

    test('grep_scripts uses only usePattern for pattern mode', async () => {
      const grepScripts = jest.fn(async () => ({ content: [] }));
      const fakeTools = { grepScripts } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.grep_scripts(fakeTools, {
        pattern: 'foo|bar',
        isRegex: true,
        instance_id: 'place:test',
      });
      expect(grepScripts).toHaveBeenLastCalledWith('foo|bar', expect.objectContaining({
        usePattern: undefined,
      }), 'place:test', undefined);

      await TOOL_HANDLERS.grep_scripts(fakeTools, {
        pattern: 'foo|bar',
        usePattern: true,
        instance_id: 'place:test',
      });
      expect(grepScripts).toHaveBeenLastCalledWith('foo|bar', expect.objectContaining({
        usePattern: true,
      }), 'place:test', undefined);
    });
  });

  describe('Plugin Connection Management', () => {
    test('does not expose the retired polling transport', async () => {
      await request(app).get('/poll').expect(404);
    });

    test('plugin ready notification', async () => {
      const response = await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(response.body).toMatchObject({
        success: true,
        assignedRole: 'edit',
        peerId: 'peer-1',
        instanceId: 'instance:test',
      });
      expect(app.isPluginConnected()).toBe(true);
    });

    test('maps client Peers to a server transport Peer and rejects proxied event streams', async () => {
      await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'server-peer',
        transportPeerId: 'server-peer',
        role: 'server',
        isRunning: true,
      }).expect(200);
      const clientReady = await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'client-peer',
        transportPeerId: 'server-peer',
        role: 'client',
        isRunning: true,
      }).expect(200);

      expect(clientReady.body.assignedRole).toBe('client-1');
      expect(bridge.getPeerById('client-peer')?.transportPeerId).toBe('server-peer');
      const publicStatus = await request(app).get('/status').expect(200);
      expect(publicStatus.body.instanceCount).toBe(1);
      expect(publicStatus.body.peerCount).toBe(2);
      expect(publicStatus.body.peers[0]).not.toHaveProperty('peerId');
      expect(publicStatus.body.peers[0]).not.toHaveProperty('transportPeerId');
      expect(publicStatus.body.peers[1]).not.toHaveProperty('peerId');
      expect(publicStatus.body.peers[1]).not.toHaveProperty('transportPeerId');
      const proxiedEvents = await request(app)
        .get('/events?peerId=client-peer')
        .expect(409);
      expect(proxiedEvents.body).toEqual({
        error: 'peer_has_no_event_stream',
        transportPeerId: 'server-peer',
      });
      await request(app).get('/events?peerId=unknown-peer').expect(404, {
        error: 'unknown_peer',
        knownPeer: false,
      });
      await request(app)
        .post('/disconnect')
        .send({ peerId: 'server-peer' })
        .expect(200);
      expect(bridge.getPeerById('server-peer')).toBeUndefined();
    });

    test('allows cross-Instance client proxies only within an explicit MultiplayerGroup', async () => {
      await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'server-peer',
        transportPeerId: 'server-peer',
        instanceId: 'instance:server',
        multiplayerGroupId: 'group-1',
        role: 'server',
        isRunning: true,
      }).expect(200);

      const groupedClient = await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'grouped-client',
        transportPeerId: 'server-peer',
        instanceId: 'instance:client',
        multiplayerGroupId: 'group-1',
        role: 'client',
        isRunning: true,
      }).expect(200);
      expect(groupedClient.body).toMatchObject({
        assignedRole: 'client-1',
        instanceId: 'instance:client',
        multiplayerGroupId: 'group-1',
      });


      const topology = await request(app).get('/topology').expect(200);
      expect(topology.body.instances.map((instance: { id: string }) => instance.id).sort()).toEqual([
        'instance:client',
        'instance:server',
      ]);
      expect(topology.body.peers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          peerId: 'grouped-client',
          transportPeerId: 'server-peer',
          instanceId: 'instance:client',
          multiplayerGroupId: 'group-1',
        }),
      ]));
      expect(topology.body.multiplayerGroups).toEqual([
        expect.objectContaining({
          id: 'group-1',
          instanceIds: expect.arrayContaining(['instance:server', 'instance:client']),
        }),
      ]);
      const ungroupedClient = await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'ungrouped-client',
        transportPeerId: 'server-peer',
        instanceId: 'instance:other-client',
        role: 'client',
        isRunning: true,
      }).expect(409);
      expect(ungroupedClient.body.error).toBe('transport_peer_unavailable');
    });

    test('rejects clients without a matching server transport Peer', async () => {
      const missingOwner = await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'client-peer',
        transportPeerId: 'missing-server',
        role: 'client',
        isRunning: true,
      }).expect(409);
      expect(missingOwner.body).toMatchObject({
        success: false,
        error: 'transport_peer_unavailable',
      });
      expect(bridge.getPeerById('client-peer')).toBeUndefined();

      await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'edit-peer',
        transportPeerId: 'edit-peer',
      }).expect(200);
      const nonServerOwner = await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'client-peer',
        transportPeerId: 'edit-peer',
        role: 'client',
        isRunning: true,
      }).expect(409);
      expect(nonServerOwner.body.error).toBe('transport_peer_unavailable');
      expect(bridge.getPeerById('client-peer')).toBeUndefined();
    });

    test('rejects direct clients and proxied non-client roles', async () => {
      const directClient = await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'client-peer',
        transportPeerId: 'client-peer',
        role: 'client',
        isRunning: true,
      }).expect(400);
      expect(directClient.body).toMatchObject({
        success: false,
        error: 'invalid_peer_topology',
      });

      await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'server-peer',
        transportPeerId: 'server-peer',
        role: 'server',
        isRunning: true,
      }).expect(200);
      const proxiedEdit = await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'proxied-edit',
        transportPeerId: 'server-peer',
        role: 'edit',
      }).expect(400);
      expect(proxiedEdit.body).toMatchObject({
        success: false,
        error: 'invalid_peer_topology',
      });
    });

    test('rejects a plugin whose version does not match the bundled server', async () => {
      const versionedApp = createHttpServer(
        tools,
        bridge,
        undefined,
        { name: 'robloxstudio-mcp', version: '2.0.0', tools: [] },
      );
      const mismatch = await request(versionedApp).post('/ready').send({
        ...READY_BODY,
        pluginVersion: '1.9.0',
      }).expect(426);
      expect(mismatch.body).toMatchObject({
        success: false,
        error: 'plugin_version_mismatch',
        pluginVersion: '1.9.0',
        serverVersion: '2.0.0',
      });
      expect(bridge.getInstances()).toEqual([]);

      await request(versionedApp).post('/ready').send({
        ...READY_BODY,
        pluginVersion: '2.0.0',
      }).expect(200);
      const health = await request(versionedApp).get('/health').expect(200);
      expect(health.body).toMatchObject({
        serverVersion: '2.0.0',
        pluginConnected: true,
      });
      expect(health.body.instances[0].peers[0]).toMatchObject({
        pluginVersion: '2.0.0',
        pluginVariant: 'main',
        serverVersion: '2.0.0',
      });
      expect(health.body).not.toHaveProperty('versionMismatch');
    });

    test('rejects /ready when the server has no version contract', async () => {
      const configlessApp = createHttpServer(tools, bridge);
      const response = await request(configlessApp).post('/ready').send(READY_BODY).expect(503);
      expect(response.body).toMatchObject({
        success: false,
        error: 'server_version_unavailable',
      });
      expect(bridge.getInstances()).toEqual([]);
      await configlessApp.cleanup();
    });

    test('rejects /ready without required fields', async () => {
      const response = await request(app).post('/ready').send({ role: 'client' }).expect(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'missing_ready_fields',
        message: '/ready missing required field(s): peerId, transportPeerId, instanceId, placeId, placeName, dataModelName, isRunning, pluginVersion, pluginVariant, timestamp',
        missingFields: [
          'peerId', 'transportPeerId', 'instanceId', 'placeId', 'placeName',
          'dataModelName', 'isRunning', 'pluginVersion', 'pluginVariant', 'timestamp',
        ],
        request: { role: 'client' },
      });
    });

    test('rejects duplicate roles in one routing scope on /ready', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const dup = await request(app)
        .post('/ready')
        .send({ ...READY_BODY, peerId: 'peer-2', transportPeerId: 'peer-2' })
        .expect(409);
      expect(dup.body).toMatchObject({
        success: false,
        error: 'duplicate_scope_role',
        request: {
          peerId: 'peer-2',
          transportPeerId: 'peer-2',
          instanceId: 'instance:test',
          role: 'edit',
          placeId: 0,
          placeName: 'TestPlace',
          dataModelName: 'TestPlace',
          isRunning: false,
        },
        existing: {
          peerId: 'peer-1',
          instanceId: 'instance:test',
          role: 'edit',
        },
      });
    });

    test('plugin disconnect by peerId', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(app.isPluginConnected()).toBe(true);
      const response = await request(app).post('/disconnect').send({ peerId: 'peer-1' }).expect(200);
      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(false);
    });

    test('unregisters every peer for an instance id for proxy cleanup', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      await request(app).post('/ready').send({
        ...READY_BODY,
        peerId: 'server-peer',
        transportPeerId: 'server-peer',
        role: 'server',
        isRunning: true,
      }).expect(200);

      const response = await request(app)
        .post('/unregister-instance-id')
        .send({ instanceId: 'instance:test' })
        .expect(200);

      expect(response.body).toMatchObject({ success: true });
      expect(response.body.removed.map((peer: { role: string }) => peer.role).sort()).toEqual(['edit', 'server']);
      expect(app.isPluginConnected()).toBe(false);
    });

    test('attaches a Multiplayer Group controller for proxy-started tests', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);

      const response = await request(app)
        .post('/create-multiplayer-group')
        .send({
          groupId: 'group-proxy',
          controllerInstanceId: 'instance:test',
        })
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        group: {
          id: 'group-proxy',
          controllerInstanceId: 'instance:test',
          instanceIds: ['instance:test'],
        },
      });
      expect(bridge.getPeerById('peer-1')?.multiplayerGroupId).toBe('group-proxy');
    });

    test('removes a Multiplayer Group controller for proxy-ended tests', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      bridge.createMultiplayerGroup('group-proxy', 'instance:test');

      const response = await request(app)
        .post('/remove-multiplayer-group')
        .send({ groupId: 'group-proxy' })
        .expect(200);

      expect(response.body).toMatchObject({
        success: true,
        removed: {
          id: 'group-proxy',
          controllerInstanceId: 'instance:test',
        },
      });
      expect(bridge.getMultiplayerGroups()).toEqual([]);
      expect(bridge.getPeerById('peer-1')?.multiplayerGroupId).toBeUndefined();
    });

    test('forwards a validated proxy timeout to the Studio bridge', async () => {
      const sendRequest = jest.spyOn(bridge, 'sendRequest').mockResolvedValue({ results: [] });

      const response = await request(app).post('/proxy').send({
        endpoint: '/api/grep-scripts',
        data: { pattern: 'needle' },
        targetPeerId: 'edit-peer',
        timeoutMs: 120_000,
      }).expect(200);

      expect(response.body).toEqual({ response: { results: [] } });
      expect(sendRequest).toHaveBeenCalledWith(
        '/api/grep-scripts',
        { pattern: 'needle' },
        'edit-peer',
        120_000,
        expect.any(AbortSignal),
      );
    });

    test('aborts the primary Studio request when a proxy connection closes', async () => {
      const lifecycle = new EventEmitter();
      const started = once(lifecycle, 'started');
      const aborted = once(lifecycle, 'aborted');
      const finished = once(lifecycle, 'finished');
      jest.spyOn(bridge, 'sendRequest').mockImplementation(async (
        _endpoint,
        _data,
        _targetPeerId,
        _timeoutMs,
        signal,
      ) => {
        if (!signal) throw new Error('expected bridge signal');
        signal.addEventListener('abort', () => lifecycle.emit('aborted'), { once: true });
        lifecycle.emit('started');
        await once(lifecycle, 'release');
        lifecycle.emit('finished');
        if (signal.aborted) throw new Error('Request aborted');
        return { results: [] };
      });
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server address');
      const body = JSON.stringify({
        endpoint: '/api/grep-scripts',
        data: { pattern: 'needle' },
        targetPeerId: 'edit-peer',
        timeoutMs: 120_000,
      });
      const proxyRequest = nodeRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/proxy',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      });
      proxyRequest.on('error', () => {});
      proxyRequest.end(body);

      try {
        await started;
        proxyRequest.destroy();
        await aborted;
        lifecycle.emit('release');
        await finished;
      } finally {
        lifecycle.emit('release');
        const closed = once(server, 'close');
        server.close();
        await closed;
        await app.cleanup();
      }
    });

    test('rejects invalid proxy timeouts', async () => {
      await request(app).post('/proxy').send({
        endpoint: '/api/grep-scripts',
        data: { pattern: 'needle' },
        targetPeerId: 'edit-peer',
        timeoutMs: 0,
      }).expect(400, { error: 'timeoutMs must be an integer between 1 and 300000' });
    });

    test('disconnect rejects pending requests targeting that Peer', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const p1 = bridge.sendRequest('/api/test1', {}, 'peer-1');
      const p2 = bridge.sendRequest('/api/test2', {}, 'peer-1');
      p1.catch(() => {});
      p2.catch(() => {});
      expect(bridge.getPendingRequestCount()).toBe(2);
      await request(app).post('/disconnect').send({ peerId: 'peer-1' }).expect(200);
      expect(bridge.getPendingRequestCount()).toBe(0);
    });

    test('stale Peer detection via unregister', () => {
      bridge.registerPeer({
        peerId: 'stale-peer',
        transportPeerId: 'stale-peer',
        instanceId: 'instance:stale',
        role: 'edit',
      });
      expect(app.isPluginConnected()).toBe(true);
      bridge.unregisterPeer('stale-peer');
      expect(app.isPluginConnected()).toBe(false);
    });
  });


  describe('Response Handling', () => {
    test('acknowledges accepted and repeated successful responses', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const requestPromise = bridge.sendRequest('/api/test', {}, 'peer-1');
      const pending = bridge.claimNextRequestForTransport('peer-1', 'test-success-response')!;

      const accepted = await request(app)
        .post('/response')
        .send({ requestId: pending.requestId, response: { result: 'success' } })
        .expect(200);
      expect(accepted.body).toEqual({ success: true, disposition: 'accepted' });

      const repeated = await request(app)
        .post('/response')
        .send({ requestId: pending.requestId, response: { result: 'duplicate' } })
        .expect(200);
      expect(repeated.body).toEqual({ success: true, disposition: 'already_settled' });
      await expect(requestPromise).resolves.toEqual({ result: 'success' });
    });

    test('treats an empty-string error as an accepted rejection', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const requestPromise = bridge.sendRequest('/api/test', {}, 'peer-1');
      requestPromise.catch(() => {});
      const pending = bridge.claimNextRequestForTransport('peer-1', 'test-error-response')!;

      const response = await request(app)
        .post('/response')
        .send({ requestId: pending.requestId, error: '' })
        .expect(200);
      expect(response.body).toEqual({ success: true, disposition: 'accepted' });
      await expect(requestPromise).rejects.toBe('');
    });

    test('reports an unknown settlement with HTTP 404', async () => {
      const response = await request(app)
        .post('/response')
        .send({ requestId: 'never-issued', response: { result: 'late' } })
        .expect(404);
      expect(response.body).toEqual({ success: false, disposition: 'unknown' });
    });

    test('rejects malformed request IDs with HTTP 400', async () => {
      for (const body of [{}, { requestId: '' }, { requestId: 42 }, { requestId: null }]) {
        const response = await request(app).post('/response').send(body).expect(400);
        expect(response.body).toEqual({
          success: false,
          error: 'invalid_request_id',
        });
      }
    });
  });

  describe('MCP Server State', () => {
    test('tracks activity', async () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);
      app.trackMCPActivity();
      expect(app.isMCPServerActive()).toBe(true);
    });

    test('times out after inactivity', () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);
      const original = Date.now;
      Date.now = jest.fn(() => original() + 31000);
      expect(app.isMCPServerActive()).toBe(false);
      Date.now = original;
    });
  });

  describe('Status Endpoint', () => {
    test('returns current status', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const response = await request(app).get('/status').expect(200);
      expect(response.body).toMatchObject({
        pluginConnected: true,
        mcpServerActive: true,
        instanceCount: 1,
        peerCount: 1,
      });
      expect(response.body.instances).toHaveLength(1);
      expect(response.body.instances[0]).toMatchObject({
        id: 'instance:test',
        placeName: 'TestPlace',
      });
      expect(response.body.instances[0].peers[0]).toMatchObject({
        instanceId: 'instance:test',
        role: 'edit',
      });
      expect(response.body.instances[0].peers[0]).not.toHaveProperty('peerId');
      expect(response.body.multiplayerGroups).toEqual([]);
    });
  });
});

import request from 'supertest';
import { once } from 'node:events';
import { TOOL_HANDLERS, createHttpServer, type RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import {
  BridgeService,
  type PendingPollOptions,
  type PendingPollResult,
} from '../bridge-service.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { detectStudioPlatform } from '../studio-platform.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

class HttpTestBridgeService extends BridgeService {
  private readonly pollEntries = new Map<string, () => void>();
  private readonly pollExits = new Map<string, () => void>();

  expectNextPollEntry(pluginSessionId: string): Promise<void> {
    if (this.pollEntries.has(pluginSessionId)) {
      throw new Error(`Already expecting poll entry for ${pluginSessionId}`);
    }
    // Promise.withResolvers is unavailable on the declared Node 20.0 minimum.
    return new Promise((resolve) => {
      this.pollEntries.set(pluginSessionId, resolve);
    });
  }

  expectNextPollExit(pluginSessionId: string): Promise<void> {
    if (this.pollExits.has(pluginSessionId)) {
      throw new Error(`Already expecting poll exit for ${pluginSessionId}`);
    }
    return new Promise((resolve) => {
      this.pollExits.set(pluginSessionId, resolve);
    });
  }

  override async waitForPendingRequest(
    pluginSessionId: string,
    options: PendingPollOptions = {},
  ): Promise<PendingPollResult> {
    const entered = this.pollEntries.get(pluginSessionId);
    this.pollEntries.delete(pluginSessionId);
    entered?.();
    try {
      return await super.waitForPendingRequest(pluginSessionId, options);
    } finally {
      const exited = this.pollExits.get(pluginSessionId);
      this.pollExits.delete(pluginSessionId);
      exited?.();
    }
  }

  protected override notifyInstanceRegistered(): void {
    // HTTP route tests do not need managed-Studio lifecycle association.
  }
}

const READY_BODY = {
  pluginSessionId: 'session-1',
  instanceId: 'place:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
};

describe('HTTP Server', () => {
  let app: RobloxStudioHttpApp;
  let bridge: HttpTestBridgeService;
  let tools: RobloxStudioTools;
  beforeEach(() => {
    bridge = new HttpTestBridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge);
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
        mcpServerActive: false,
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
      }), 'place:test');

      await TOOL_HANDLERS.grep_scripts(fakeTools, {
        pattern: 'foo|bar',
        usePattern: true,
        instance_id: 'place:test',
      });
      expect(grepScripts).toHaveBeenLastCalledWith('foo|bar', expect.objectContaining({
        usePattern: true,
      }), 'place:test');
    });
  });

  describe('Plugin Connection Management', () => {
    test('plugin ready notification', async () => {
      const response = await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(response.body).toMatchObject({ success: true, assignedRole: 'edit', instanceId: 'place:test' });
      expect(app.isPluginConnected()).toBe(true);
    });

    test('plugin ready records version metadata and exposes mismatch status', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const versionedApp = createHttpServer(
        tools,
        bridge,
        undefined,
        { name: 'robloxstudio-mcp', version: '2.0.0', tools: [] },
      );
      try {
        await request(versionedApp).post('/ready').send({
          ...READY_BODY,
          pluginVersion: '1.9.0',
          pluginVariant: 'main',
        }).expect(200);
        await request(versionedApp).post('/ready').send({
          ...READY_BODY,
          pluginVersion: '1.9.0',
          pluginVariant: 'main',
        }).expect(200);

        const health = await request(versionedApp).get('/health').expect(200);
        expect(health.body).toMatchObject({
          serverVersion: '2.0.0',
          versionMismatch: true,
        });
        expect(health.body.instances[0]).toMatchObject({
          pluginVersion: '1.9.0',
          pluginVariant: 'main',
          serverVersion: '2.0.0',
          versionMismatch: true,
        });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toContain('[version-mismatch]');
      } finally {
        errorSpy.mockRestore();
      }
    });

    test('rejects /ready without required fields', async () => {
      const response = await request(app).post('/ready').send({ role: 'client' }).expect(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'missing_ready_fields',
        message: '/ready missing required field(s): pluginSessionId, instanceId',
        missingFields: ['pluginSessionId', 'instanceId'],
        request: { role: 'client' },
      });
    });

    test('rejects duplicate (instanceId, role) on /ready', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const dup = await request(app)
        .post('/ready')
        .send({ ...READY_BODY, pluginSessionId: 'session-2' })
        .expect(409);
      expect(dup.body).toMatchObject({
        success: false,
        error: 'duplicate_instance_role',
        message: 'Another plugin is already registered as (place:test, edit).',
        request: {
          instanceId: 'place:test',
          role: 'edit',
          placeId: 0,
          placeName: 'TestPlace',
          dataModelName: 'TestPlace',
          isRunning: false,
        },
        existing: {
          instanceId: 'place:test',
          role: 'edit',
        },
      });
    });

    test('plugin disconnect by pluginSessionId', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(app.isPluginConnected()).toBe(true);
      const response = await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(false);
    });

    test('unregisters every peer for an instance id for proxy cleanup', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'session-server',
        role: 'server',
        isRunning: true,
      }).expect(200);

      const response = await request(app)
        .post('/unregister-instance-id')
        .send({ instanceId: 'place:test' })
        .expect(200);

      expect(response.body).toMatchObject({ success: true });
      expect(response.body.removed.map((inst: { role: string }) => inst.role).sort()).toEqual(['edit', 'server']);
      expect(app.isPluginConnected()).toBe(false);
    });

    test('disconnect rejects pending requests targeting that tuple', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const p1 = bridge.sendRequest('/api/test1', {}, 'place:test', 'edit');
      const p2 = bridge.sendRequest('/api/test2', {}, 'place:test', 'edit');
      p1.catch(() => {});
      p2.catch(() => {});
      expect(bridge.getPendingRequest('place:test', 'edit')).toBeTruthy();
      await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
    });

    test('stale instance detection via unregister', () => {
      bridge.registerInstance({ pluginSessionId: 'stale-1', instanceId: 'place:s', role: 'edit' });
      expect(app.isPluginConnected()).toBe(true);
      bridge.unregisterInstance('stale-1');
      expect(app.isPluginConnected()).toBe(false);
    });
  });

  describe('Polling Endpoint', () => {
    test('503 when MCP server is not active', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const response = await request(app).get('/poll?pluginSessionId=session-1').expect(503);
      expect(response.body).toMatchObject({
        error: 'MCP server not connected',
        pluginConnected: true,
        mcpConnected: false,
        request: null,
        knownInstance: true,
        versionMismatch: false,
      });
    });

    test('returns pending request when MCP is active and tuple matches', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const pending = bridge.sendRequest('/api/test', { data: 'test' }, 'place:test', 'edit');
      pending.catch(() => {});
      const response = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      expect(response.body).toMatchObject({
        request: { endpoint: '/api/test', data: { data: 'test' } },
        mcpConnected: true,
        pluginConnected: true,
        knownInstance: true,
      });
      expect(response.body.requestId).toBeTruthy();
    });

    test('keeps unnegotiated legacy polls in short-poll mode', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);

      const response = await request(app)
        .get('/poll?pluginSessionId=session-1')
        .expect(200);
      expect(response.body).toMatchObject({
        request: null,
        knownInstance: true,
        mcpConnected: true,
      });
      expect(response.body.pollMode).toBeUndefined();
    });

    test('holds an idle poll until a matching request arrives', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const pollEntered = bridge.expectNextPollEntry('session-1');
      const poll = request(app)
        .get('/poll?pluginSessionId=session-1&pollMode=long')
        .expect(200)
        .then((response) => response);

      await pollEntered;
      const pending = bridge.sendRequest('/api/test', { delayed: true }, 'place:test', 'edit');
      const response = await poll;
      expect(response.body).toMatchObject({
        request: { endpoint: '/api/test', data: { delayed: true } },
        mcpConnected: true,
        pluginConnected: true,
        knownInstance: true,
        pollMode: 'long',
      });
      bridge.resolveRequest(response.body.requestId, { ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    test('knownInstance=false when pluginSessionId is unknown (server restarted)', async () => {
      app.setMCPServerActive(true);
      const response = await request(app).get('/poll?pluginSessionId=unknown-session&pollMode=long').expect(200);
      expect(response.body.knownInstance).toBe(false);
      expect(response.body.request).toBeNull();
      expect(response.body.pollMode).toBe('long');
    });

    test('releases a held poll when the MCP server becomes inactive', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const pollEntered = bridge.expectNextPollEntry('session-1');
      const poll = request(app)
        .get('/poll?pluginSessionId=session-1&pollMode=long')
        .expect(503)
        .then((response) => response);

      await pollEntered;
      app.setMCPServerActive(false);
      const response = await poll;
      expect(response.body).toMatchObject({
        error: 'MCP server not connected',
        mcpConnected: false,
        request: null,
      });
    });

    test('delivers a request that wins a same-turn MCP deactivation race', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const pollEntered = bridge.expectNextPollEntry('session-1');
      const poll = request(app)
        .get('/poll?pluginSessionId=session-1&pollMode=long')
        .expect(200)
        .then((response) => response);

      await pollEntered;
      const pending = bridge.sendRequest('/api/test', { claimed: true }, 'place:test', 'edit');
      pending.catch(() => {});
      app.setMCPServerActive(false);

      const response = await poll;
      expect(response.body).toMatchObject({
        request: { endpoint: '/api/test', data: { claimed: true } },
        mcpConnected: true,
        knownInstance: true,
        pollMode: 'long',
      });
      bridge.resolveRequest(response.body.requestId, { ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    test('isolates 12 concurrent held polls by Studio instance', async () => {
      const instanceNumbers = Array.from({ length: 12 }, (_, index) => index + 1);
      for (const number of instanceNumbers) {
        await request(app).post('/ready').send({
          ...READY_BODY,
          pluginSessionId: `session-${number}`,
          instanceId: `place:${number}`,
        }).expect(200);
      }
      app.setMCPServerActive(true);
      const pollEntries = instanceNumbers.map((number) =>
        bridge.expectNextPollEntry(`session-${number}`));
      const polls = instanceNumbers.map((number) => request(app)
        .get(`/poll?pluginSessionId=session-${number}&pollMode=long`)
        .expect(200)
        .then((response) => response));

      await Promise.all(pollEntries);
      const toolCalls = [...instanceNumbers].reverse().map((number) => ({
        number,
        promise: bridge.sendRequest('/api/test', { instance: number }, `place:${number}`, 'edit'),
      }));
      const deliveries = await Promise.all(polls);

      for (const [index, delivery] of deliveries.entries()) {
        expect(delivery.body.request.data).toEqual({ instance: index + 1 });
        bridge.resolveRequest(delivery.body.requestId, { ok: true });
      }
      await expect(Promise.all(toolCalls.map((call) => call.promise))).resolves.toHaveLength(12);
    });

    test('keeps a held poll across same-session anon-to-published /ready migration', async () => {
      await request(app).post('/ready').send({
        ...READY_BODY,
        instanceId: 'anon:pending-place',
        placeId: 0,
      }).expect(200);
      app.setMCPServerActive(true);
      const pollEntered = bridge.expectNextPollEntry('session-1');
      const poll = request(app)
        .get('/poll?pluginSessionId=session-1&pollMode=long')
        .expect(200)
        .then((response) => response);

      await pollEntered;
      const pending = bridge.sendRequest('/api/test', { migrated: true }, 'place:52', 'edit');
      pending.catch(() => {});
      const ready = await request(app).post('/ready').send({
        ...READY_BODY,
        instanceId: 'anon:pending-place',
        placeId: 52,
      }).expect(200);
      expect(ready.body.instanceId).toBe('place:52');

      const delivery = await poll;
      expect(delivery.body.request.data).toEqual({ migrated: true });
      bridge.resolveRequest(delivery.body.requestId, { ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    test('aborting an idle HTTP poll does not consume later work', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP server address');
      const pollUrl = `http://127.0.0.1:${address.port}/poll?pluginSessionId=session-1&pollMode=long`;

      try {
        const controller = new AbortController();
        let sawAbort = false;
        const pollEntered = bridge.expectNextPollEntry('session-1');
        const pollExited = bridge.expectNextPollExit('session-1');
        const abortedCompletion = fetch(pollUrl, { signal: controller.signal }).then(
          () => {
            throw new Error('aborted poll unexpectedly completed');
          },
          () => {
            sawAbort = true;
          },
        );

        await pollEntered;
        controller.abort();
        await abortedCompletion;
        expect(sawAbort).toBe(true);
        await pollExited;

        const pending = bridge.sendRequest('/api/test', { afterAbort: true }, 'place:test', 'edit');
        pending.catch(() => {});
        const delivery = await request(app)
          .get('/poll?pluginSessionId=session-1&pollMode=long')
          .expect(200);
        expect(delivery.body.request.data).toEqual({ afterAbort: true });
        bridge.resolveRequest(delivery.body.requestId, { ok: true });
        await expect(pending).resolves.toEqual({ ok: true });
      } finally {
        const closed = once(server, 'close');
        server.closeAllConnections();
        server.close();
        await closed;
      }
    });


    test('MCP lifecycle cancellation is scoped per HTTP app', async () => {
      const legacyApp = createHttpServer(tools, bridge);
      await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'primary-session',
        instanceId: 'place:primary',
      }).expect(200);
      await request(app).post('/ready').send({
        ...READY_BODY,
        pluginSessionId: 'legacy-session',
        instanceId: 'place:legacy',
      }).expect(200);
      app.setMCPServerActive(true);
      legacyApp.setMCPServerActive(true);

      const pollEntries = [
        bridge.expectNextPollEntry('primary-session'),
        bridge.expectNextPollEntry('legacy-session'),
      ];
      const primaryPoll = request(app)
        .get('/poll?pluginSessionId=primary-session&pollMode=long')
        .expect(503)
        .then((response) => response);
      const legacyPoll = request(legacyApp)
        .get('/poll?pluginSessionId=legacy-session&pollMode=long')
        .expect(200)
        .then((response) => response);
      await Promise.all(pollEntries);

      app.setMCPServerActive(false);
      const primaryResponse = await primaryPoll;
      expect(primaryResponse.body.mcpConnected).toBe(false);

      const pending = bridge.sendRequest('/api/test', { app: 'legacy' }, 'place:legacy', 'edit');
      pending.catch(() => {});
      const legacyResponse = await legacyPoll;
      expect(legacyResponse.body.request.data).toEqual({ app: 'legacy' });
      bridge.resolveRequest(legacyResponse.body.requestId, { ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
      legacyApp.setMCPServerActive(false);
    });
    test('re-snapshots registration when a held poll loses its session', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const pollEntered = bridge.expectNextPollEntry('session-1');
      const poll = request(app)
        .get('/poll?pluginSessionId=session-1&pollMode=long')
        .expect(200)
        .then((response) => response);

      await pollEntered;
      await request(app)
        .post('/disconnect')
        .send({ pluginSessionId: 'session-1' })
        .expect(200);
      const response = await poll;
      expect(response.body).toMatchObject({
        knownInstance: false,
        request: null,
      });
    });
  });

  describe('Response Handling', () => {
    test('handles successful response', async () => {
      const requestPromise = bridge.sendRequest('/api/test', {}, 'place:test', 'edit');
      const pending = bridge.getPendingRequest('place:test', 'edit');
      const response = await request(app)
        .post('/response')
        .send({ requestId: pending!.requestId, response: { result: 'success' } })
        .expect(200);
      expect(response.body).toEqual({ success: true });
      const result = await requestPromise;
      expect(result).toEqual({ result: 'success' });
    });

    test('handles error response', async () => {
      const requestPromise = bridge.sendRequest('/api/test', {}, 'place:test', 'edit');
      requestPromise.catch(() => {});
      const pending = bridge.getPendingRequest('place:test', 'edit');
      await request(app)
        .post('/response')
        .send({ requestId: pending!.requestId, error: 'Test error message' })
        .expect(200);
      await expect(requestPromise).rejects.toEqual('Test error message');
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
      expect(response.body).toMatchObject({ pluginConnected: true, mcpServerActive: true });
      expect(response.body.instances).toHaveLength(1);
      expect(response.body.instances[0]).toMatchObject({
        instanceId: 'place:test',
        role: 'edit',
        placeName: 'TestPlace',
      });
    });
  });
});

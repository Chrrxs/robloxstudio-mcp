import request from 'supertest';
import { TOOL_HANDLERS, createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';
import { Application } from 'express';

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
  let app: Application & any;
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new BridgeService();
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
        new Set(['get_file_tree']),
        { name: 'robloxstudio-mcp-inspector', version: '2.0.0', tools: [] },
      );

      const response = await request(inspectorApp).get('/health').expect(200);
      expect(response.body.serverName).toBe('robloxstudio-mcp-inspector');
      expect(response.body.capabilities.studioLifecycle).toBeUndefined();
      await request(inspectorApp).post('/mcp/manage_instance').send({ action: 'status' }).expect(404);
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

    test('multiplayer handlers forward force for explicit hazardous start', async () => {
      const multiplayerPlaytest = jest.fn(async () => ({ content: [] }));
      const multiplayerTestStart = jest.fn(async () => ({ content: [] }));
      const fakeTools = { multiplayerPlaytest, multiplayerTestStart } as unknown as RobloxStudioTools;

      await TOOL_HANDLERS.multiplayer_playtest(fakeTools, {
        action: 'start',
        numPlayers: 2,
        timeout: 5,
        instance_id: 'place:test',
        force: true,
      });
      expect(multiplayerPlaytest).toHaveBeenLastCalledWith('start', 2, undefined, undefined, undefined, 5, 'place:test', true);

      await TOOL_HANDLERS.multiplayer_test_start(fakeTools, {
        numPlayers: 2,
        timeout: 5,
        instance_id: 'place:test',
        force: true,
      });
      expect(multiplayerTestStart).toHaveBeenLastCalledWith(2, undefined, 5, 'place:test', true);
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

    test('returns null when no pending request matches the polling plugin', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const response = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      expect(response.body).toMatchObject({ request: null, mcpConnected: true, pluginConnected: true });
    });

    test('knownInstance=false when pluginSessionId is unknown (server restarted)', async () => {
      app.setMCPServerActive(true);
      const response = await request(app).get('/poll?pluginSessionId=unknown-session').expect(200);
      expect(response.body.knownInstance).toBe(false);
      expect(response.body.request).toBeNull();
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

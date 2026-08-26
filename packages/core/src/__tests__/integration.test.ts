import request from 'supertest';
import { createHttpServer, type RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';

interface ReadyOverrides {
  pluginSessionId?: string;
  physicalSessionId?: string;
  instanceId?: string;
  role?: string;
}

function ready(overrides: ReadyOverrides = {}) {
  const pluginSessionId = overrides.pluginSessionId ?? 'session-1';
  return {
    pluginSessionId,
    physicalSessionId: overrides.physicalSessionId ?? pluginSessionId,
    instanceId: 'place:test',
    role: 'edit',
    placeId: 0,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning: false,
    pluginVersion: 'test-version',
    pluginVariant: 'main',
    ...overrides,
  };
}

const TEST_SERVER_CONFIG = {
  name: 'robloxstudio-mcp',
  version: 'test-version',
  tools: [],
};

describe('Integration', () => {
  let app: RobloxStudioHttpApp;
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new BridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge, undefined, TEST_SERVER_CONFIG);
  });

  afterEach(async () => {
    bridge.clearAllPendingRequests();
    await app.cleanup();
  });

  describe('Full Connection Flow', () => {
    test('complete connection lifecycle', async () => {
      let status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
      expect(status.body.mcpServerActive).toBe(false);

      await request(app).post('/ready').send(ready()).expect(200);
      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(true);

      app.setMCPServerActive(true);
      status = await request(app).get('/status').expect(200);
      expect(status.body.mcpServerActive).toBe(true);

      await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
    });
  });

  describe('Request/Response Flow', () => {
    test('complete request/response cycle', async () => {
      await request(app).post('/ready').send(ready()).expect(200);
      app.setMCPServerActive(true);

      const responsePromise = bridge.sendRequest(
        '/api/test-endpoint',
        { testData: 'hello', value: 123 },
        'place:test',
        'edit',
      );
      const delivery = bridge.claimNextRequestForPhysical('session-1', 'integration-stream');
      expect(delivery).toMatchObject({
        endpoint: '/api/test-endpoint',
        data: { testData: 'hello', value: 123 },
      });

      await request(app)
        .post('/response')
        .send({
          requestId: delivery!.requestId,
          response: { success: true, result: 'processed', echo: 'hello' },
        })
        .expect(200);

      await expect(responsePromise).resolves.toEqual({
        success: true,
        result: 'processed',
        echo: 'hello',
      });
    });

    test('error responses propagate', async () => {
      await request(app).post('/ready').send(ready()).expect(200);
      const responsePromise = bridge.sendRequest('/api/failing', {}, 'place:test', 'edit');
      responsePromise.catch(() => {});
      const delivery = bridge.claimNextRequestForPhysical('session-1', 'integration-stream');

      await request(app)
        .post('/response')
        .send({ requestId: delivery!.requestId, error: 'Operation failed: Invalid input' })
        .expect(200);

      await expect(responsePromise).rejects.toEqual('Operation failed: Invalid input');
    });
  });

  describe('Disconnect Recovery', () => {
    test('disconnect rejects pending requests and a new physical session resumes', async () => {
      await request(app).post('/ready').send(ready()).expect(200);
      const first = bridge.sendRequest('/api/test1', {}, 'place:test', 'edit');
      const second = bridge.sendRequest('/api/test2', {}, 'place:test', 'edit');
      first.catch(() => {});
      second.catch(() => {});
      bridge.claimNextRequestForPhysical('session-1', 'old-stream');

      await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      await expect(first).rejects.toThrow(/disconnected/);
      await expect(second).rejects.toThrow(/disconnected/);

      await request(app).post('/ready').send(ready({ pluginSessionId: 'session-2' })).expect(200);
      const resumed = bridge.sendRequest('/api/test3', {}, 'place:test', 'edit');
      const delivery = bridge.claimNextRequestForPhysical('session-2', 'new-stream');
      expect(delivery?.endpoint).toBe('/api/test3');

      await request(app)
        .post('/response')
        .send({ requestId: delivery!.requestId, response: { success: true } })
        .expect(200);
      await expect(resumed).resolves.toEqual({ success: true });
    });
  });

  describe('Timeout Handling', () => {
    test('request times out after 30s', async () => {
      jest.useFakeTimers();
      await request(app).post('/ready').send(ready()).expect(200);
      const responsePromise = bridge.sendRequest('/api/slow', {}, 'place:test', 'edit');
      bridge.claimNextRequestForPhysical('session-1', 'integration-stream');

      jest.advanceTimersByTime(31_000);
      await expect(responsePromise).rejects.toThrow('Request timeout');
      jest.useRealTimers();
    });
  });

  describe('Multi-instance routing', () => {
    test('two distinct physical sessions receive only their own requests', async () => {
      await request(app).post('/ready').send(ready({
        pluginSessionId: 's-a',
        instanceId: 'place:A',
      })).expect(200);
      await request(app).post('/ready').send(ready({
        pluginSessionId: 's-b',
        instanceId: 'place:B',
      })).expect(200);

      const responseA = bridge.sendRequest('/api/test', { who: 'A' }, 'place:A', 'edit');
      const responseB = bridge.sendRequest('/api/test', { who: 'B' }, 'place:B', 'edit');
      const deliveryA = bridge.claimNextRequestForPhysical('s-a', 'stream-a');
      const deliveryB = bridge.claimNextRequestForPhysical('s-b', 'stream-b');
      expect(deliveryA?.data).toEqual({ who: 'A' });
      expect(deliveryB?.data).toEqual({ who: 'B' });

      await request(app).post('/response')
        .send({ requestId: deliveryA!.requestId, response: { ok: 'A' } })
        .expect(200);
      await request(app).post('/response')
        .send({ requestId: deliveryB!.requestId, response: { ok: 'B' } })
        .expect(200);
      await expect(responseA).resolves.toEqual({ ok: 'A' });
      await expect(responseB).resolves.toEqual({ ok: 'B' });
    });
  });
});

import request from 'supertest';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

const HTTP_LIMIT = 50 * 1024 * 1024;
const operationId = 'http-body-limit';
const targetPeerId = 'edit-peer';
const endpoint = '/api/set-script-source';

function proxyBody(proxy: ProxyBridgeService, source: string): string {
  return JSON.stringify({
    endpoint, data: { source }, targetPeerId,
    proxyInstanceId: proxy.proxyInstanceId, timeoutMs: 1000, operationId,
  });
}

function sourceForBodyBytes(bytes: number, serialize: (source: string) => string): string {
  // UTF-8 and JSON escaping both contribute bytes beyond the source length.
  const prefix = 'é"\\\n';
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(serialize(prefix)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

describe('proxy HTTP body admission', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('rejects a 55 MiB UTF-8 source before fetching or queuing with measured HTTP admission details', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      peers: [], instances: [], multiplayerGroups: [],
    }));
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      fetchMock.mockClear();
      const source = 'é'.repeat(55 * 1024 * 1024 / 2);
      const bytes = Buffer.byteLength(proxyBody(proxy, source));
      await expect(proxy.sendRequest(endpoint, { source }, targetPeerId, 1000, undefined, operationId))
        .rejects.toMatchObject({
          code: 'request_too_large',
          details: {
            requestId: operationId, targetPeerId, stage: 'queued', outcome: 'not_executed',
            bytes, limitBytes: HTTP_LIMIT, transportStage: 'proxy_send',
          },
        });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(proxy.getPendingRequestCount()).toBe(0);
      expect(proxy.getRequestStatus(operationId)).toBeUndefined();
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test.each([-1, 0, 1])('checks the serialized UTF-8 envelope at the HTTP limit %+d byte boundary', async (offset) => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/topology')) return jsonResponse({ peers: [], instances: [], multiplayerGroups: [] });
      expect(String(input)).toBe('http://primary/proxy');
      expect(Buffer.byteLength(String(init?.body))).toBe(HTTP_LIMIT + offset);
      return jsonResponse({ response: { admitted: true } });
    });
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      fetchMock.mockClear();
      const source = sourceForBodyBytes(HTTP_LIMIT + offset, (value) => proxyBody(proxy, value));
      const result = proxy.sendRequest(endpoint, { source }, targetPeerId, 1000, undefined, operationId);
      if (offset <= 0) {
        await expect(result).resolves.toEqual({ admitted: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toMatchObject({
          code: 'request_too_large',
          details: { bytes: HTTP_LIMIT + 1, limitBytes: HTTP_LIMIT, outcome: 'not_executed', transportStage: 'proxy_send' },
        });
        expect(fetchMock).not.toHaveBeenCalled();
      }
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });

  test('preserves HTTP parser size diagnostics and adds the known operation identity', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/topology')) return jsonResponse({ peers: [], instances: [], multiplayerGroups: [] });
      return jsonResponse({
        error: 'HTTP request body exceeds limit', code: 'request_too_large',
        details: { bytes: HTTP_LIMIT + 1, limitBytes: HTTP_LIMIT, stage: 'queued', outcome: 'not_executed', transportStage: 'http_receive' },
      }, 413);
    });
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      await expect(proxy.sendRequest(endpoint, {}, targetPeerId, 1000, undefined, operationId)).rejects.toMatchObject({
        code: 'request_too_large',
        details: {
          requestId: operationId, targetPeerId, bytes: HTTP_LIMIT + 1, limitBytes: HTTP_LIMIT,
          stage: 'queued', outcome: 'not_executed', transportStage: 'http_receive',
        },
      });
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
    }
  });
});

describe('HTTP parser body limit', () => {
  const serialize = (source: string): string => JSON.stringify({
    endpoint, data: { source }, targetPeerId, timeoutMs: 0, operationId,
  });

  test.each([-1, 0, 1])('routes or rejects actual UTF-8 bodies at the HTTP limit %+d byte boundary', async (offset) => {
    const bridge = new BridgeService();
    const app = createHttpServer(new RobloxStudioTools(bridge), bridge);
    try {
      const source = sourceForBodyBytes(HTTP_LIMIT + offset, serialize);
      const response = await request(app).post('/proxy').set('Content-Type', 'application/json').send(serialize(source));
      if (offset <= 0) {
        // The intended route validates timeoutMs only after successful JSON parsing.
        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: 'timeoutMs must be an integer between 1 and 300000' });
      } else {
        expect(response.status).toBe(413);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toMatchObject({
          code: 'request_too_large',
          details: {
            bytes: HTTP_LIMIT + 1, limitBytes: HTTP_LIMIT, stage: 'queued',
            outcome: 'not_executed', transportStage: 'http_receive',
          },
        });
      }
      expect(bridge.getPendingRequestCount()).toBe(0);
    } finally {
      bridge.clearAllPendingRequests();
      await app.cleanup();
    }
  });

  test('does not relabel malformed JSON as a size rejection', async () => {
    const bridge = new BridgeService();
    const app = createHttpServer(new RobloxStudioTools(bridge), bridge);
    try {
      const response = await request(app).post('/proxy').set('Content-Type', 'application/json').send('{');
      expect(response.status).toBe(400);
      expect(response.body).not.toHaveProperty('code', 'request_too_large');
    } finally {
      await app.cleanup();
    }
  });
});

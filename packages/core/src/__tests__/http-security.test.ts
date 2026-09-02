import request from 'supertest';
import { createHttpServer } from '../http-server.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

describe('HTTP security', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new BridgeService();
    tools = new RobloxStudioTools(bridge);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  describe('origin policy', () => {
    it('rejects browser requests with a non-allowlisted Origin', async () => {
      const app = createHttpServer(tools, bridge);
      const res = await request(app).get('/health').set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden_origin');
    });

    it('allows requests without an Origin header (native clients / Studio plugin)', async () => {
      const app = createHttpServer(tools, bridge);
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('allows and echoes an allowlisted Origin', async () => {
      const app = createHttpServer(tools, bridge, undefined, undefined, {
        allowedOrigins: ['http://localhost:5173'],
      });
      const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });

    it('answers preflight for allowlisted origins only', async () => {
      const app = createHttpServer(tools, bridge, undefined, undefined, {
        allowedOrigins: ['http://localhost:5173'],
      });
      const ok = await request(app).options('/mcp/selection').set('Origin', 'http://localhost:5173');
      expect(ok.status).toBe(204);
      const bad = await request(app).options('/mcp/selection').set('Origin', 'https://evil.example');
      expect(bad.status).toBe(403);
    });
  });

  describe('auth token', () => {
    const TOKEN = 'test-token-123';

    function authedApp() {
      return createHttpServer(tools, bridge, undefined, undefined, { authToken: TOKEN });
    }

    it('rejects tool endpoints without a token', async () => {
      const app = authedApp();
      for (const path of [
        '/proxy',
        '/unregister-instance-id',
        '/create-multiplayer-group',
        '/remove-multiplayer-group',
      ]) {
        const res = await request(app).post(path).send({});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('unauthorized');
      }
      const topology = await request(app).get('/topology');
      expect(topology.status).toBe(401);
      const tool = await request(app).post('/mcp/selection').send({});
      expect(tool.status).toBe(401);
    });

    it('rejects a wrong token', async () => {
      const app = authedApp();
      const res = await request(app).get('/topology').set('X-MCP-Auth', 'wrong');
      expect(res.status).toBe(401);
    });

    it('accepts X-MCP-Auth and Authorization: Bearer', async () => {
      const app = authedApp();
      const viaHeader = await request(app).get('/topology').set('X-MCP-Auth', TOKEN);
      expect(viaHeader.status).toBe(200);
      const viaBearer = await request(app).get('/topology').set('Authorization', `Bearer ${TOKEN}`);
      expect(viaBearer.status).toBe(200);
    });

    it('leaves plugin-facing endpoints tokenless', async () => {
      const app = authedApp();
      const health = await request(app).get('/health');
      expect(health.status).toBe(200);
      const status = await request(app).get('/status');
      expect(status.status).toBe(200);
      const events = await request(app).get('/events?peerId=unknown-peer');
      expect(events.status).toBe(404); // unknown Peer — but not 401
      const disconnect = await request(app).post('/disconnect').send({});
      expect(disconnect.status).toBe(200);
    });

    it('does not require a token when auth is disabled', async () => {
      const app = createHttpServer(tools, bridge);
      const res = await request(app).get('/topology');
      expect(res.status).toBe(200);
    });
  });
});

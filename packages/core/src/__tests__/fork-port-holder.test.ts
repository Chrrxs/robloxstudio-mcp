import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { assertBridgeHolderUsable, BridgeBusyError, findListenerPid, probeBridgeHolder } from '../fork/port-holder.js';

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

describe('bridge port holder check', () => {
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map(async (server) => {
      if (!server.listening) return;
      const closed = once(server, 'close');
      server.close();
      await closed;
    }));
    jest.restoreAllMocks();
  });

  function track<T extends net.Server>(server: T): T {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    servers.push(server);
    return server;
  }

  test('a live robloxstudio-mcp holder is usable for proxy mode', async () => {
    const port = await listen(track(http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'robloxstudio-mcp', version: '3.3.0', pid: 4242 }));
    })));
    await expect(probeBridgeHolder('127.0.0.1', port)).resolves.toEqual({ ours: true, pid: 4242, version: '3.3.0' });
    await expect(assertBridgeHolderUsable('127.0.0.1', port, '3.3.0')).resolves.toBeUndefined();
  });

  test('a version mismatch still proxies but says so on stderr', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const port = await listen(track(http.createServer((_req, res) => {
      res.end(JSON.stringify({ service: 'robloxstudio-mcp', version: '3.2.1' }));
    })));
    await assertBridgeHolderUsable('127.0.0.1', port, '3.3.0');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('v3.2.1');
  });

  test('a foreign HTTP server fails fast with one line naming the pid', async () => {
    const port = await listen(track(http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    })));
    const error = await assertBridgeHolderUsable('127.0.0.1', port).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BridgeBusyError);
    const message = (error as Error).message;
    expect(message).not.toContain('\n');
    expect(message).toMatch(/^Studio bridge busy, held by pid (\d+|unknown) \(port \d+: .*not robloxstudio-mcp\)\.$/);
    if (process.platform === 'linux') expect(message).toContain(`pid ${process.pid} `);
  });

  test('a silent holder fails fast instead of hanging', async () => {
    const port = await listen(track(net.createServer(() => { /* never answers */ })));
    const started = Date.now();
    const probe = await probeBridgeHolder('127.0.0.1', port, 300);
    expect(probe.ours).toBe(false);
    expect(probe.reason).toContain('no /health answer');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  (process.platform === 'linux' ? test : test.skip)('finds this process as the listener on Linux', async () => {
    const port = await listen(track(net.createServer()));
    await expect(findListenerPid(port)).resolves.toBe(process.pid);
  });
});

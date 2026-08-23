import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { RobloxStudioMCPServer } from '../server.js';

async function listenOnLoopback(server: Server): Promise<number> {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return (server.address() as AddressInfo).port;
}

describe('primary-only server startup', () => {
  const originalPort = process.env.ROBLOX_STUDIO_PORT;
  const originalHost = process.env.ROBLOX_STUDIO_HOST;
  const originalRequirePrimary = process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY;
  const originalNoAuth = process.env.ROBLOX_STUDIO_NO_AUTH;
  let blocker: Server | undefined;

  afterEach(async () => {
    if (blocker?.listening) {
      const closed = once(blocker, 'close');
      blocker.close();
      await closed;
    }
    blocker = undefined;
    for (const [name, value] of [
      ['ROBLOX_STUDIO_PORT', originalPort],
      ['ROBLOX_STUDIO_HOST', originalHost],
      ['ROBLOX_STUDIO_REQUIRE_PRIMARY', originalRequirePrimary],
      ['ROBLOX_STUDIO_NO_AUTH', originalNoAuth],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    jest.restoreAllMocks();
  });

  test('refuses proxy fallback when an automatically assigned port is stolen', async () => {
    blocker = createServer();
    const port = await listenOnLoopback(blocker);
    process.env.ROBLOX_STUDIO_PORT = String(port);
    delete process.env.ROBLOX_STUDIO_HOST;
    process.env.ROBLOX_STUDIO_REQUIRE_PRIMARY = '1';
    process.env.ROBLOX_STUDIO_NO_AUTH = '1';

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const server = new RobloxStudioMCPServer({
      name: 'primary-only-test',
      version: '0.0.0',
      tools: [],
    });

    await expect(server.run()).rejects.toThrow(/All ports/);

    const errors = errorSpy.mock.calls.flat().join('\n');
    expect(errors).toContain('refusing proxy mode');
    expect(errors).not.toContain('entering proxy mode');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

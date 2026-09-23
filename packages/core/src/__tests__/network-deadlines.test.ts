import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenCloudClient } from '../opencloud-client.js';
import { fetchRobloxDoc, recommendRobloxDocs } from '../roblox-docs.js';
import { RobloxCookieClient } from '../roblox-cookie-client.js';

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test.each([200, 500])('Open Cloud bounds a stalled response body after HTTP %i headers', async (status) => {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.flushHeaders();
    res.write('{');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new OpenCloudClient({
    apiKey: 'test', timeout: 100,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  try {
    await expect(client.getAssetDetails(1)).rejects.toThrow('timed out');
    await expect(client.createAsset({
      assetType: 'Model', displayName: 'test', description: '',
      creationContext: { creator: { userId: '1' } },
    }, Buffer.from('test'), 'test.rbxm')).rejects.toThrow('timed out');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function stalledBody(signal: AbortSignal, status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), { status });
}

test.each(['page', 'catalog'])('documentation %s deadline includes body consumption', async (kind) => {
  jest.useFakeTimers();
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => stalledBody(options!.signal!));
  const result = kind === 'page'
    ? fetchRobloxDoc('classes', 'DeadlineRegression')
    : recommendRobloxDocs('classes', 'DeadlineRegression');
  const assertion = expect(result).rejects.toThrow();
  await jest.advanceTimersByTimeAsync(15_001);
  await assertion;
  expect(jest.getTimerCount()).toBe(0);
});

test('cookie CSRF retry retains the deadline and cancels the rejected body', async () => {
  const controller = new AbortController();
  const deadline = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const cancel = jest.fn();
  const signals: (AbortSignal | null | undefined)[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    signals.push(options?.signal);
    if (signals.length === 1) {
      return new Response(new ReadableStream({ cancel }), {
        status: 403, headers: { 'x-csrf-token': 'test-csrf' },
      });
    }
    const response = stalledBody(options!.signal!);
    queueMicrotask(() => controller.abort(new Error('deadline reached')));
    return response;
  });
  await expect(new RobloxCookieClient('test').uploadImage({
    userId: '1', fileContent: Buffer.from('png'), fileName: 'test.png',
    displayName: 'test', description: '',
  })).rejects.toThrow('deadline reached');
  expect(deadline).toHaveBeenCalledWith(30_000);
  expect(signals).toEqual([controller.signal, controller.signal]);
  expect(cancel).toHaveBeenCalledTimes(1);
});

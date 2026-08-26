import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

interface HttpRequest {
  Url: string;
  Method: string;
  Headers?: Record<string, string>;
  Body?: string;
}

interface HttpResponse {
  Success: boolean;
  StatusCode: number;
  Body: string;
}

interface ScheduledTask {
  delay: number;
  callback: () => void;
}

interface MockSignal<T extends unknown[]> {
  Connect(callback: (...args: T) => void): { Disconnect(): void };
  fire(...args: T): void;
}

interface MockWebStreamClient {
  Opened: MockSignal<[number, Record<string, string>]>;
  MessageReceived: MockSignal<[string]>;
  Error: MockSignal<[number, string]>;
  Closed: MockSignal<[]>;
  Close(): void;
}

interface StudioEventStreamModule {
  start(options: {
    serverUrl: string;
    dispatchRequest(request: Record<string, unknown>): unknown;
    onStatus(status: Record<string, unknown>): void;
    onHeartbeat(timestamp: number): void;
    onReady(response: Record<string, unknown>): void;
    onTransportUpdate(update: Record<string, unknown>): void;
  }): void;
  refresh(): void;
  stop(): void;
}

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function robloxPcall(callback: (...args: never[]) => unknown): [boolean, unknown] {
  try {
    return [true, callback()];
  } catch (error) {
    return [false, error];
  }
}

function createSignal<T extends unknown[]>(): MockSignal<T> {
  const callbacks = new Set<(...args: T) => void>();
  return {
    Connect(callback) {
      callbacks.add(callback);
      return { Disconnect: () => callbacks.delete(callback) };
    },
    fire(...args) {
      for (const callback of callbacks) callback(...args);
    },
  };
}

async function createHarness(
  postResponse: (request: HttpRequest, attempt: number) => HttpResponse,
): Promise<{
  module: StudioEventStreamModule;
  stream: MockWebStreamClient;
  scheduled: ScheduledTask[];
  responseBodies: string[];
  dispatchRequest: jest.Mock;
  emitRequest(requestId: string): void;
}> {
  const scheduled: ScheduledTask[] = [];
  const responseBodies: string[] = [];
  let responseAttempt = 0;
  const stream: MockWebStreamClient = {
    Opened: createSignal(),
    MessageReceived: createSignal(),
    Error: createSignal(),
    Closed: createSignal(),
    Close: jest.fn(),
  };
  const httpService = {
    JSONEncode: (value: unknown) => JSON.stringify(value),
    JSONDecode: (value: string) => JSON.parse(value),
    RequestAsync: (request: HttpRequest): HttpResponse => {
      if (request.Url.endsWith('/ready')) {
        return {
          Success: true,
          StatusCode: 200,
          Body: JSON.stringify({
            success: true,
            assignedRole: 'edit',
            instanceId: 'studio-instance',
            serverVersion: 'test',
          }),
        };
      }
      if (request.Url.endsWith('/response')) {
        responseBodies.push(request.Body!);
        responseAttempt += 1;
        return postResponse(request, responseAttempt);
      }
      throw new Error(`Unexpected request: ${request.Url}`);
    },
    CreateWebStreamClient: () => stream,
  };
  const dependencies: Plugin = {
    name: 'studio-response-delivery-dependencies',
    setup(build) {
      build.onResolve({ filter: /^@rbxts\/services$/ }, () => ({
        path: 'services',
        namespace: 'studio-response-delivery',
      }));
      build.onResolve({ filter: /^\.\/HttpDiagnostics$/ }, () => ({
        path: 'HttpDiagnostics',
        namespace: 'studio-response-delivery',
      }));
      build.onResolve({ filter: /^\.\/PluginSession$/ }, () => ({
        path: 'PluginSession',
        namespace: 'studio-response-delivery',
      }));
      build.onLoad({ filter: /.*/, namespace: 'studio-response-delivery' }, (args) => {
        if (args.path === 'services') {
          return { contents: 'export const HttpService = globalThis.__HTTP_SERVICE__;', loader: 'js' };
        }
        if (args.path === 'HttpDiagnostics') {
          return {
            contents: 'export default { formatRequestFailure: (_url, _completed, value) => String(value) };',
            loader: 'js',
          };
        }
        return {
          contents: `export default {
            id: 'plugin-session',
            getInstanceId: () => 'studio-instance',
            getRole: () => 'edit',
            createReadyPayload: () => ({})
          };`,
          loader: 'js',
        };
      });
    },
  };
  const buildResult = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/StudioEventStream.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [dependencies],
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    console,
    __HTTP_SERVICE__: httpService,
    Enum: { WebStreamClientType: { SSE: 'SSE' } },
    math: {
      min: Math.min,
      max: Math.max,
      pow: Math.pow,
      floor: Math.floor,
    },
    task: {
      spawn: (callback: () => void) => callback(),
      delay: (delay: number, callback: () => void) => scheduled.push({ delay, callback }),
    },
    tick: () => 0,
    pcall: robloxPcall,
    typeIs: (value: unknown, expected: string) => {
      if (expected === 'table') return value !== null && typeof value === 'object';
      return typeof value === expected;
    },
    tostring: (value: unknown) => String(value),
    warn: jest.fn(),
    print: jest.fn(),
  });
  vm.runInContext(`
    String.prototype.gsub = function(search, replacement) {
      const parts = String(this).split(search);
      return [parts.join(replacement), parts.length - 1];
    };
    String.prototype.sub = function(start, finish) {
      const from = start > 0 ? start - 1 : this.length + start;
      const to = finish === undefined ? this.length : (finish > 0 ? finish : this.length + finish + 1);
      return String(this).slice(from, to);
    };
    Array.prototype.size = function() { return this.length; };
  `, context);
  vm.runInContext(buildResult.outputFiles[0].text, context);
  const loaded = commonJsModule.exports as StudioEventStreamModule & { default?: StudioEventStreamModule };
  const eventStream = loaded.default ?? loaded;
  const dispatchRequest = jest.fn((request: Record<string, unknown>) => ({
    success: true,
    requestId: request.requestId,
  }));
  eventStream.start({
    serverUrl: 'http://127.0.0.1:19191',
    dispatchRequest,
    onStatus: jest.fn(),
    onHeartbeat: jest.fn(),
    onReady: jest.fn(),
    onTransportUpdate: jest.fn(),
  });
  stream.Opened.fire(200, {});

  return {
    module: eventStream,
    stream,
    scheduled,
    responseBodies,
    dispatchRequest,
    emitRequest(requestId: string) {
      stream.MessageReceived.fire(JSON.stringify({
        kind: 'request',
        requestId,
        logicalSessionId: 'logical-session',
        target: 'edit',
        endpoint: '/test',
        data: {},
      }));
    },
  };
}

describe('Studio response delivery', () => {
  test('retries the exact encoded response after a lost acknowledgement without redispatching', async () => {
    const harness = await createHarness((_request, attempt) => {
      if (attempt === 1) throw new Error('acknowledgement lost');
      return {
        Success: true,
        StatusCode: 200,
        Body: JSON.stringify({ success: true, disposition: 'already_settled' }),
      };
    });

    harness.emitRequest('request-1');
    harness.emitRequest('request-1');

    const retry = harness.scheduled.find((scheduled) => scheduled.delay === 0.5);
    expect(retry).toBeDefined();
    retry!.callback();
    harness.emitRequest('request-1');

    expect(harness.stream.Close).not.toHaveBeenCalled();
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(2);
    expect(harness.responseBodies[1]).toBe(harness.responseBodies[0]);
  });

  test('treats a non-2xx unknown disposition as terminal', async () => {
    const harness = await createHarness(() => ({
      Success: false,
      StatusCode: 404,
      Body: JSON.stringify({ success: false, disposition: 'unknown' }),
    }));

    harness.emitRequest('expired-request');
    harness.emitRequest('expired-request');

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(1);
    expect(harness.scheduled.some((scheduled) => scheduled.delay === 0.5)).toBe(false);
  });

  test('accepts the legacy 2xx success acknowledgement without retrying', async () => {
    const harness = await createHarness(() => ({
      Success: true,
      StatusCode: 200,
      Body: JSON.stringify({ success: true }),
    }));

    harness.emitRequest('legacy-request');
    harness.emitRequest('legacy-request');

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(1);
    expect(harness.scheduled.some((scheduled) => scheduled.delay === 0.5)).toBe(false);
  });

  test('does not evict an unacknowledged response when more than 256 results are pending', async () => {
    const harness = await createHarness(() => {
      throw new Error('server unavailable');
    });

    for (let index = 0; index < 257; index += 1) {
      harness.emitRequest(`request-${index}`);
    }
    harness.emitRequest('request-0');

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(257);
    expect(harness.responseBodies).toHaveLength(257);
  });
});

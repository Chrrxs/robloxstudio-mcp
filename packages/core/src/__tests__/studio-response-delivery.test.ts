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

interface StudioRequestContext {
  requestId: string;
  deadlineAt: number;
  isCancelled(): boolean;
}

interface StudioEventStreamModule {
  start(options: {
    serverUrl: string;
    dispatchRequest(request: Record<string, unknown>, context: StudioRequestContext): unknown;
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
      for (const callback of [...callbacks]) callback(...args);
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
  onStatus: jest.Mock;
  onHeartbeat: jest.Mock;
  emitRequest(requestId: string): void;
  emitCancel(requestId: string): void;
  deferSpawns(): void;
  flushSpawns(): void;
}> {
  const scheduled: ScheduledTask[] = [];
  const responseBodies: string[] = [];
  const spawned: Array<() => void> = [];
  let spawnsDeferred = false;
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
            peerId: 'peer',
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
            peerId: 'peer',
            getInstanceId: () => 'studio-instance',
            getMultiplayerGroupId: () => undefined,
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
      spawn: (callback: () => void) => {
        if (spawnsDeferred) spawned.push(callback);
        else callback();
      },
      delay: (delay: number, callback: () => void) => scheduled.push({ delay, callback }),
    },
    tick: () => 0,
    os: { clock: () => 10 },
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
    String.prototype.size = function() { return this.length; };
    String.prototype.find = function(pattern, init = 1, plain = false) {
      const value = String(this);
      const offset = init - 1;
      if (plain) {
        const index = value.indexOf(pattern, offset);
        return index < 0 ? [] : [index + 1, index + pattern.length];
      }
      const match = new RegExp(pattern).exec(value.slice(offset));
      return match ? [offset + match.index + 1, offset + match.index + match[0].length] : [];
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
  const onStatus = jest.fn();
  const onHeartbeat = jest.fn();
  eventStream.start({
    serverUrl: 'http://127.0.0.1:19191',
    dispatchRequest,
    onStatus,
    onHeartbeat,
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
    onStatus,
    onHeartbeat,
    deferSpawns() {
      spawnsDeferred = true;
    },
    flushSpawns() {
      spawnsDeferred = false;
      while (spawned.length > 0) spawned.shift()?.();
    },
    emitRequest(requestId: string) {
      stream.MessageReceived.fire(JSON.stringify({
        kind: 'request',
        requestId,
        peerId: 'peer',
        target: 'edit',
        endpoint: '/test',
        data: {},
        remainingMs: 1000,
      }));
    },
    emitCancel(requestId: string) {
      stream.MessageReceived.fire(JSON.stringify({
        kind: 'cancel',
        requestId,
        reason: 'aborted',
      }));
    },
  };
}

describe('Studio request lifecycle', () => {
  test('cancels in-flight work and suppresses its late response', async () => {
    const harness = await createHarness(() => ({
      Success: true,
      StatusCode: 200,
      Body: JSON.stringify({ success: true }),
    }));
    harness.dispatchRequest.mockImplementation((
      _request: Record<string, unknown>,
      context: StudioRequestContext,
    ) => {
      expect(context.requestId).toBe('cancelled-request');
      expect(context.deadlineAt).toBe(11);
      expect(context.isCancelled()).toBe(false);
      harness.emitCancel('cancelled-request');
      expect(context.isCancelled()).toBe(true);
      return { success: true };
    });

    harness.emitRequest('cancelled-request');

    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(0);
  });

  test('does not dispatch queued work after the event stream stops', async () => {
    const harness = await createHarness(() => ({
      Success: true,
      StatusCode: 200,
      Body: JSON.stringify({ success: true }),
    }));
    harness.deferSpawns();
    harness.emitRequest('stopped-request');

    harness.module.stop();
    harness.flushSpawns();

    expect(harness.dispatchRequest).not.toHaveBeenCalled();
    expect(harness.responseBodies).toHaveLength(0);
  });
});

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

function requestEvent(requestId: string, target = 'edit'): Record<string, unknown> {
  return {
    kind: 'request',
    requestId,
    peerId: 'peer',
    target,
    endpoint: '/api/get-runtime-logs',
    data: { tail: 10 },
    remainingMs: 5000,
  };
}

function dataFrame(event: Record<string, unknown>, newline = '\n'): string {
  return `data: ${JSON.stringify(event)}${newline}${newline}`;
}

function acceptedResponse(): HttpResponse {
  return { Success: true, StatusCode: 200, Body: '{"success":true}' };
}

describe('Studio event stream framing', () => {
  test('dispatches both runtime-log requests from one MessageReceived callback', async () => {
    const harness = await createHarness(acceptedResponse);
    harness.stream.MessageReceived.fire(
      'data: {"kind":"request","requestId":"601e7596-b39a-495b-ba2b-59b54cb079ba","peerId":"peer:o1s-gsh","target":"server","endpoint":"/api/get-runtime-logs","data":{"tail":10,"filter":"__MCP_LOG_TIMEOUT_PROBE__"},"remainingMs":5000}\n\n' +
      'data: {"kind":"request","requestId":"2294d3ab-58f1-4672-9bdb-d7e3bd216e93","peerId":"peer:lvp-0jp","target":"client-1","endpoint":"/api/get-runtime-logs","data":{"tail":10,"filter":"__MCP_LOG_TIMEOUT_PROBE__"},"remainingMs":5000}\n\n',
    );

    expect(harness.dispatchRequest.mock.calls.map(([event]) => [event.requestId, event.target]))
      .toEqual([
        ['601e7596-b39a-495b-ba2b-59b54cb079ba', 'server'],
        ['2294d3ab-58f1-4672-9bdb-d7e3bd216e93', 'client-1'],
      ]);
    expect(harness.responseBodies.map((body) => JSON.parse(body).requestId))
      .toEqual(['601e7596-b39a-495b-ba2b-59b54cb079ba', '2294d3ab-58f1-4672-9bdb-d7e3bd216e93']);
  });

  test('preserves heartbeat, status, cancellation and request order in a mixed batch', async () => {
    const harness = await createHarness(acceptedResponse);
    harness.deferSpawns();
    harness.stream.MessageReceived.fire([
      { kind: 'heartbeat', timestamp: 123 },
      { kind: 'status', knownPeer: true, mcpConnected: true },
      requestEvent('cancelled'),
      { kind: 'cancel', requestId: 'cancelled', reason: 'timeout' },
      requestEvent('surviving'),
    ].map((event) => dataFrame(event)).join(''));
    harness.flushSpawns();

    expect(harness.onHeartbeat).toHaveBeenCalledWith(123);
    expect(harness.onStatus).toHaveBeenCalledWith(expect.objectContaining({
      knownPeer: true, mcpConnected: true,
    }));
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['surviving']);
    expect(harness.responseBodies.map((body) => JSON.parse(body).requestId)).toEqual(['surviving']);
  });

  test('accepts bare JSON, an un-terminated data line and a complete SSE frame', async () => {
    const harness = await createHarness(acceptedResponse);
    harness.stream.MessageReceived.fire(` \r\n${JSON.stringify(requestEvent('bare'))}\n`);
    harness.stream.MessageReceived.fire(`data: ${JSON.stringify(requestEvent('raw-data'))}`);
    harness.stream.MessageReceived.fire(dataFrame(requestEvent('framed')));

    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId))
      .toEqual(['bare', 'raw-data', 'framed']);
  });

  test('reassembles every split point, including the data prefix and CRLF delimiter', async () => {
    const harness = await createHarness(acceptedResponse);
    const expected: string[] = [];
    const length = dataFrame(requestEvent('fragment-000'), '\r\n').length;
    for (let split = 1; split < length; split += 1) {
      const id = `fragment-${String(split).padStart(3, '0')}`;
      expected.push(id);
      const frame = dataFrame(requestEvent(id), '\r\n');
      harness.stream.MessageReceived.fire(frame.slice(0, split));
      harness.stream.MessageReceived.fire(frame.slice(split));
    }

    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(expected);
  });

  test('keeps a partial following frame while dispatching the complete preceding frame', async () => {
    const harness = await createHarness(acceptedResponse);
    const second = dataFrame(requestEvent('second'));
    harness.stream.MessageReceived.fire(dataFrame(requestEvent('first')) + second.slice(0, 23));
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['first']);
    harness.stream.MessageReceived.fire(second.slice(23));
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['first', 'second']);
  });

  test('ignores comments and unknown fields and joins multiline data without poisoning later frames', async () => {
    const harness = await createHarness(acceptedResponse);
    harness.stream.MessageReceived.fire(
      ': keepalive\r\n\r\nid: 42\r\nevent: message\r\ndata: {"kind":"heartbeat",\r\ndata: "timestamp":456}\r\n\r\n' +
      'data: not-json\n\ndata: {"kind":"request","requestId":"invalid"}\n\n' +
      dataFrame(requestEvent('after-malformed')),
    );
    expect(harness.onHeartbeat).toHaveBeenCalledWith(456);
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['after-malformed']);
  });

  test('abandons old partial data and CRLF state when the stream reconnects', async () => {
    const harness = await createHarness(acceptedResponse);
    harness.stream.MessageReceived.fire('data: {"kind":"request",');
    harness.module.refresh();
    harness.stream.MessageReceived.fire(dataFrame(requestEvent('after-refresh')));
    harness.stream.MessageReceived.fire('data: incomplete\r');
    harness.stream.Closed.fire();
    const reconnect = harness.scheduled.find((scheduled) => scheduled.delay === 0.5);
    expect(reconnect).toBeDefined();
    reconnect!.callback();
    harness.stream.MessageReceived.fire(dataFrame(requestEvent('after-close')));
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId))
      .toEqual(['after-refresh', 'after-close']);
  });

  test('stops dispatching an old batch after status refreshes the stream', async () => {
    const harness = await createHarness(acceptedResponse);
    harness.stream.MessageReceived.fire(
      dataFrame({ kind: 'status', knownPeer: false, mcpConnected: false }) +
      dataFrame(requestEvent('old-stream-request')),
    );
    harness.stream.MessageReceived.fire(dataFrame(requestEvent('new-stream-request')));
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['new-stream-request']);
  });

  test('drops an oversized unfinished frame and recovers at the next frame delimiter', async () => {
    const harness = await createHarness(acceptedResponse);
    const prefix = JSON.stringify(requestEvent('oversized')).slice(0, -1);
    harness.stream.MessageReceived.fire(`data: ${prefix},"padding":"`);
    const block = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 65; index += 1) {
      harness.stream.MessageReceived.fire(block);
    }
    harness.stream.MessageReceived.fire(`"}\n\n${dataFrame(requestEvent('after-oversized'))}`);
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['after-oversized']);
  });
});

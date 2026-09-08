import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';

interface HttpRequest {
  Url: string;
  Method?: string;
  Headers?: Record<string, string>;
  Body?: string;
}

interface HttpResponse {
  Success: boolean;
  StatusCode: number;
  Body: string;
}

interface ScheduledTask {
  due: number;
  callback: () => void;
}

interface MockSignal<T extends unknown[]> {
  Connect(callback: (...args: T) => void): { Disconnect(): void };
  fire(...args: T): void;
  capture(): (...args: T) => void;
}

interface MockWebStreamClient {
  Opened: MockSignal<[number, string]>;
  MessageReceived: MockSignal<[string]>;
  Error: MockSignal<[number, string]>;
  Closed: MockSignal<[]>;
  Send(body: string): void;
  Close(): void;
}

interface StudioRequestContext {
  requestId: string;
  deadlineAt: number;
  isCancelled(): boolean;
}

interface StudioWebSocketOptions {
  serverUrl: string;
  dispatchRequest(request: Record<string, unknown>, context: StudioRequestContext): unknown;
  onStatus(status: Record<string, unknown>): void;
  onHeartbeat(timestamp: number): void;
  onReady(response: Record<string, unknown>): void;
  onTransportUpdate(update: Record<string, unknown>): void;
}

interface StudioWebSocketModule {
  start(options: StudioWebSocketOptions): void;
  refresh(): void;
  suspendForShutdown(): void;
  resumeAfterShutdownFailure(): void;
  stop(): void;
}

interface ResponseEnvelope {
  kind: 'response';
  requestId: string;
  response?: unknown;
  error?: string;
  executionOutcome?: 'success' | 'error' | 'not_executed' | 'unknown';
}

interface ProgressEnvelope {
  kind: 'progress';
  requestId: string;
  phase: 'executing' | 'response_delivery';
  outcome?: 'success' | 'error' | 'not_executed' | 'unknown';
}

interface HarnessOptions {
  onSend?(body: string, stream: MockWebStreamClient): void;
  onProgress?(event: ProgressEnvelope, stream: MockWebStreamClient): void;
  onEncode?(value: unknown): void;
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
    capture() {
      const captured = [...callbacks];
      return (...args) => { for (const callback of captured) callback(...args); };
    },
    fire(...args) {
      for (const callback of [...callbacks]) callback(...args);
    },
  };
}

const dependencies: Plugin = {
  name: 'studio-response-delivery-dependencies',
  setup(build) {
    build.onResolve({ filter: /^@rbxts\/services$/ }, () => ({ path: 'services', namespace: 'studio-websocket' }));
    build.onResolve({ filter: /^\.\/HttpDiagnostics$/ }, () => ({ path: 'HttpDiagnostics', namespace: 'studio-websocket' }));
    build.onResolve({ filter: /^\.\/PluginSession$/ }, () => ({ path: 'PluginSession', namespace: 'studio-websocket' }));
    build.onLoad({ filter: /.*/, namespace: 'studio-websocket' }, (args) => {
      if (args.path === 'services') return { contents: 'export const HttpService = globalThis.__HTTP_SERVICE__;', loader: 'js' };
      if (args.path === 'HttpDiagnostics') {
        return { contents: 'export default { formatRequestFailure: (_url, _completed, value) => String(value) };', loader: 'js' };
      }
      return {
        contents: `export default {
          peerId: 'peer', getInstanceId: () => 'studio-instance',
          getMultiplayerGroupId: () => undefined, getRole: () => 'edit',
          createReadyPayload: () => ({})
        };`,
        loader: 'js',
      };
    });
  },
};

let bundledModule: Promise<string> | undefined;
function pluginModule(): Promise<string> {
  bundledModule ??= esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/StudioWebSocket.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20',
    logLevel: 'silent', plugins: [dependencies],
  }).then((result) => result.outputFiles[0].text);
  return bundledModule;
}

function responseEnvelope(body: string): ResponseEnvelope {
  const value: unknown = JSON.parse(body);
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'response' ||
      !('requestId' in value) || typeof value.requestId !== 'string') throw new Error('Invalid response envelope');
  return {
    kind: 'response', requestId: value.requestId,
    response: 'response' in value ? value.response : undefined,
    error: 'error' in value && typeof value.error === 'string' ? value.error : undefined,
    ...('executionOutcome' in value && (value.executionOutcome === 'success' || value.executionOutcome === 'error' || value.executionOutcome === 'not_executed' || value.executionOutcome === 'unknown')
      ? { executionOutcome: value.executionOutcome } : {}),
  };
}

function acknowledge(stream: MockWebStreamClient, requestId: string, disposition = 'accepted'): void {
  stream.MessageReceived.fire(JSON.stringify({ kind: 'ack', requestId, disposition }));
}

async function createHarness(harnessOptions: HarnessOptions = {}) {
  const scheduled: ScheduledTask[] = [];
  const responseBodies: string[] = [];
  const progressEvents: ProgressEnvelope[] = [];
  const httpRequests: HttpRequest[] = [];
  const socketRequests: Array<{ kind: string; request: HttpRequest }> = [];
  const streams: MockWebStreamClient[] = [];
  const lifecycle: string[] = [];
  const spawned: Array<() => void> = [];
  let spawnsDeferred = false;
  let httpQuotaExhausted = false;
  let now = 10;
  const httpService = {
    JSONEncode: (value: unknown) => {
      harnessOptions.onEncode?.(value);
      return JSON.stringify(value);
    },
    JSONDecode: (value: string): unknown => JSON.parse(value),
    UrlEncode: encodeURIComponent,
    RequestAsync: (request: HttpRequest): HttpResponse => {
      httpRequests.push(request);
      lifecycle.push(request.Url.endsWith('/disconnect') ? 'disconnect' : 'ready');
      if (httpQuotaExhausted) throw new Error('Number of requests exceeded limit');
      if (request.Url.endsWith('/ready')) {
        return {
          Success: true, StatusCode: 200,
          Body: JSON.stringify({
            success: true, assignedRole: 'edit', peerId: 'peer', instanceId: 'studio-instance',
            protocolVersion: 1, transportToken: 'test-secret',
          }),
        };
      }
      if (request.Url.endsWith('/disconnect')) return { Success: true, StatusCode: 200, Body: '{}' };
      throw new Error(`Unexpected HTTP request: ${request.Url}`);
    },
    CreateWebStreamClient: (kind: string, request: HttpRequest) => {
      socketRequests.push({ kind, request });
      const stream: MockWebStreamClient = {
        Opened: createSignal(), MessageReceived: createSignal(), Error: createSignal(), Closed: createSignal(),
        Close: jest.fn(() => lifecycle.push('close')),
        Send: jest.fn((body: string) => {
          const event: unknown = JSON.parse(body);
          if (event && typeof event === 'object' && 'kind' in event && event.kind === 'progress'
            && 'requestId' in event && typeof event.requestId === 'string'
            && 'phase' in event && (event.phase === 'executing' || event.phase === 'response_delivery')) {
            const progress: ProgressEnvelope = {
              kind: 'progress', requestId: event.requestId, phase: event.phase,
              ...('outcome' in event && (event.outcome === 'success' || event.outcome === 'error' || event.outcome === 'not_executed' || event.outcome === 'unknown')
                ? { outcome: event.outcome } : {}),
            };
            progressEvents.push(progress);
            harnessOptions.onProgress?.(progress, stream);
            return;
          }
          responseBodies.push(body);
          if (harnessOptions.onSend) harnessOptions.onSend(body, stream);
          else acknowledge(stream, responseEnvelope(body).requestId);
        }),
      };
      streams.push(stream);
      return stream;
    },
  };
  const commonJsModule = { exports: {} as unknown };
  const warnings = jest.fn();
  const context = vm.createContext({
    module: commonJsModule, exports: commonJsModule.exports, console,
    __HTTP_SERVICE__: httpService, __BYTE_LENGTH__: (value: string) => Buffer.byteLength(value, 'utf8'),
    Enum: { WebStreamClientType: { WebSocket: 'WebSocket' } },
    math: { min: Math.min, max: Math.max, pow: Math.pow, floor: Math.floor, huge: Infinity },
    task: {
      spawn: (callback: () => void) => {
        if (spawnsDeferred) spawned.push(callback);
        else callback();
      },
      delay: (delay: number, callback: () => void) => {
        const timer = { due: now + delay, callback };
        scheduled.push(timer);
        return timer;
      },
      cancel: (timer: ScheduledTask) => {
        const index = scheduled.indexOf(timer);
        if (index !== -1) scheduled.splice(index, 1);
      },
    },
    tick: () => now, os: { clock: () => now }, pcall: robloxPcall,
    typeIs: (value: unknown, expected: string) => expected === 'table'
      ? value !== null && typeof value === 'object' : typeof value === expected,
    tostring: (value: unknown) => String(value), warn: warnings, print: jest.fn(),
  });
  vm.runInContext(`
    const NativeMap = Map;
    globalThis.Map = class {
      constructor() { this.values = new NativeMap(); }
      size() { return this.values.size; }
      get(key) { return this.values.get(key); }
      set(key, value) { this.values.set(key, value); return this; }
      has(key) { return this.values.has(key); }
      delete(key) { return this.values.delete(key); }
      clear() { this.values.clear(); }
      [Symbol.iterator]() { return this.values[Symbol.iterator](); }
    };
    String.prototype.gsub = function(pattern, replacement) {
      const matches = String(this).match(new RegExp(pattern, 'g')) ?? [];
      return [String(this).replace(new RegExp(pattern, 'g'), replacement), matches.length];
    };
    String.prototype.size = function() { return __BYTE_LENGTH__(String(this)); };
    String.prototype.sub = function(start, finish) {
      return String(this).slice(start > 0 ? start - 1 : this.length + start,
        finish === undefined ? this.length : (finish > 0 ? finish : this.length + finish + 1));
    };
    Array.prototype.size = function() { return this.length; };
  `, context);
  vm.runInContext(await pluginModule(), context);
  const loaded = commonJsModule.exports as StudioWebSocketModule & { default?: StudioWebSocketModule };
  const websocket = loaded.default ?? loaded;
  const dispatchRequest = jest.fn<unknown, [Record<string, unknown>, StudioRequestContext]>((request) => ({
    success: true, requestId: request.requestId,
  }));
  const onStatus = jest.fn();
  const onHeartbeat = jest.fn();
  const onReady = jest.fn();
  const onTransportUpdate = jest.fn();
  const options: StudioWebSocketOptions = {
    serverUrl: 'http://127.0.0.1:19191', dispatchRequest, onStatus, onHeartbeat, onReady, onTransportUpdate,
  };
  websocket.start(options);
  streams[0].Opened.fire(101, '');

  function advance(seconds: number): void {
    const target = now + seconds;
    while (scheduled.length > 0) {
      scheduled.sort((left, right) => left.due - right.due);
      const next = scheduled[0];
      if (next === undefined || next.due > target) break;
      scheduled.shift();
      now = next.due;
      next.callback();
    }
    now = target;
  }

  return {
    module: websocket, streams, responseBodies, progressEvents, httpRequests, socketRequests, lifecycle, warnings,
    dispatchRequest, onStatus, onHeartbeat, onReady, onTransportUpdate, advance,
    get stream() { return streams[streams.length - 1]; },
    get scheduledTaskCount() { return scheduled.length; },
    exhaustHttpQuota() { httpQuotaExhausted = true; },
    deferSpawns() { spawnsDeferred = true; },
    flushSpawns() {
      spawnsDeferred = false;
      while (spawned.length > 0) spawned.shift()?.();
    },
    emitRequest(requestId: string, target = 'edit') {
      streams[streams.length - 1].MessageReceived.fire(JSON.stringify(requestEvent(requestId, target)));
    },
    emitCancel(requestId: string, reason = 'aborted') {
      streams[streams.length - 1].MessageReceived.fire(JSON.stringify({ kind: 'cancel', requestId, reason }));
    },
    reconnect() {
      streams[streams.length - 1].Closed.fire();
      advance(0.5);
      streams[streams.length - 1].Opened.fire(101, '');
    },
    restart() {
      websocket.start(options);
      streams[streams.length - 1].Opened.fire(101, '');
    },
  };
}

function requestEvent(requestId: string, target = 'edit'): Record<string, unknown> {
  return {
    kind: 'request', requestId, peerId: target === 'edit' ? 'peer' : `peer:${target}`,
    target, endpoint: '/api/get-runtime-logs', data: { tail: 10 }, remainingMs: 1000,
  };
}

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

describe('Studio WebSocket response delivery', () => {
  test('reports executing before the handler and completion before encoding the result', async () => {
    const observed: string[] = [];
    const harness = await createHarness({
      onProgress(event) { observed.push(event.phase); },
      onEncode(value) {
        if (value && typeof value === 'object' && 'kind' in value && value.kind === 'response') observed.push('encode');
      },
    });
    harness.dispatchRequest.mockImplementation(() => { observed.push('handler'); return { success: true }; });
    harness.emitRequest('progress-order');
    expect(observed).toEqual(['executing', 'handler', 'response_delivery', 'encode']);
    expect(harness.progressEvents).toEqual([
      { kind: 'progress', requestId: 'progress-order', phase: 'executing' },
      { kind: 'progress', requestId: 'progress-order', phase: 'response_delivery', outcome: 'success' },
    ]);
  });

  test.each([
    ['compile', { success: false, error: 'Compile error' }],
    ['runtime', { ok: false, error: 'Runtime error' }],
    ['property', { summary: { total: 2, succeeded: 1, failed: 1 }, results: [{ success: false }] }],
  ])('reports %s handler failure even when dispatch does not throw', async (_name, response) => {
    const harness = await createHarness();
    harness.dispatchRequest.mockReturnValue(response);
    harness.emitRequest('failed-handler');
    expect(responseEnvelope(harness.responseBodies[0]).executionOutcome).toBe('error');
    expect(harness.progressEvents.at(-1)).toMatchObject({ phase: 'response_delivery', outcome: 'error' });
  });

  test('replays only current progress once per new connection before the retained result', async () => {
    const observed: string[] = [];
    let loseProgress = true;
    const harness = await createHarness({
      onProgress(event) {
        observed.push(event.phase);
        if (loseProgress) { loseProgress = false; throw new Error('progress lost'); }
      },
      onSend() { observed.push('response'); },
    });
    harness.emitRequest('lost-progress');
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('lost-progress');
    expect(observed).toEqual(['executing', 'response_delivery', 'response']);
    harness.reconnect();
    expect(observed).toEqual(['executing', 'response_delivery', 'response', 'response_delivery', 'response']);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('reports cancellation before handler entry as not executed', async () => {
    const harness = await createHarness();
    harness.deferSpawns();
    harness.emitRequest('not-started');
    harness.emitCancel('not-started');
    harness.flushSpawns();
    expect(harness.dispatchRequest).not.toHaveBeenCalled();
    expect(harness.progressEvents).toEqual([
      { kind: 'progress', requestId: 'not-started', phase: 'response_delivery', outcome: 'not_executed' },
    ]);
  });
  test('closes the old socket before recovering a lost ack without repeating the mutation', async () => {
    let first: MockWebStreamClient | undefined;
    const harness = await createHarness({ onSend(body, stream) {
      if (first === undefined) first = stream;
      else {
        expect(first.Close).toHaveBeenCalledTimes(1);
        expect(stream).not.toBe(first);
        acknowledge(stream, responseEnvelope(body).requestId, 'already_settled');
      }
    } });
    harness.emitRequest('mutation');
    const staleMessage = harness.stream.MessageReceived.capture();
    for (let elapsed = 0; elapsed < 120; elapsed += 10) {
      harness.stream.MessageReceived.fire(JSON.stringify({ kind: 'heartbeat', timestamp: elapsed }));
      harness.advance(10);
    }
    expect(first?.Close).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(1);
    harness.advance(0.5);
    staleMessage(JSON.stringify({ kind: 'ack', requestId: 'mutation', disposition: 'accepted' }));
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('mutation');
    harness.advance(5);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(2);
    expect(harness.responseBodies[1]).toBe(harness.responseBodies[0]);
    expect(harness.httpRequests.map((request) => request.Url)).toEqual(['http://127.0.0.1:19191/ready']);
  });

  test('does not queue duplicate large frames while a live upload receives heartbeats', async () => {
    const harness = await createHarness({ onSend() {} });
    harness.dispatchRequest.mockReturnValue('x'.repeat(8 * 1024 * 1024));
    const original = harness.stream;
    harness.emitRequest('slow-upload');
    for (let elapsed = 0; elapsed < 90; elapsed += 10) {
      original.MessageReceived.fire(JSON.stringify({ kind: 'heartbeat', timestamp: elapsed }));
      harness.emitRequest('slow-upload');
      harness.advance(10);
    }
    expect(harness.responseBodies).toHaveLength(1);
    expect(original.Close).not.toHaveBeenCalled();
    acknowledge(original, 'slow-upload');
    harness.advance(15);
    expect(harness.responseBodies).toHaveLength(1);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('dispatches and acknowledges Unicode request IDs within the bridge character limit', async () => {
    const harness = await createHarness();
    const requestId = '界'.repeat(100);
    harness.emitRequest(requestId);
    harness.emitRequest(requestId);
    harness.advance(5);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(1);
    expect(responseEnvelope(harness.responseBodies[0])).toEqual({
      kind: 'response', requestId, response: { success: true, requestId }, error: undefined, executionOutcome: 'success',
    });
  });

  test('reconnects with cached credentials and resends results while HTTP quota is exhausted', async () => {
    let attempts = 0;
    const harness = await createHarness({ onSend(body, stream) {
      if (++attempts > 1) acknowledge(stream, responseEnvelope(body).requestId);
    } });
    harness.emitRequest('quota-mutation');
    harness.exhaustHttpQuota();
    harness.reconnect();
    harness.emitRequest('quota-mutation');
    harness.emitRequest('quota-next');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(2);
    expect(harness.responseBodies[1]).toBe(harness.responseBodies[0]);
    expect(harness.responseBodies.map((body) => responseEnvelope(body).requestId)).toEqual(['quota-mutation', 'quota-mutation', 'quota-next']);
    expect(harness.httpRequests).toHaveLength(1);
    expect(harness.socketRequests).toEqual([0, 1].map(() => ({
      kind: 'WebSocket', request: {
        Url: 'ws://127.0.0.1:19191/studio?peerId=peer&protocolVersion=1',
        Headers: { 'X-Studio-Token': 'test-secret' },
      },
    })));
    expect(harness.onTransportUpdate).toHaveBeenLastCalledWith({ state: 'open', attempt: 0, retryDelay: 0 });
  });

  test('retains results through send failures and ignores a stale socket acknowledgement', async () => {
    let attempts = 0;
    const harness = await createHarness({ onSend() {
      if (++attempts === 1) throw new Error('socket send failed');
    } });
    const original = harness.stream;
    harness.emitRequest('send-failure');
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    acknowledge(original, 'send-failure');
    harness.advance(1);
    expect(harness.responseBodies).toHaveLength(2);
    harness.reconnect();
    acknowledge(harness.stream, 'send-failure', 'already_settled');
    harness.advance(5);
    expect(harness.responseBodies).toHaveLength(3);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('requires an explicit known disposition and makes unknown terminal without replay', async () => {
    const harness = await createHarness({ onSend() {} });
    harness.emitRequest('expired-on-server');
    acknowledge(harness.stream, 'expired-on-server', 'invalid');
    harness.reconnect();
    acknowledge(harness.stream, 'expired-on-server', 'unknown');
    harness.emitRequest('expired-on-server');
    harness.advance(5);
    expect(harness.responseBodies).toHaveLength(2);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.warnings).toHaveBeenCalledWith(expect.stringContaining('outcome unknown'));
  });

  test('expires unacknowledged bytes explicitly but retains the no-replay tombstone', async () => {
    const harness = await createHarness({ onSend() {} });
    harness.emitRequest('unacknowledged');
    harness.module.suspendForShutdown();
    harness.advance(300);
    harness.module.resumeAfterShutdownFailure();
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('unacknowledged');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(1);
    expect(harness.warnings).toHaveBeenCalledWith(expect.stringContaining('outcome unknown (expired)'));
  });

  test('bounds unacknowledged admission without evicting or reexecuting a stored result', async () => {
    const harness = await createHarness({ onSend() {} });
    for (let index = 0; index < 128; index++) harness.emitRequest(`pending-${index}`);
    harness.emitRequest('capacity-rejected');
    harness.emitRequest('pending-0');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(128);
    expect(responseEnvelope(harness.responseBodies[128]).error).toContain('stage=request_admission');
    expect(responseEnvelope(harness.responseBodies[128]).executionOutcome).toBe('not_executed');
    acknowledge(harness.stream, 'pending-1');
    harness.emitRequest('capacity-rejected');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(128);
    harness.emitRequest('newly-admitted');
    harness.advance(0.5);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(129);
    const originalRetries = harness.responseBodies.filter((body) => responseEnvelope(body).requestId === 'pending-0');
    expect(originalRetries).toHaveLength(1);
  });

  test.each(['throw', 'drop'] as const)('recovers a retained admission error after Send %s without execution', async (failure) => {
    let failed = false;
    const harness = await createHarness({ onSend(body, stream) {
      if (responseEnvelope(body).requestId !== 'rejected' || failed) return;
      failed = true;
      if (failure === 'throw') throw new Error('send failed');
      stream.Closed.fire();
    } });
    for (let index = 0; index < 128; index++) harness.emitRequest(`pending-${index}`);
    const old = harness.stream;
    const staleMessage = old.MessageReceived.capture();
    harness.emitRequest('rejected');
    const rejection = harness.responseBodies[128];
    expect(responseEnvelope(rejection).error).toContain('execution not started');
    expect(Buffer.byteLength(rejection)).toBeLessThanOrEqual(4096);
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    staleMessage(JSON.stringify({ kind: 'ack', requestId: 'rejected', disposition: 'accepted' }));
    harness.emitRequest('rejected');
    harness.reconnect();
    expect(harness.responseBodies.filter((body) => responseEnvelope(body).requestId === 'rejected')).toEqual([
      rejection, rejection, rejection,
    ]);
    acknowledge(harness.stream, 'rejected');
    acknowledge(harness.stream, 'pending-0');
    harness.emitRequest('rejected');
    harness.emitRequest('after-rejection-ack');
    expect(harness.dispatchRequest.mock.calls.map(([request]) => request.requestId)).toEqual([
      ...Array.from({ length: 128 }, (_, index) => `pending-${index}`), 'after-rejection-ack',
    ]);
    harness.reconnect();
    expect(harness.responseBodies.filter((body) => responseEnvelope(body).requestId === 'rejected')).toHaveLength(3);
  });

  test('bounds rejection storage and recovers admission after saturation acknowledgements', async () => {
    const harness = await createHarness({ onSend() {} });
    for (let index = 0; index < 128; index++) harness.emitRequest(`pending-${index}`);
    for (let index = 0; index < 128; index++) harness.emitRequest(`rejected-${index}`);
    const original = harness.stream;
    harness.emitRequest('overflow');
    expect(original.Close).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(256);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(128);
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    const replay = harness.responseBodies.slice(256).map(responseEnvelope);
    expect(replay.map((response) => response.requestId)).toEqual(
      harness.responseBodies.slice(0, 256).map((body) => responseEnvelope(body).requestId),
    );
    for (const response of replay) acknowledge(harness.stream, response.requestId);
    harness.emitRequest('rejected-0');
    harness.emitRequest('after-saturation');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(129);
    expect(responseEnvelope(harness.responseBodies[harness.responseBodies.length - 1]).requestId).toBe('after-saturation');
  });

  test('reserves terminal slots for rejection outcomes and refuses execution when every slot is held', async () => {
    const harness = await createHarness();
    for (let index = 0; index < 32768; index++) harness.emitRequest(`terminal-${index}`);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(32640);
    expect(responseEnvelope(harness.responseBodies[32640]).error).toContain('execution not started');
    const original = harness.stream;
    harness.emitRequest('terminal-overflow');
    expect(original.Close).toHaveBeenCalledTimes(1);
    expect(harness.responseBodies).toHaveLength(32768);
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('terminal-0');
    harness.emitRequest('terminal-32640');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(32640);
    expect(harness.responseBodies).toHaveLength(32768);
    harness.module.suspendForShutdown();
    harness.advance(300);
    harness.module.resumeAfterShutdownFailure();
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('after-terminal-expiry');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(32641);
    expect(responseEnvelope(harness.responseBodies[harness.responseBodies.length - 1]).error).toBeUndefined();
  });

  test('releases delivery timers on ack and expires retained rejections across suspended generations', async () => {
    const acknowledged = await createHarness();
    for (let index = 0; index < 1024; index++) acknowledged.emitRequest(`ack-${index}`);
    acknowledged.module.stop();
    acknowledged.advance(20);
    expect(acknowledged.scheduledTaskCount).toBe(0);

    const harness = await createHarness({ onSend() {} });
    for (let index = 0; index < 128; index++) harness.emitRequest(`pending-${index}`);
    harness.emitRequest('rejection-expiry');
    harness.module.suspendForShutdown();
    harness.advance(300);
    expect(harness.scheduledTaskCount).toBe(0);
    harness.module.resumeAfterShutdownFailure();
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('rejection-expiry');
    harness.emitRequest('after-expiry');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(129);
    expect(harness.responseBodies.filter((body) => responseEnvelope(body).requestId === 'rejection-expiry')).toHaveLength(1);
  });

  test('retains compact acknowledged IDs beyond 1024 ordinary calls', async () => {
    const harness = await createHarness();
    for (let index = 0; index < 1025; index++) harness.emitRequest(`settled-${index}`);
    harness.emitRequest('settled-0');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1025);
    expect(harness.responseBodies.map((body) => responseEnvelope(body).error)).not.toContainEqual(expect.any(String));
  });
});

describe('Studio WebSocket request lifecycle', () => {
  test('captures the eventual result when cancellation arrives after execution starts', async () => {
    const harness = await createHarness();
    harness.dispatchRequest.mockImplementation((_request, context) => {
      expect(context.deadlineAt).toBe(11);
      expect(context.isCancelled()).toBe(false);
      harness.emitCancel('running-mutation', 'timeout');
      expect(context.isCancelled()).toBe(true);
      return { mutationCount: 1 };
    });
    harness.emitRequest('running-mutation');
    expect(responseEnvelope(harness.responseBodies[0]).response).toEqual({ mutationCount: 1 });
    harness.emitRequest('running-mutation');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('retains completed but unacknowledged responses after cancellation', async () => {
    const harness = await createHarness({ onSend() {} });
    harness.emitRequest('completed');
    harness.emitCancel('completed', 'timeout');
    harness.reconnect();
    expect(harness.responseBodies).toHaveLength(2);
    expect(harness.responseBodies[1]).toBe(harness.responseBodies[0]);
  });

  test('deduplicates a known in-flight mutation through a reconnect', async () => {
    const harness = await createHarness();
    harness.dispatchRequest.mockImplementation(() => {
      harness.exhaustHttpQuota();
      harness.reconnect();
      harness.emitRequest('in-flight');
      return { mutationCount: 1 };
    });
    harness.emitRequest('in-flight');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(responseEnvelope(harness.responseBodies[0]).response).toEqual({ mutationCount: 1 });
    expect(harness.httpRequests).toHaveLength(1);
  });

  test('cancels queued work before execution without dropping its terminal response', async () => {
    const harness = await createHarness();
    harness.deferSpawns();
    harness.emitRequest('queued');
    harness.emitCancel('queued');
    harness.flushSpawns();
    harness.emitRequest('queued');
    expect(harness.dispatchRequest).not.toHaveBeenCalled();
    expect(responseEnvelope(harness.responseBodies[0]).error).toContain('before execution');
  });

  test('does not start work whose deadline expired in the queue', async () => {
    const harness = await createHarness();
    harness.deferSpawns();
    harness.emitRequest('deadline');
    harness.advance(1);
    harness.flushSpawns();
    expect(harness.dispatchRequest).not.toHaveBeenCalled();
    expect(responseEnvelope(harness.responseBodies[0]).error).toContain('before execution');
  });

  test('stops queued work but retains eventual results from executing work across stop/start', async () => {
    const harness = await createHarness();
    harness.dispatchRequest.mockImplementation(() => {
      harness.module.stop();
      return { mutationCount: 1 };
    });
    harness.emitRequest('stopped-running');
    expect(harness.responseBodies).toHaveLength(0);
    harness.restart();
    expect(responseEnvelope(harness.responseBodies[0]).response).toEqual({ mutationCount: 1 });
    harness.deferSpawns();
    harness.emitRequest('stopped-queued');
    harness.module.stop();
    harness.flushSpawns();
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('closes native resources before unregistering and resumes a failed shutdown', async () => {
    const harness = await createHarness({ onSend() {} });
    harness.emitRequest('shutdown-result');
    harness.module.suspendForShutdown();
    expect(harness.lifecycle).toEqual(['ready', 'close', 'disconnect']);
    harness.advance(1);
    expect(harness.responseBodies).toHaveLength(1);
    harness.module.resumeAfterShutdownFailure();
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('shutdown-result');
    expect(harness.lifecycle).toEqual(['ready', 'close', 'disconnect', 'ready']);
    expect(harness.responseBodies[1]).toBe(harness.responseBodies[0]);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });
});

describe('Studio WebSocket registration and framing', () => {
  test('preserves ready, heartbeat, status and distinct server/client fanout messages', async () => {
    const harness = await createHarness();
    harness.stream.MessageReceived.fire(JSON.stringify({ kind: 'heartbeat', timestamp: 123 }));
    harness.stream.MessageReceived.fire(JSON.stringify({ kind: 'status', knownPeer: true, mcpConnected: true }));
    harness.emitRequest('server-request', 'server');
    harness.emitRequest('client-request', 'client-1');
    expect(harness.onReady).toHaveBeenCalledWith(expect.objectContaining({ assignedRole: 'edit', instanceId: 'studio-instance' }));
    expect(harness.onHeartbeat).toHaveBeenCalledWith(123);
    expect(harness.onStatus).toHaveBeenCalledWith(expect.objectContaining({ knownPeer: true, mcpConnected: true }));
    expect(harness.dispatchRequest.mock.calls.map(([event]) => [event.requestId, event.peerId, event.target])).toEqual([
      ['server-request', 'peer:server', 'server'], ['client-request', 'peer:client-1', 'client-1'],
    ]);
  });

  test('rebootstraps only when cached transport credentials are rejected', async () => {
    const harness = await createHarness();
    harness.stream.Error.fire(401, 'unknown transport token');
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('after-server-restart');
    expect(harness.httpRequests.filter((request) => request.Url.endsWith('/ready'))).toHaveLength(2);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('rebootstraps an unknown peer and ignores messages from the old transport', async () => {
    const harness = await createHarness();
    const oldStream = harness.stream;
    oldStream.MessageReceived.fire(JSON.stringify({ kind: 'status', knownPeer: false, mcpConnected: false }));
    oldStream.MessageReceived.fire(JSON.stringify(requestEvent('stale')));
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('current');
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['current']);
    expect(harness.httpRequests).toHaveLength(2);
  });

  test('keeps the socket usable when metadata refresh hits HTTP quota', async () => {
    const harness = await createHarness();
    harness.module.refresh();
    expect(harness.onReady).toHaveBeenCalledTimes(2);
    harness.exhaustHttpQuota();
    harness.module.refresh();
    harness.emitRequest('metadata-quota');
    expect(harness.stream.Close).not.toHaveBeenCalled();
    expect(responseEnvelope(harness.responseBodies[0]).requestId).toBe('metadata-quota');
    harness.reconnect();
    expect(harness.httpRequests).toHaveLength(3);
  });

  test('accepts only a complete JSON envelope per message, not SSE or concatenated JSON', async () => {
    const harness = await createHarness();
    const request = JSON.stringify(requestEvent('invalid-frame'));
    harness.stream.MessageReceived.fire(`data: ${request}\n\n`);
    harness.stream.MessageReceived.fire(request + request);
    harness.stream.MessageReceived.fire('{"kind":"request"}');
    harness.stream.MessageReceived.fire('not-json');
    harness.emitRequest('valid-frame');
    expect(harness.dispatchRequest.mock.calls.map(([event]) => event.requestId)).toEqual(['valid-frame']);
  });

  test('rejects an oversized UTF8 request before execution and reconnects without HTTP', async () => {
    const harness = await createHarness();
    harness.stream.MessageReceived.fire('é'.repeat(MAX_FRAME_BYTES / 2 + 1));
    expect(harness.dispatchRequest).not.toHaveBeenCalled();
    expect(harness.onTransportUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      state: 'retrying', detail: expect.stringContaining(`bytes=${MAX_FRAME_BYTES + 2}`),
    }));
    harness.exhaustHttpQuota();
    harness.advance(0.5);
    harness.stream.Opened.fire(101, '');
    harness.emitRequest('after-size-failure');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
    expect(harness.httpRequests).toHaveLength(1);
  });

  test('reports a measured result frame error rather than uploading an oversized result', async () => {
    const harness = await createHarness();
    harness.dispatchRequest.mockReturnValue('x'.repeat(MAX_FRAME_BYTES));
    harness.emitRequest('oversized-result');
    const expectedBytes = MAX_FRAME_BYTES + Buffer.byteLength(JSON.stringify({ kind: 'response', requestId: 'oversized-result', response: '', executionOutcome: 'success' }));
    const response = responseEnvelope(harness.responseBodies[0]);
    expect(response.response).toBeUndefined();
    expect(response.error).toContain('stage=response_encode');
    expect(response.error).toContain(`bytes=${expectedBytes}`);
    expect(Buffer.byteLength(harness.responseBodies[0])).toBeLessThan(4096);
    expect(harness.httpRequests).toHaveLength(1);
  });

  test('admits an exact-limit response frame without applying an HTTP body limit', async () => {
    const harness = await createHarness();
    const overhead = Buffer.byteLength(JSON.stringify({ kind: 'response', requestId: 'at-limit', response: '', executionOutcome: 'success' }));
    harness.dispatchRequest.mockReturnValue('x'.repeat(MAX_FRAME_BYTES - overhead));
    harness.emitRequest('at-limit');
    expect(Buffer.byteLength(harness.responseBodies[0])).toBe(MAX_FRAME_BYTES);
    expect(responseEnvelope(harness.responseBodies[0]).error).toBeUndefined();
    harness.emitRequest('at-limit');
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });

  test('bounds queued request bytes before additional handlers can start', async () => {
    const harness = await createHarness();
    harness.deferSpawns();
    const padding = 'x'.repeat(33 * 1024 * 1024);
    harness.stream.MessageReceived.fire(JSON.stringify({ ...requestEvent('queued-large'), data: { padding } }));
    harness.stream.MessageReceived.fire(JSON.stringify({ ...requestEvent('rejected-large'), data: { padding } }));
    expect(responseEnvelope(harness.responseBodies[0]).error).toContain('stage=request_admission');
    harness.flushSpawns();
    expect(harness.dispatchRequest.mock.calls.map(([request]) => request.requestId)).toEqual(['queued-large']);
  });

  test('bounds retained bytes while preserving the earlier unacknowledged result', async () => {
    const harness = await createHarness({ onSend() {} });
    harness.dispatchRequest.mockReturnValue('x'.repeat(33 * 1024 * 1024));
    harness.emitRequest('first-large');
    harness.emitRequest('second-large');
    expect(responseEnvelope(harness.responseBodies[1]).error).toContain('stage=response_retention');
    harness.reconnect();
    expect(harness.responseBodies[2]).toBe(harness.responseBodies[0]);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(2);
  });

  test('converts serialization failure into an acknowledged transport error', async () => {
    const harness = await createHarness();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    harness.dispatchRequest.mockReturnValue(circular);
    harness.emitRequest('unserializable');
    harness.emitRequest('unserializable');
    expect(responseEnvelope(harness.responseBodies[0]).error).toContain('stage=response_encode');
    expect(responseEnvelope(harness.responseBodies[0]).executionOutcome).toBe('success');
    expect(harness.responseBodies).toHaveLength(1);
    expect(harness.dispatchRequest).toHaveBeenCalledTimes(1);
  });
});

import request from 'supertest';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { rgbaToPng } from '../png-encoder.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

class JobTestBridge extends BridgeService {
  protected override notifyPeerRegistered(): void {
    // Simulated topology must not mutate the local managed-Studio registry.
  }
}

const MODEL = { success: true, modelPath: 'game.ServerStorage.__MCPGeneratedModels.Crate' };

function parse(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? '');
}

function registerEdit(bridge: BridgeService, peerId: string, instanceId: string): void {
  expect(bridge.registerPeer({
    peerId, transportPeerId: peerId, instanceId, role: 'edit', placeId: 0, placeName: instanceId,
  }).ok).toBe(true);
}

function referencePngBase64(): string {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  return rgbaToPng(rgba, 2, 2).toString('base64');
}

describe('generate_model jobs', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  let uploads: jest.Mock<Promise<number>, [Buffer, string | undefined]>;

  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new JobTestBridge();
    tools = new RobloxStudioTools(bridge);
    let nextAssetId = 1000;
    uploads = jest.fn<Promise<number>, [Buffer, string | undefined]>(async () => ++nextAssetId);
    Object.assign(tools, { uploadGenerateModelReferenceImage: uploads });
    registerEdit(bridge, 'edit', 'instance:jobs');
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
  });

  test('async mode returns a job ID before generation finishes and a status wait retrieves the result', async () => {
    const started = parse(await tools.generateModel({ prompt: 'crate', async: true }, 'instance:jobs'));
    expect(started).toMatchObject({ targetPeerId: 'edit', state: 'pending', outcome: 'pending', stage: 'queued' });
    const jobId = String(started.requestId);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toMatchObject({
      requestId: jobId, endpoint: '/api/generate-model', data: { prompt: 'crate', schema: 'Body1' },
    });

    expect(parse(await tools.getRequestStatus(jobId))).toMatchObject({ state: 'pending', stage: 'dispatched' });
    const waited = tools.getRequestStatus(jobId, 60_000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(bridge.settleTransportResponse('edit', jobId, MODEL)).toBe('accepted');
    expect(parse(await waited)).toMatchObject({ requestId: jobId, state: 'settled', outcome: 'success', response: MODEL });
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
  });

  test('a caller that disconnects before the response retries with its operation ID without a second model', async () => {
    const args = { prompt: 'crate', image_base64: referencePngBase64(), image_mime_type: 'image/png', operation_id: 'crate-job' };
    // The first caller goes away; its waiter is never observed.
    void tools.generateModel({ ...args, timeout_ms: 1000 }, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toMatchObject({
      requestId: 'crate-job', data: { image: { kind: 'asset', asset_id: 1001 } },
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(bridge.settleTransportResponse('edit', 'crate-job', MODEL)).toBe('accepted');

    // A retry re-uploads the same image under a new asset ID but still joins the job.
    expect(parse(await tools.generateModel(args, 'instance:jobs'))).toEqual(MODEL);
    expect(parse(await tools.generateModel({ ...args, async: true }, 'instance:jobs'))).toMatchObject({
      requestId: 'crate-job', state: 'settled', outcome: 'success', response: MODEL,
    });
    expect(uploads).toHaveBeenCalledTimes(3);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();

    const changed = parse(await tools.generateModel({ ...args, prompt: 'barrel' }, 'instance:jobs'));
    expect(changed).toMatchObject({ success: false, error: expect.stringContaining('different operation') });
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
  });

  test('a late result after the bridge deadline is retrievable without generating again', async () => {
    const started = parse(await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'late-job', timeout_ms: 1000 }, 'instance:jobs'));
    expect(started).toMatchObject({ requestId: 'late-job', state: 'pending' });
    bridge.claimNextRequestForTransport('edit', 'socket');
    await jest.advanceTimersByTimeAsync(1000);
    expect(parse(await tools.getRequestStatus('late-job'))).toMatchObject({ state: 'timed_out', outcome: 'unknown' });

    // Retrying while generation is still running reports the same job.
    expect(parse(await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'late-job' }, 'instance:jobs')))
      .toMatchObject({ requestId: 'late-job', state: 'timed_out' });
    const waited = tools.getRequestStatus('late-job', 120_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(bridge.settleTransportResponse('edit', 'late-job', MODEL)).toBe('accepted');
    expect(parse(await waited)).toMatchObject({ state: 'settled', outcome: 'success', response: MODEL });
    expect(parse(await tools.generateModel({ prompt: 'crate', operation_id: 'late-job' }, 'instance:jobs'))).toEqual(MODEL);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
  });

  test('ending a status wait never cancels the job', async () => {
    await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'kept-job' }, 'instance:jobs');
    bridge.claimNextRequestForTransport('edit', 'socket');
    const controller = new AbortController();
    const waited = tools.getRequestStatus('kept-job', 60_000, controller.signal);
    controller.abort();
    expect(parse(await waited)).toMatchObject({ state: 'pending', stage: 'dispatched' });
    const timedWait = tools.getRequestStatus('kept-job', 5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(parse(await timedWait)).toMatchObject({ state: 'pending' });
    expect(bridge.claimNextCancellationForTransport('edit', 'socket')).toBeNull();
    expect(bridge.settleTransportResponse('edit', 'kept-job', MODEL)).toBe('accepted');
  });

  test('a status wait returns at once for a job that ended before Studio picked it up', async () => {
    await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'never-sent', timeout_ms: 1000 }, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(1000);

    let settled = false;
    const waited = tools.getRequestStatus('never-sent', 300_000).finally(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(parse(await waited)).toMatchObject({ state: 'timed_out', stage: 'queued', outcome: 'not_executed' });
  });

  test('a status wait ends when a queued job reaches its deadline without being picked up', async () => {
    await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'stuck-in-queue', timeout_ms: 1000 }, 'instance:jobs');

    let settled = false;
    const waited = tools.getRequestStatus('stuck-in-queue', 300_000).finally(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    expect(parse(await waited)).toMatchObject({ state: 'timed_out', stage: 'queued', outcome: 'not_executed' });
  });

  test('a status wait keeps waiting through the deadline of a job Studio already picked up', async () => {
    await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'running', timeout_ms: 1000 }, 'instance:jobs');
    bridge.claimNextRequestForTransport('edit', 'socket');

    let settled = false;
    const waited = tools.getRequestStatus('running', 60_000).finally(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    expect(bridge.settleTransportResponse('edit', 'running', MODEL)).toBe('accepted');
    expect(parse(await waited)).toMatchObject({ state: 'settled', response: MODEL });
  });

  test('a job stays tied to the Studio instance that started it', async () => {
    registerEdit(bridge, 'other-edit', 'instance:other');
    await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'bound-job' }, 'instance:jobs');
    const retry = parse(await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'bound-job' }, 'instance:other'));
    expect(retry).toMatchObject({ success: false, error: expect.stringContaining('different operation') });
    expect(parse(await tools.getRequestStatus('bound-job'))).toMatchObject({ targetPeerId: 'edit' });
    expect(bridge.claimNextRequestForTransport('other-edit', 'socket')).toBeNull();
  });

  test('rejects invalid job arguments before uploading or dispatching', async () => {
    const base = { prompt: 'crate', image_base64: referencePngBase64(), image_mime_type: 'image/png' };
    expect(parse(await tools.generateModel({ ...base, operation_id: ' ' }, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('operation_id') });
    expect(parse(await tools.generateModel({ ...base, async: 'yes' }, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('async') });
    await expect(tools.getRequestStatus('job', 300_001)).rejects.toThrow('wait_ms');
    expect(uploads).not.toHaveBeenCalled();
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
  });
});

describe('generate_model jobs through a proxy', () => {
  // An older primary predates the job features: its /topology lists none, and
  // its /proxy and /request-status ignore submit, identity, and waitMs.
  async function withProxy(
    options: { olderPrimary?: boolean },
    run: (context: { primary: BridgeService; proxyTools: RobloxStudioTools; proxyBodies: Record<string, unknown>[] }) => Promise<void>,
  ): Promise<void> {
    const primary = new JobTestBridge();
    registerEdit(primary, 'edit', 'instance:jobs');
    const app = createHttpServer(new RobloxStudioTools(primary), primary);
    const proxyBodies: Record<string, unknown>[] = [];
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      if (init?.method === 'POST') proxyBodies.push(JSON.parse(String(init.body)));
      const response = init?.method === 'POST'
        ? await request(app).post(path).set('Content-Type', 'application/json').send(String(init.body))
        : await request(app).get(path);
      let text = response.text;
      if (options.olderPrimary && url.pathname === '/topology') {
        const topology = JSON.parse(text);
        delete topology.proxyFeatures;
        text = JSON.stringify(topology);
      }
      return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
    });
    const proxy = new ProxyBridgeService('http://primary');
    try {
      await proxy.waitForInitialRefresh();
      const proxyTools = new RobloxStudioTools(proxy);
      Object.assign(proxyTools, { uploadGenerateModelReferenceImage: async () => 2000 + proxyBodies.length });
      await run({ primary, proxyTools, proxyBodies });
    } finally {
      proxy.stop();
      fetchMock.mockRestore();
      primary.clearAllPendingRequests();
      await app.cleanup();
    }
  }

  // Answers each request the primary admits, as Studio would.
  function answerAdmittedRequests(primary: BridgeService): void {
    const send = primary.sendRequest.bind(primary);
    jest.spyOn(primary, 'sendRequest').mockImplementation((...args) => {
      const response = send(...args);
      const claimed = primary.claimNextRequestForTransport('edit', 'socket');
      if (claimed) primary.settleTransportResponse('edit', claimed.requestId, MODEL);
      return response;
    });
  }

  test('the primary admits the job at once and answers a proxied wait with its result', async () => {
    await withProxy({}, async ({ primary, proxyTools }) => {
      const started = parse(await proxyTools.generateModel({ prompt: 'crate', async: true, operation_id: 'proxy-job' }, 'instance:jobs'));
      expect(started).toMatchObject({ requestId: 'proxy-job', targetPeerId: 'edit', state: 'pending' });
      expect(primary.claimNextRequestForTransport('edit', 'socket')).toMatchObject({ requestId: 'proxy-job' });

      // Settle only once the primary is holding the proxied wait open.
      const wait = primary.waitForRequestStatus.bind(primary);
      jest.spyOn(primary, 'waitForRequestStatus').mockImplementation((requestId, waitMs, signal) => {
        const status = wait(requestId, waitMs, signal);
        primary.settleTransportResponse('edit', requestId, MODEL);
        return status;
      });
      expect(parse(await proxyTools.getRequestStatus('proxy-job', 10_000))).toMatchObject({
        requestId: 'proxy-job', state: 'settled', response: MODEL,
      });
      expect(parse(await proxyTools.generateModel({ prompt: 'crate', operation_id: 'proxy-job' }, 'instance:jobs'))).toEqual(MODEL);
      expect(primary.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    });
  });

  test('an older primary refuses async jobs before anything reaches it', async () => {
    await withProxy({ olderPrimary: true }, async ({ primary, proxyTools, proxyBodies }) => {
      const result = parse(await proxyTools.generateModel({ prompt: 'crate', async: true, operation_id: 'old-job' }, 'instance:jobs'));
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('cannot start a job that outlives the call') });
      expect(proxyBodies).toEqual([]);
      expect(primary.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    });
  });

  test('an older primary refuses status waits and still answers plain status reads', async () => {
    await withProxy({ olderPrimary: true }, async ({ primary, proxyTools }) => {
      answerAdmittedRequests(primary);
      expect(parse(await proxyTools.generateModel({ prompt: 'crate', operation_id: 'old-sync' }, 'instance:jobs'))).toEqual(MODEL);

      await expect(proxyTools.getRequestStatus('old-sync', 10_000)).rejects.toThrow('cannot wait for an operation');
      expect(parse(await proxyTools.getRequestStatus('old-sync'))).toMatchObject({ requestId: 'old-sync', state: 'settled' });
    });
  });

  test('an older primary still generates from an image, but refuses image retries keyed by operation ID', async () => {
    await withProxy({ olderPrimary: true }, async ({ primary, proxyTools, proxyBodies }) => {
      answerAdmittedRequests(primary);
      const image = { image_base64: referencePngBase64(), image_mime_type: 'image/png' };

      expect(parse(await proxyTools.generateModel({ prompt: 'crate', ...image }, 'instance:jobs'))).toEqual(MODEL);
      expect(proxyBodies).toHaveLength(1);
      expect(proxyBodies[0]).not.toHaveProperty('identity');

      const keyed = parse(await proxyTools.generateModel({ prompt: 'crate', ...image, operation_id: 'old-image' }, 'instance:jobs'));
      expect(keyed).toMatchObject({ success: false, error: expect.stringContaining('cannot match a retry of operation old-image') });
      expect(proxyBodies).toHaveLength(1);
    });
  });

  test('a current primary matches an image retry to its first attempt by content', async () => {
    await withProxy({}, async ({ primary, proxyTools, proxyBodies }) => {
      answerAdmittedRequests(primary);
      const args = { prompt: 'crate', image_base64: referencePngBase64(), image_mime_type: 'image/png', operation_id: 'new-image' };

      expect(parse(await proxyTools.generateModel(args, 'instance:jobs'))).toEqual(MODEL);
      expect(parse(await proxyTools.generateModel(args, 'instance:jobs'))).toEqual(MODEL);
      expect(proxyBodies).toHaveLength(2);
      expect(proxyBodies[1]).toHaveProperty('identity');
      expect(primary.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    });
  });
});

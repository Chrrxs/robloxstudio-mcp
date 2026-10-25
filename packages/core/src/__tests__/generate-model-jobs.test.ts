import request from 'supertest';
import { BridgeService, RequestFailure, RoutingFailure } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { OpenCloudClient } from '../opencloud-client.js';
import { rgbaToPng } from '../png-encoder.js';
import { ProxyBridgeService } from '../proxy-bridge-service.js';
import { RobloxCookieClient } from '../roblox-cookie-client.js';
import { RobloxStudioTools } from '../tools/index.js';
import type { ReferenceUploadCheckpoint, ReferenceUploadProgress } from '../tools/reference-uploads.js';

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

function referencePngBase64(firstPixel = [255, 0, 0, 255]): string {
  const rgba = Buffer.from([...firstPixel, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
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

    // A retry reuses the image uploaded for the job and joins it.
    expect(parse(await tools.generateModel(args, 'instance:jobs'))).toEqual(MODEL);
    expect(parse(await tools.generateModel({ ...args, async: true }, 'instance:jobs'))).toMatchObject({
      requestId: 'crate-job', state: 'settled', outcome: 'success', response: MODEL,
      phase: 'completed', preparation: { stage: 'dispatched', imageAssetId: 1001 },
    });
    expect(uploads).toHaveBeenCalledTimes(1);
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

describe('generate_model reference image uploads', () => {
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  let upload: jest.Mock<Promise<number>, [Buffer, string | undefined, ReferenceUploadProgress]>;
  let resume: jest.Mock<Promise<number>, [ReferenceUploadCheckpoint, string | undefined, ReferenceUploadProgress]>;
  const image = { image_base64: referencePngBase64(), image_mime_type: 'image/png' };

  beforeEach(() => {
    jest.useFakeTimers();
    bridge = new JobTestBridge();
    tools = new RobloxStudioTools(bridge);
    upload = jest.fn<Promise<number>, [Buffer, string | undefined, ReferenceUploadProgress]>(async () => 1001);
    resume = jest.fn<Promise<number>, [ReferenceUploadCheckpoint, string | undefined, ReferenceUploadProgress]>(async () => 1002);
    Object.assign(tools, { uploadGenerateModelReferenceImage: upload, resumeGenerateModelReferenceImage: resume });
    registerEdit(bridge, 'edit', 'instance:jobs');
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function claimAndSettle(requestId: string, imageAssetId: number): void {
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toMatchObject({
      requestId, data: { image: { kind: 'asset', asset_id: imageAssetId } },
    });
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    expect(bridge.settleTransportResponse('edit', requestId, MODEL)).toBe('accepted');
  }

  test('concurrent retries share one upload and one generation', async () => {
    const uploaded = Promise.withResolvers<number>();
    upload.mockReturnValueOnce(uploaded.promise);
    const args = { prompt: 'crate', ...image, operation_id: 'shared' };
    const first = tools.generateModel(args, 'instance:jobs');
    const second = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(parse(await tools.getRequestStatus('shared'))).toMatchObject({
      requestId: 'shared', phase: 'uploading', stage: 'preparing', state: 'pending',
      executionOutcome: 'not_executed', preparation: { stage: 'uploading', targetPeerId: 'edit' },
    });
    uploaded.resolve(1001);
    await jest.advanceTimersByTimeAsync(0);
    claimAndSettle('shared', 1001);
    expect(parse(await first)).toEqual(MODEL);
    expect(parse(await second)).toEqual(MODEL);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('a request that cannot be routed uploads nothing', async () => {
    await expect(tools.generateModel({ prompt: 'crate', ...image, operation_id: 'lost' }, 'instance:missing'))
      .rejects.toBeInstanceOf(RoutingFailure);
    bridge.unregisterPeer('edit');
    await expect(tools.generateModel({ prompt: 'crate', ...image }, undefined)).rejects.toBeInstanceOf(RoutingFailure);
    expect(upload).not.toHaveBeenCalled();
  });

  test('an operation ID already used for other arguments uploads nothing', async () => {
    await tools.generateModel({ prompt: 'crate', async: true, operation_id: 'taken' }, 'instance:jobs');
    expect(parse(await tools.generateModel({ prompt: 'crate', ...image, operation_id: 'taken' }, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('different operation') });
    expect(upload).not.toHaveBeenCalled();

    await tools.generateModel({ prompt: 'crate', ...image, async: true, operation_id: 'pictured' }, 'instance:jobs');
    const otherImage = { ...image, image_base64: referencePngBase64([0, 0, 0, 255]) };
    expect(parse(await tools.generateModel({ prompt: 'crate', ...otherImage, operation_id: 'pictured' }, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('nothing was uploaded or sent') });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('an upload Roblox refused is uploaded again on retry', async () => {
    upload.mockRejectedValueOnce(new Error('Creator identity required for image upload.'));
    const args = { prompt: 'crate', ...image, operation_id: 'refused' };
    expect(parse(await tools.generateModel(args, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('Reference image upload failed') });
    expect(parse(await tools.getRequestStatus('refused'))).toMatchObject({
      phase: 'failed', state: 'settled', outcome: 'error', executionOutcome: 'not_executed',
      preparation: { stage: 'upload_failed', error: 'Creator identity required for image upload.' },
    });
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();

    const retry = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    claimAndSettle('refused', 1001);
    expect(parse(await retry)).toEqual(MODEL);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  test('an upload with an unknown outcome is never repeated', async () => {
    upload.mockImplementationOnce(async (_png, _instance, progress) => {
      progress.sending();
      throw new TypeError('fetch failed: connection reset');
    });
    const args = { prompt: 'crate', ...image, operation_id: 'unknown-upload' };
    expect(parse(await tools.generateModel(args, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('unknown outcome') });
    expect(parse(await tools.generateModel(args, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('image_asset_id') });
    expect(parse(await tools.getRequestStatus('unknown-upload'))).toMatchObject({
      phase: 'failed', executionOutcome: 'not_executed', preparation: { stage: 'upload_unknown' },
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
  });

  test('an accepted upload resumes its remote operation instead of uploading again', async () => {
    const remoteOperation = { provider: 'open_cloud', id: 'operations/op-9' } as const;
    upload.mockImplementationOnce(async (_png, _instance, progress) => {
      progress.sending();
      progress.accepted(remoteOperation);
      throw new Error('Asset upload timed out after 60s. Operation ID: op-9');
    });
    const args = { prompt: 'crate', ...image, operation_id: 'accepted-upload' };
    expect(parse(await tools.generateModel(args, 'instance:jobs')))
      .toMatchObject({ success: false, error: expect.stringContaining('unknown outcome') });
    expect(parse(await tools.getRequestStatus('accepted-upload'))).toMatchObject({
      preparation: { stage: 'upload_unknown', remoteOperation },
    });

    const retry = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledWith({ remoteOperation, createdAssetId: undefined }, 'instance:jobs', expect.anything());
    claimAndSettle('accepted-upload', 1002);
    expect(parse(await retry)).toEqual(MODEL);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('async mode returns while the image uploads and reports each phase', async () => {
    const uploaded = Promise.withResolvers<number>();
    upload.mockReturnValueOnce(uploaded.promise);
    const started = parse(await tools.generateModel({ prompt: 'crate', ...image, async: true, operation_id: 'phased' }, 'instance:jobs'));
    expect(started).toMatchObject({ requestId: 'phased', phase: 'uploading', stage: 'preparing', state: 'pending' });

    const waited = tools.getRequestStatus('phased', 60_000);
    uploaded.resolve(1001);
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await tools.getRequestStatus('phased'))).toMatchObject({
      phase: 'generating', stage: 'queued', state: 'pending', preparation: { stage: 'dispatched', imageAssetId: 1001 },
    });
    claimAndSettle('phased', 1001);
    expect(parse(await waited)).toMatchObject({
      phase: 'completed', state: 'settled', outcome: 'success', response: MODEL, preparation: { stage: 'dispatched' },
    });
  });

  test('an async job whose upload fails reports the failure', async () => {
    upload.mockRejectedValueOnce(new Error('ROBLOSECURITY cookie is not set.'));
    const started = parse(await tools.generateModel({ prompt: 'crate', ...image, async: true }, 'instance:jobs'));
    const jobId = String(started.requestId);
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await tools.getRequestStatus(jobId))).toMatchObject({
      requestId: jobId, phase: 'failed', outcome: 'error', preparation: { stage: 'upload_failed' },
    });
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toBeNull();
  });

  test('a generation that could not be sent after its upload reuses the image on retry', async () => {
    const uploaded = Promise.withResolvers<number>();
    upload.mockReturnValueOnce(uploaded.promise);
    const args = { prompt: 'crate', ...image, operation_id: 'stranded' };
    const first = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    bridge.unregisterPeer('edit');
    uploaded.resolve(1001);
    await expect(first).rejects.toBeInstanceOf(RoutingFailure);
    expect(parse(await tools.getRequestStatus('stranded'))).toMatchObject({
      phase: 'failed', state: 'settled', executionOutcome: 'not_executed', preparation: { stage: 'uploaded', imageAssetId: 1001 },
    });

    registerEdit(bridge, 'edit', 'instance:jobs');
    const retry = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    claimAndSettle('stranded', 1001);
    expect(parse(await retry)).toEqual(MODEL);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('a dispatch whose outcome is unknown is not reported as never run', async () => {
    const lost = new RequestFailure('Proxy request timeout: lost-answer; dispatched to primary; unknown', 'proxy_request_timeout', {
      requestId: 'lost-answer', targetPeerId: 'edit', stage: 'dispatched', outcome: 'unknown', executionOutcome: 'unknown',
    });
    const submit = jest.spyOn(bridge, 'submitRequest').mockRejectedValueOnce(lost);
    await tools.generateModel({ prompt: 'crate', ...image, async: true, operation_id: 'lost-answer' }, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    expect(submit).toHaveBeenCalledTimes(1);
    const status = parse(await tools.getRequestStatus('lost-answer'));
    expect(status).toMatchObject({ state: 'unknown', preparation: { stage: 'dispatched' } });
    expect(status).not.toHaveProperty('executionOutcome', 'not_executed');
  });

  test('a refused dispatch keeps the uploaded image for the retry', async () => {
    const refused = new RequestFailure('pending capacity exceeded; queued; not_executed', 'request_capacity_exceeded', {
      requestId: 'refused-dispatch', targetPeerId: 'edit', stage: 'queued', outcome: 'not_executed', executionOutcome: 'not_executed',
    });
    jest.spyOn(bridge, 'submitRequest').mockRejectedValueOnce(refused);
    const args = { prompt: 'crate', ...image, async: true, operation_id: 'refused-dispatch' };
    await tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await tools.getRequestStatus('refused-dispatch'))).toMatchObject({
      phase: 'failed', executionOutcome: 'not_executed',
      preparation: { stage: 'uploaded', imageAssetId: 1001, error: expect.stringContaining('capacity') },
    });

    expect(parse(await tools.generateModel(args, 'instance:jobs'))).toMatchObject({
      requestId: 'refused-dispatch', phase: 'generating', preparation: { stage: 'dispatched' },
    });
    claimAndSettle('refused-dispatch', 1001);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('a job that ends unclaimed reports a failed phase', async () => {
    await tools.generateModel({ prompt: 'crate', ...image, async: true, operation_id: 'unclaimed', timeout_ms: 1000 }, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(1000);
    expect(parse(await tools.getRequestStatus('unclaimed'))).toMatchObject({
      state: 'timed_out', outcome: 'not_executed', phase: 'failed', preparation: { stage: 'dispatched' },
    });
  });

  test('another session\'s operation on this primary is rejoined without uploading', async () => {
    const otherSession = new RobloxStudioTools(bridge);
    Object.assign(otherSession, { uploadGenerateModelReferenceImage: upload });
    const args = { prompt: 'crate', ...image, operation_id: 'cross-session' };
    const first = otherSession.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    const joined = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    claimAndSettle('cross-session', 1001);
    expect(parse(await first)).toEqual(MODEL);
    expect(parse(await joined)).toEqual(MODEL);
    expect(upload).toHaveBeenCalledTimes(1);
    await otherSession.dispose();
  });
});

describe('generate_model reference uploads through Roblox clients', () => {
  const CREATOR = process.env.ROBLOX_CREATOR_USER_ID;
  let bridge: BridgeService;
  let tools: RobloxStudioTools;
  let posts: number;
  const args = { prompt: 'crate', image_base64: referencePngBase64(), image_mime_type: 'image/png', operation_id: 'open-cloud' };

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.ROBLOX_CREATOR_USER_ID = '42';
    bridge = new JobTestBridge();
    tools = new RobloxStudioTools(bridge);
    Object.assign(tools, {
      openCloudClient: new OpenCloudClient({ apiKey: 'test-key' }),
      cookieClient: new RobloxCookieClient(''),
    });
    registerEdit(bridge, 'edit', 'instance:jobs');
    posts = 0;
  });

  afterEach(() => {
    if (CREATOR === undefined) delete process.env.ROBLOX_CREATOR_USER_ID;
    else process.env.ROBLOX_CREATOR_USER_ID = CREATOR;
    bridge.clearAllPendingRequests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // Serves Open Cloud: create answers come from createAnswers in order, the
  // operation stays unfinished until finished is set, and Decal 987 uses image 555.
  function serveOpenCloud(createAnswers: Array<() => Response>, operation: { finished: boolean }) {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname === '/assets/v1/assets') {
        const answer = createAnswers[Math.min(posts, createAnswers.length - 1)];
        posts++;
        return answer();
      }
      if (url.pathname === '/assets/v1/operations/op-1') {
        return Response.json(operation.finished
          ? { path: 'operations/op-1', done: true, response: { assetId: '987' } }
          : { path: 'operations/op-1', done: false });
      }
      if (url.pathname === '/toolbox-service/v2/assets/987') return Response.json({ asset: { textureId: 555 } });
      throw new Error(`unexpected request ${url.pathname}`);
    });
  }

  async function generate(): Promise<Record<string, unknown>> {
    const pending = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(70_000);
    return parse(await pending);
  }

  test('a refused create request is uploaded again', async () => {
    serveOpenCloud([
      () => Response.json({ message: 'bad image' }, { status: 400 }),
      () => Response.json({ path: 'operations/op-1', done: true, response: { assetId: '987' } }),
    ], { finished: true });
    expect(await generate()).toMatchObject({ success: false, error: expect.stringContaining('Reference image upload failed') });
    const retry = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toMatchObject({ data: { image: { asset_id: 555 } } });
    bridge.settleTransportResponse('edit', 'open-cloud', MODEL);
    expect(parse(await retry)).toEqual(MODEL);
    expect(posts).toBe(2);
  });

  test('a create request without an answer is not sent again', async () => {
    serveOpenCloud([() => { throw new TypeError('fetch failed'); }], { finished: true });
    expect(await generate()).toMatchObject({ success: false, error: expect.stringContaining('unknown outcome') });
    expect(await generate()).toMatchObject({ success: false, error: expect.stringContaining('not repeated') });
    expect(posts).toBe(1);
  });

  test('an operation that outlived its poll is resumed by the retry', async () => {
    const operation = { finished: false };
    serveOpenCloud([() => Response.json({ path: 'operations/op-1', done: false })], operation);
    expect(await generate()).toMatchObject({ success: false, error: expect.stringContaining('Operation ID: op-1') });
    expect(parse(await tools.getRequestStatus('open-cloud'))).toMatchObject({
      preparation: { stage: 'upload_unknown', remoteOperation: { provider: 'open_cloud', id: 'operations/op-1' } },
    });

    operation.finished = true;
    const retry = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toMatchObject({ data: { image: { asset_id: 555 } } });
    bridge.settleTransportResponse('edit', 'open-cloud', MODEL);
    expect(parse(await retry)).toEqual(MODEL);
    expect(parse(await tools.getRequestStatus('open-cloud'))).toMatchObject({
      phase: 'completed', preparation: { stage: 'dispatched', imageAssetId: 555, uploadedAssetId: '987' },
    });
    expect(posts).toBe(1);
  });

  test('an operation that completed without an asset ID is never uploaded again', async () => {
    serveOpenCloud([() => Response.json({ path: 'operations/op-2', done: true, response: {} })], { finished: true });
    expect(await generate()).toMatchObject({ success: false, error: expect.stringContaining('unknown outcome') });
    expect(await generate()).toMatchObject({ success: false, error: expect.stringContaining('not repeated') });
    expect(parse(await tools.getRequestStatus('open-cloud'))).toMatchObject({ preparation: { stage: 'upload_unknown' } });
    expect(posts).toBe(1);
  });

  test('an operation Roblox reports as failed is uploaded again', async () => {
    serveOpenCloud([
      () => Response.json({ path: 'operations/op-3', done: true, error: { code: 3, message: 'moderated' } }),
      () => Response.json({ path: 'operations/op-1', done: true, response: { assetId: '987' } }),
    ], { finished: true });
    expect(await generate()).toMatchObject({ success: false, error: expect.stringContaining('moderated') });
    const retry = tools.generateModel(args, 'instance:jobs');
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.claimNextRequestForTransport('edit', 'socket')).toMatchObject({ data: { image: { asset_id: 555 } } });
    bridge.settleTransportResponse('edit', 'open-cloud', MODEL);
    expect(parse(await retry)).toEqual(MODEL);
    expect(posts).toBe(2);
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
      const uploads = jest.fn(async () => 2001);
      Object.assign(proxyTools, { uploadGenerateModelReferenceImage: uploads });
      const image = { image_base64: referencePngBase64(), image_mime_type: 'image/png' };
      for (const args of [{ prompt: 'crate' }, { prompt: 'crate', ...image }]) {
        const result = parse(await proxyTools.generateModel({ ...args, async: true, operation_id: 'old-job' }, 'instance:jobs'));
        expect(result).toMatchObject({ success: false, error: expect.stringContaining('cannot start a job that outlives the call') });
      }
      expect(uploads).not.toHaveBeenCalled();
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
      const uploads = jest.fn(async () => 2001);
      Object.assign(proxyTools, { uploadGenerateModelReferenceImage: uploads });
      const image = { image_base64: referencePngBase64(), image_mime_type: 'image/png' };

      expect(parse(await proxyTools.generateModel({ prompt: 'crate', ...image }, 'instance:jobs'))).toEqual(MODEL);
      expect(proxyBodies).toHaveLength(1);
      expect(proxyBodies[0]).not.toHaveProperty('identity');

      const keyed = parse(await proxyTools.generateModel({ prompt: 'crate', ...image, operation_id: 'old-image' }, 'instance:jobs'));
      expect(keyed).toMatchObject({ success: false, error: expect.stringContaining('cannot match a retry of operation old-image') });
      expect(proxyBodies).toHaveLength(1);
      expect(uploads).toHaveBeenCalledTimes(1);
    });
  });

  test('a current primary matches an image retry to its first attempt by content', async () => {
    await withProxy({}, async ({ primary, proxyTools, proxyBodies }) => {
      answerAdmittedRequests(primary);
      const uploads = jest.fn(async () => 2001);
      Object.assign(proxyTools, { uploadGenerateModelReferenceImage: uploads });
      const args = { prompt: 'crate', image_base64: referencePngBase64(), image_mime_type: 'image/png', operation_id: 'new-image' };

      expect(parse(await proxyTools.generateModel(args, 'instance:jobs'))).toEqual(MODEL);
      expect(parse(await proxyTools.generateModel(args, 'instance:jobs'))).toEqual(MODEL);
      expect(uploads).toHaveBeenCalledTimes(1);
      expect(proxyBodies).toHaveLength(2);
      expect(proxyBodies[1]).toHaveProperty('identity');
      expect(primary.claimNextRequestForTransport('edit', 'socket')).toBeNull();
    });
  });

  test('a proxy will not upload for an operation the primary already holds from another server', async () => {
    await withProxy({}, async ({ primary, proxyTools, proxyBodies }) => {
      const primaryTools = new RobloxStudioTools(primary);
      await primaryTools.generateModel({ prompt: 'crate', async: true, operation_id: 'foreign' }, 'instance:jobs');
      const uploads = jest.fn(async () => 2001);
      Object.assign(proxyTools, { uploadGenerateModelReferenceImage: uploads });

      const retry = parse(await proxyTools.generateModel(
        { prompt: 'crate', image_base64: referencePngBase64(), image_mime_type: 'image/png', operation_id: 'foreign' }, 'instance:jobs'));
      expect(retry).toMatchObject({ success: false, error: expect.stringContaining('did not prepare it') });
      expect(uploads).not.toHaveBeenCalled();
      expect(proxyBodies).toEqual([]);
      await primaryTools.dispose();
    });
  });
});

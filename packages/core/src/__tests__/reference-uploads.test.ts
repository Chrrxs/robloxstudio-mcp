import { REFERENCE_UPLOAD_RETENTION_MS, ReferenceUploadError, ReferenceUploads } from '../tools/reference-uploads.js';
import type { ReferenceUploadAttempt } from '../tools/reference-uploads.js';

function attempt(imageAssetId = 1001): ReferenceUploadAttempt {
  return {
    upload: jest.fn(async () => imageAssetId),
    resume: jest.fn(async () => imageAssetId + 1),
  };
}

describe('ReferenceUploads', () => {
  let now: number;
  let uploads: ReferenceUploads;

  beforeEach(() => {
    now = 1_000_000;
    uploads = new ReferenceUploads(() => now);
  });

  test('the first dispatch keeps the record when a concurrent caller reaches another Peer', async () => {
    await uploads.acquire('job', 'identity', 'peer-a', 'instance:a', attempt());
    uploads.dispatched('job', 'peer-a');
    uploads.dispatched('job', 'peer-b');
    uploads.notDispatched('job', 'peer-b', new Error('refused'));
    expect(uploads.view('job')).toMatchObject({ stage: 'dispatched', targetPeerId: 'peer-a' });
    expect(() => uploads.lookup('job', 'identity', 'peer-b', 'instance:a')).toThrow('different operation');
  });

  test('a refused dispatch can be retried on a reconnected Peer of the same Instance with the same image', async () => {
    const first = attempt();
    await uploads.acquire('job', 'identity', 'peer-a', 'instance:a', first);
    uploads.dispatched('job', 'peer-a');
    uploads.notDispatched('job', 'peer-a', new Error('pending capacity exceeded'));
    expect(uploads.view('job')).toMatchObject({ stage: 'uploaded', error: 'pending capacity exceeded' });

    await expect(uploads.acquire('job', 'identity', 'peer-c', 'instance:a', attempt(2002))).resolves.toBe(1001);
    uploads.dispatched('job', 'peer-c');
    expect(uploads.view('job')).toMatchObject({ stage: 'dispatched', targetPeerId: 'peer-c', targetInstanceId: 'instance:a' });
    expect(uploads.view('job')).not.toHaveProperty('error');
    expect(first.upload).toHaveBeenCalledTimes(1);
  });

  test('an operation stays pinned to the Instance it started on', async () => {
    const first = attempt();
    await uploads.acquire('job', 'identity', 'peer-a', 'instance:a', first);
    expect(uploads.pinnedInstance('job')).toBe('instance:a');
    expect(uploads.pinnedInstance('other')).toBeUndefined();

    // Not yet dispatched, but another Studio still never takes the operation over.
    const elsewhere = attempt(2002);
    expect(() => uploads.lookup('job', 'identity', 'peer-b', 'instance:b')).toThrow('different operation');
    let refused: unknown;
    try {
      void uploads.acquire('job', 'identity', 'peer-b', 'instance:b', elsewhere);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ReferenceUploadError);
    expect(refused).toMatchObject({ code: 'operation_id_collision' });
    expect(elsewhere.upload).not.toHaveBeenCalled();
    expect(uploads.view('job')).toMatchObject({ stage: 'uploaded', targetPeerId: 'peer-a', targetInstanceId: 'instance:a' });
  });

  test('a caller joining an upload in flight does not take its Peer over', async () => {
    const uploaded = Promise.withResolvers<number>();
    const slow: ReferenceUploadAttempt = { upload: () => uploaded.promise, resume: jest.fn() };
    const first = uploads.acquire('job', 'identity', 'peer-a', 'instance:a', slow);
    const joined = uploads.acquire('job', 'identity', 'peer-b', 'instance:a', attempt());
    expect(uploads.view('job')).toMatchObject({ stage: 'uploading', targetPeerId: 'peer-a' });
    uploaded.resolve(1001);
    await expect(Promise.all([first, joined])).resolves.toEqual([1001, 1001]);
  });

  test('records outlive the bridge retention of the generation, then expire', async () => {
    await uploads.acquire('job', 'identity', 'peer-a', 'instance:a', attempt());
    uploads.dispatched('job', 'peer-a');
    now += REFERENCE_UPLOAD_RETENTION_MS - 1;
    expect(uploads.view('job')).toBeDefined();
    now += 1;
    expect(uploads.view('job')).toBeUndefined();
  });
});

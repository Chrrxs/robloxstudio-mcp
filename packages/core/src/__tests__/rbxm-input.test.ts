import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTTP_BODY_LIMIT_BYTES } from '../http-body-limits.js';
import { readBoundedResponse, readRbxmInput, rbxmInputByteLimit } from '../rbxm-input.js';

afterEach(() => jest.restoreAllMocks());

test('encoded imports leave room in both HTTP proxy and Studio envelopes', () => {
  const parent = 'game.Workspace."quoted".é';
  const label = 'https://example.test/model.rbxm';
  const limit = rbxmInputByteLimit(parent, label);
  const metadata = Buffer.byteLength(JSON.stringify({ base64: '', parent_path: parent, source_label: label }));
  expect(4 * Math.ceil(limit / 3) + metadata + 16 * 1024).toBeLessThanOrEqual(HTTP_BODY_LIMIT_BYTES);
  expect(limit).toBeLessThan(50 * 1024 * 1024);
});

test('streaming admission cancels an oversized response without reading it all', async () => {
  let reads = 0;
  const cancel = jest.fn();
  const response = new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(8)); },
    cancel,
  }));
  await expect(readBoundedResponse(response, 10)).rejects.toThrow('10-byte limit');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(reads).toBeLessThanOrEqual(3);
});

test('declared oversize is cancelled without consuming the body', async () => {
  const cancel = jest.fn();
  const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '11' } });
  await expect(readBoundedResponse(response, 10)).rejects.toThrow('10-byte limit');
  expect(cancel).toHaveBeenCalled();
});

test('missing or dishonest Content-Length cannot bypass streamed admission', async () => {
  await expect(readBoundedResponse(new Response('12345678901', {
    headers: { 'content-length': '1' },
  }), 10)).rejects.toThrow('10-byte limit');
  expect(await readBoundedResponse(new Response('1234567890'), 10)).toEqual(Buffer.from('1234567890'));
});

test('local files are bounded before allocation; small files and base64 round-trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-rbxm-'));
  const filename = join(directory, 'source.rbxm');
  try {
    await writeFile(filename, 'rbxm bytes');
    expect((await readRbxmInput({ path: filename }, 'game.Workspace')).bytes).toEqual(Buffer.from('rbxm bytes'));
    expect((await readRbxmInput({ base64: 'cmJ4bSBieXRlcw==' }, 'game.Workspace')).bytes).toEqual(Buffer.from('rbxm bytes'));
    expect((await readRbxmInput({ base64: 'cmJ4bSBieXRlcw' }, 'game.Workspace')).bytes).toEqual(Buffer.from('rbxm bytes'));
    const file = await open(filename, 'r+');
    try { await file.truncate(rbxmInputByteLimit('game.Workspace', filename) + 1); } finally { await file.close(); }
    await expect(readRbxmInput({ path: filename }, 'game.Workspace')).rejects.toThrow('byte limit');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(['!!!!', 'a', 'YW=Jj', 'YR=='])('rejects malformed base64 %s', async (base64) => {
  await expect(readRbxmInput({ base64 }, 'game.Workspace')).rejects.toThrow('base64');
});

test('rejects an oversized base64 string before decoding', async () => {
  const base64 = 'A'.repeat(4 * Math.ceil(rbxmInputByteLimit('game.Workspace', 'base64(9999999999B)') / 3) + 4);
  await expect(readRbxmInput({ base64 }, 'game.Workspace')).rejects.toThrow('byte limit');
});

test('URL inputs carry cancellation through fetch and body consumption', async () => {
  const controller = new AbortController();
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const signal = options!.signal!;
    return new Response(new ReadableStream({
      start(stream) { signal.addEventListener('abort', () => stream.error(signal.reason), { once: true }); },
    }));
  });
  const outcome = readRbxmInput({ url: 'https://example.test/model' }, 'game.Workspace', controller.signal);
  const assertion = expect(outcome).rejects.toThrow('cancel import');
  controller.abort(new Error('cancel import'));
  await assertion;
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

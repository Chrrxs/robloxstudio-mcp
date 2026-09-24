import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HTTP_BODY_LIMIT_BYTES } from './http-body-limits.js';
import { MAX_STUDIO_FRAME_BYTES } from './studio-transport.js';

// Use the smaller proxy/Studio limit so the same import works in either mode.
// Reserve space for routing IDs and the bridge's request envelope. The bridge
// still performs its exact serialized-frame admission check before dispatch.
const ENVELOPE_RESERVE_BYTES = 16 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export function rbxmInputByteLimit(parentPath: string, sourceLabel: string): number {
  const metadataBytes = Buffer.byteLength(JSON.stringify({
    base64: '', parent_path: parentPath, source_label: sourceLabel,
  }));
  const encodedBytes = Math.min(HTTP_BODY_LIMIT_BYTES, MAX_STUDIO_FRAME_BYTES)
    - ENVELOPE_RESERVE_BYTES - metadataBytes;
  if (encodedBytes < 4) throw new Error('RBXM import metadata exceeds the transport byte budget.');
  return Math.floor(encodedBytes / 4) * 3;
}

function tooLarge(limit: number): Error {
  return new Error(`RBXM input exceeds the ${limit}-byte limit after allowing for base64 and transport overhead.`);
}

export async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge(limit);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge(limit);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    // Cancel on errors as well as success, including a lying Content-Length.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readRbxmInput(
  source: { path?: string; url?: string; base64?: string },
  parentPath: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; sourceLabel: string }> {
  const modes = ['path', 'url', 'base64'] as const;
  const provided = modes.filter((key) => source[key] !== undefined);
  if (provided.length !== 1 || typeof source[provided[0]] !== 'string') {
    throw new Error('source must contain exactly one string: path, url, or base64');
  }
  signal?.throwIfAborted();
  if (source.path !== undefined) {
    const sourceLabel = resolve(source.path);
    const limit = rbxmInputByteLimit(parentPath, sourceLabel);
    const file = await open(sourceLabel, 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile()) throw new Error('RBXM source must be a regular file.');
      if (stats.size > limit) throw tooLarge(limit);
      const chunks: Buffer[] = [];
      let size = 0;
      // Read through the opened descriptor; a growing file cannot escape the cap.
      for (;;) {
        signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
        const { bytesRead } = await file.read(chunk);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > limit) throw tooLarge(limit);
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return { bytes: Buffer.concat(chunks, size), sourceLabel };
    } finally {
      await file.close();
    }
  }
  if (source.url !== undefined) {
    const url = new URL(source.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`import_rbxm url must use http(s); got ${url.protocol}`);
    }
    const limit = rbxmInputByteLimit(parentPath, source.url);
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`RBXM download returned HTTP ${response.status}`);
    }
    return { bytes: await readBoundedResponse(response, limit), sourceLabel: source.url };
  }
  const encoded = source.base64!;
  const limit = rbxmInputByteLimit(parentPath, 'base64(9999999999B)');
  // Check encoded length before validation or allocation. Padding is optional,
  // but reject malformed input that Buffer.from would silently truncate.
  if (encoded.length > 4 * Math.ceil(limit / 3)) throw tooLarge(limit);
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    || (encoded.includes('=') && encoded.length % 4 !== 0)) {
    throw new Error('RBXM base64 must be valid base64.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > limit) throw tooLarge(limit);
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('RBXM base64 is not canonical.');
  }
  return { bytes, sourceLabel: `base64(${bytes.length}B)` };
}

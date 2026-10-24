import * as fs from 'fs';
import { open, stat } from 'fs/promises';
import * as path from 'path';

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/**
 * Reads a caller-supplied regular file. validateSize sees the reported size
 * before any allocation, and a sentinel byte detects growth while reading.
 */
export function readRegularFileWithinLimit(
  filePath: string,
  argumentName: string,
  validateSize: (byteLength: number) => void,
): Buffer {
  let descriptor: number;
  try {
    // Avoid blocking on a FIFO before fstat can reject non-regular inputs.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
    descriptor = fs.openSync(path.resolve(filePath), flags);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      throw new Error(`${argumentName} not found: ${filePath}`);
    }
    // Windows refuses to open a directory instead of letting fstat inspect it.
    if (code === 'EISDIR') {
      throw new Error(`${argumentName} must reference a regular file: ${filePath}`);
    }
    throw error;
  }

  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`${argumentName} must reference a regular file: ${filePath}`);
    }
    validateSize(stats.size);

    const data = Buffer.allocUnsafe(stats.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const bytesRead = fs.readSync(
        descriptor,
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stats.size) {
      validateSize(offset);
      throw new Error(`${argumentName} size changed while reading: ${filePath}`);
    }
    return data.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Async counterpart of readRegularFileWithinLimit. It opens non-blocking so a
 * FIFO or device cannot park a libuv worker in open(2), rejects non-regular
 * files from fstat on the opened descriptor, validates the size before
 * allocating, reads in chunks checking signal between them, and detects growth
 * with a sentinel byte. The descriptor is always closed.
 */
export async function readRegularFileWithinLimitAsync(
  filePath: string,
  argumentName: string,
  validateSize: (byteLength: number) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const resolved = path.resolve(filePath);
  const notRegular = () => new Error(`${argumentName} must reference a regular file: ${filePath}`);
  const notFound = () => new Error(`${argumentName} not found: ${filePath}`);

  // Cheap precheck; the fstat below stays authoritative against swaps.
  let precheck: fs.Stats | undefined;
  try {
    precheck = await stat(resolved);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw notFound();
    // Let open report any other condition (permissions, loops) itself.
  }
  if (precheck && !precheck.isFile()) throw notRegular();

  let handle: fs.promises.FileHandle;
  try {
    handle = await open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw notFound();
    // Windows refuses to open a directory instead of letting fstat inspect it.
    if (code === 'EISDIR') throw notRegular();
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw notRegular();
    validateSize(stats.size);

    const data = Buffer.allocUnsafe(stats.size + 1);
    let offset = 0;
    while (offset < data.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        data,
        offset,
        Math.min(READ_CHUNK_BYTES, data.length - offset),
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stats.size) {
      validateSize(offset);
      throw new Error(`${argumentName} size changed while reading: ${filePath}`);
    }
    return data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

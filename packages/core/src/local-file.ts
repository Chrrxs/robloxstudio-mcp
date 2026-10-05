import * as fs from 'fs';
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

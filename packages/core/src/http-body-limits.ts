// HTTP JSON envelopes have a smaller allowance than Studio WebSocket frames.
export const HTTP_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

export const EXECUTE_LUAU_DEFAULT_OUTPUT_BYTES = 64 * 1024;
export const EXECUTE_LUAU_MAX_OUTPUT_BYTES = HTTP_BODY_LIMIT_BYTES;

export interface ExecuteLuauOutputAccounting {
  truncated: boolean;
  totalBytes: number;
  returnedBytes: number;
  maxOutputBytes: number;
  outputTruncated?: boolean;
  outputTotalBytes?: number;
  outputReturnedBytes?: number;
}

export function resolveExecuteLuauOutputLimit(maxOutputBytes: unknown): number {
  if (maxOutputBytes === undefined) return EXECUTE_LUAU_DEFAULT_OUTPUT_BYTES;
  if (typeof maxOutputBytes !== 'number' || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('execute_luau max_output_bytes must be a positive integer');
  }
  if (maxOutputBytes > EXECUTE_LUAU_MAX_OUTPUT_BYTES) {
    throw new Error(`execute_luau max_output_bytes must be at most ${EXECUTE_LUAU_MAX_OUTPUT_BYTES} (HTTP body limit); got ${maxOutputBytes}`);
  }
  return maxOutputBytes;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

export function applyExecuteLuauOutputLimit(
  response: Record<string, unknown>,
  maxOutputBytes: number,
): Record<string, unknown> & ExecuteLuauOutputAccounting {
  const result: Record<string, unknown> = { ...response };
  const returnValue = typeof response.returnValue === 'string' ? response.returnValue : undefined;
  const totalBytes = returnValue === undefined ? 0 : Buffer.byteLength(returnValue, 'utf8');
  let returnedBytes = totalBytes;
  let truncated = false;
  if (returnValue !== undefined && totalBytes > maxOutputBytes) {
    const kept = truncateUtf8(returnValue, maxOutputBytes);
    result.returnValue = kept;
    returnedBytes = Buffer.byteLength(kept, 'utf8');
    truncated = true;
  }
  const accounting: ExecuteLuauOutputAccounting = { truncated, totalBytes, returnedBytes, maxOutputBytes };
  const output = Array.isArray(response.output) ? response.output.filter((line): line is string => typeof line === 'string') : undefined;
  if (output !== undefined && output.length > 0) {
    const outputTotalBytes = output.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0) + output.length - 1;
    if (outputTotalBytes > maxOutputBytes) {
      const kept: string[] = [];
      let used = 0;
      for (const line of output) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
        if (used + lineBytes > maxOutputBytes) break;
        kept.push(line);
        used += lineBytes;
      }
      result.output = kept;
      accounting.outputTruncated = true;
      accounting.outputTotalBytes = outputTotalBytes;
      accounting.outputReturnedBytes = used;
    }
  }
  return { ...result, ...accounting };
}

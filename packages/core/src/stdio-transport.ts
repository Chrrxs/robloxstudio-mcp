import { parseJSONRPCMessage } from '@modelcontextprotocol/server';
import type { JSONRPCErrorResponse, JSONRPCMessage, Transport } from '@modelcontextprotocol/server';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

// The Studio frame remains capped at 64 MiB. Stdio needs room for the MCP
// tools/call envelope around that frame, without inheriting the SDK's 10 MiB cap.
export const MAX_STDIO_LINE_BYTES = 80 * 1024 * 1024;
// Legacy MCP repeats structured data as escaped JSON text: a 64 MiB Studio
// frame can expand to roughly 192 MiB on stdout. Keep bounded envelope room.
export const MAX_STDIO_PENDING_OUTPUT_BYTES = 256 * 1024 * 1024;
const INITIAL_BUFFER_BYTES = 64 * 1024;

interface PendingSend {
  resolve: () => void;
  reject: (error: Error) => void;
}

// JSON-RPC requires null when the rejected line's request identity is unknown.
// The SDK message type excludes that protocol-level error form.
interface UncorrelatedStdioErrorResponse extends Omit<JSONRPCErrorResponse, 'id'> {
  id: null;
}

/** Byte-framed JSON-RPC transport; LF terminates a line and is not in its budget.
 * CR in CRLF counts toward the budget. Oversized lines are discarded through LF,
 * never reparsed as suffixes. Only complete, validated lines reach onmessage.
 */
export class BoundedStdioTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];

  private readonly limitBytes: number;
  private readonly outputLimitBytes: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private buffer?: Buffer;
  private lineBytes = 0;
  private started = false;
  private closed = false;
  private inputEnded = false;
  private outputBlocked = false;
  private pendingChunk?: Buffer;
  private pendingWrites = 0;
  private readonly pendingSends = new Set<PendingSend>();

  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
    options: { maxBufferSize?: number; maxPendingOutputBytes?: number } = {},
  ) {
    this.limitBytes = options.maxBufferSize ?? MAX_STDIO_LINE_BYTES;
    this.outputLimitBytes = options.maxPendingOutputBytes ?? MAX_STDIO_PENDING_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.limitBytes) || this.limitBytes < 1) {
      throw new RangeError('Stdio line limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.outputLimitBytes) || this.outputLimitBytes < 1) {
      throw new RangeError('Stdio output limit must be a positive safe integer');
    }
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('Stdio transport cannot be started again');
    if (this.input.readableEncoding) throw new Error('Stdio transport requires a byte stream, not a decoded string stream');
    this.started = true;
    this.input.on('data', this.onData);
    this.input.on('error', this.onStreamError);
    this.input.on('end', this.onEnd);
    this.input.on('close', this.onInputClose);
    this.output.on('error', this.onStreamError);
    this.output.on('close', this.onOutputClose);
    this.output.on('drain', this.onDrain);
  }

  private readonly onData = (chunk: Buffer): void => {
    let offset = 0;
    while (offset < chunk.length && !this.closed) {
      if (this.outputBlocked) {
        this.pendingChunk = chunk.subarray(offset);
        return;
      }
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const bytes = end - offset;
      const previousBytes = this.lineBytes;
      this.lineBytes += bytes;
      if (this.lineBytes > this.limitBytes) {
        // Drop the entire prefix immediately, but keep counting until LF/EOF.
        this.buffer = undefined;
      } else if (previousBytes === 0 && newline !== -1) {
        this.buffer = chunk.subarray(offset, end);
      } else if (bytes > 0) {
        if (!this.buffer || this.buffer.length < this.lineBytes) {
          const capacity = Math.min(this.limitBytes, Math.max(
            INITIAL_BUFFER_BYTES, this.lineBytes, (this.buffer?.length ?? 0) * 2,
          ));
          const grown = Buffer.allocUnsafe(capacity);
          this.buffer?.copy(grown, 0, 0, previousBytes);
          this.buffer = grown;
        }
        chunk.copy(this.buffer, previousBytes, offset, end);
      }
      offset = end + 1;
      if (newline !== -1) this.finishLine();
    }
  };

  private finishLine(): void {
    const bytes = this.lineBytes;
    const buffer = this.buffer;
    this.lineBytes = 0;
    this.buffer = undefined;
    if (bytes > this.limitBytes) {
      void this.rejectLine(-32600, 'stdio_request_too_large', bytes).catch(() => {});
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(this.decoder.decode(buffer?.subarray(0, bytes)));
    } catch {
      void this.rejectLine(-32700, 'stdio_parse_error', bytes).catch(() => {});
      return;
    }
    let message: JSONRPCMessage;
    try {
      message = parseJSONRPCMessage(value);
    } catch {
      void this.rejectLine(-32600, 'stdio_invalid_request', bytes).catch(() => {});
      return;
    }
    // A consumer callback failure is not a framing rejection: dispatch occurred.
    try {
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectLine(code: number, reason: string, bytes: number): Promise<void> {
    const message = `${reason}: received ${bytes} bytes; limit ${this.limitBytes} bytes; stdio_receive; not_executed`;
    this.onerror?.(new Error(message));
    return this.writeMessage({
      jsonrpc: '2.0', id: null,
      error: {
        code, message,
        data: {
          code: reason, bytes, limitBytes: this.limitBytes,
          stage: 'stdio_receive', transportStage: 'stdio_receive',
          outcome: 'not_executed', executionOutcome: 'not_executed',
        },
      },
    });
  }

  private readonly onEnd = (): void => {
    if (this.closed) return;
    this.inputEnded = true;
    if (this.pendingChunk) return;
    const bytes = this.lineBytes;
    this.lineBytes = 0;
    this.buffer = undefined;
    if (bytes > 0) {
      const oversized = bytes > this.limitBytes;
      void this.rejectLine(
        oversized ? -32600 : -32700,
        oversized ? 'stdio_request_too_large' : 'stdio_truncated_line', bytes,
      ).finally(() => this.close()).catch(() => {});
    } else {
      void this.close();
    }
  };

  private readonly onInputClose = (): void => {
    // 'end' owns graceful EOF, including draining its rejection response.
    if (!this.input.readableEnded) this.onEnd();
  };

  private readonly onOutputClose = (): void => { void this.close(); };

  private readonly onStreamError = (error: Error): void => {
    if (this.closed) return;
    this.onerror?.(error);
    void this.close();
  };

  private readonly onDrain = (): void => {
    this.outputBlocked = false;
    for (const send of this.pendingSends) send.resolve();
    this.pendingSends.clear();
    const chunk = this.pendingChunk;
    this.pendingChunk = undefined;
    if (chunk && !this.closed) this.onData(chunk);
    if (this.inputEnded && !this.pendingChunk && !this.closed) this.onEnd();
    if (!this.outputBlocked && !this.closed) this.input.resume();
  };

  send(message: JSONRPCMessage): Promise<void> {
    return this.writeMessage(message);
  }

  private writeMessage(message: JSONRPCMessage | UncorrelatedStdioErrorResponse): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Stdio transport is closed'));
    let json: string;
    try {
      json = JSON.stringify(message) + '\n';
    } catch (error) {
      return Promise.reject(error);
    }
    const bytes = Buffer.byteLength(json);
    // Writable releases buffered bytes before emitting drain, but invokes write
    // callbacks afterward. Its byte count stays correct during suffix replay.
    const queuedBytes = this.output.writableLength + bytes;
    if (queuedBytes > this.outputLimitBytes) {
      const error = new Error(`Stdio output backpressure capacity exceeded: ${queuedBytes} bytes; limit ${this.outputLimitBytes} bytes`);
      this.onStreamError(error);
      return Promise.reject(error);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const pending = { resolve, reject };
    this.pendingSends.add(pending);
    this.pendingWrites++;
    try {
      // Socket stdout can have decodeStrings:false, where string writableLength
      // counts UTF-16 units. Buffers keep queued-byte admission byte-accurate.
      const writable = this.output.write(Buffer.from(json), () => {
        this.pendingWrites--;
        // Writable emits write failures after invoking this callback. Leave its
        // error listener installed through that event, including after close().
        if (this.closed && this.pendingWrites === 0) {
          queueMicrotask(() => this.output.off('error', this.onStreamError));
        }
      });
      if (writable) {
        this.pendingSends.delete(pending);
        resolve();
      } else if (!this.closed) {
        this.outputBlocked = true;
        this.input.pause();
      }
    } catch (error) {
      this.pendingWrites--;
      this.onStreamError(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.onData);
    this.input.off('error', this.onStreamError);
    this.input.off('end', this.onEnd);
    this.input.off('close', this.onInputClose);
    if (this.pendingWrites === 0) this.output.off('error', this.onStreamError);
    this.output.off('close', this.onOutputClose);
    this.output.off('drain', this.onDrain);
    if (this.input.listenerCount('data') === 0) this.input.pause();
    this.buffer = undefined;
    this.pendingChunk = undefined;
    this.lineBytes = 0;
    const error = new Error('Stdio transport is closed');
    for (const send of this.pendingSends) send.reject(error);
    this.pendingSends.clear();
    this.onclose?.();
  }
}

import { PassThrough, Writable } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { BoundedStdioTransport, MAX_STDIO_PENDING_OUTPUT_BYTES } from '../stdio-transport.js';
import { normalizeToolResult } from '../mcp-runtime.js';

function fixture(maxBufferSize?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  const replies: unknown[] = [];
  let pending = '';
  output.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      replies.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
  });
  const transport = new BoundedStdioTransport(input, output, { maxBufferSize });
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  return { input, output, transport, messages, errors, replies };
}

const nextRequest = { jsonrpc: '2.0', id: 2, method: 'ping' } as const;

describe('bounded stdio JSON-RPC transport', () => {
  test('accepts a request above the SDK 10 MiB default and still dispatches the next request', async () => {
    const f = fixture();
    await f.transport.start();
    try {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { code: 'x'.repeat(11 * 1024 * 1024) } };
      const line = Buffer.from(JSON.stringify(request) + '\n');
      for (let offset = 0; offset < line.length; offset += 64 * 1024) {
        f.input.write(line.subarray(offset, offset + 64 * 1024));
      }
      f.input.write(JSON.stringify(nextRequest) + '\n');
      expect(f.messages.map((message) => 'id' in message ? message.id : undefined)).toEqual([1, 2]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.transport.close();
    }
  });

  test('rejects an oversized line with measured bytes and recovers only after its newline', async () => {
    const f = fixture(64);
    await f.transport.start();
    try {
      f.input.write('x'.repeat(65));
      f.input.write(JSON.stringify(nextRequest));
      expect(f.messages).toEqual([]);
      expect(f.replies).toEqual([]);
      f.input.write('\n' + JSON.stringify(nextRequest) + '\n');
      expect(f.replies).toEqual([{
        jsonrpc: '2.0', id: null,
        error: {
          code: -32600,
          message: expect.any(String),
          data: {
            code: 'stdio_request_too_large', bytes: 105, limitBytes: 64,
            stage: 'stdio_receive', transportStage: 'stdio_receive',
            outcome: 'not_executed', executionOutcome: 'not_executed',
          },
        },
      }]);
      expect(f.messages).toEqual([nextRequest]);
    } finally {
      await f.transport.close();
    }
  });

  test('counts UTF-8 bytes at the exact cap and cap plus one across split code points', async () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'éé' };
    const line = Buffer.from(JSON.stringify(request));
    const f = fixture(line.length);
    await f.transport.start();
    try {
      const split = line.indexOf(Buffer.from('é')) + 1;
      f.input.write(line.subarray(0, split));
      f.input.write(Buffer.concat([line.subarray(split), Buffer.from('\n')]));
      f.input.write(Buffer.concat([line, Buffer.from(' \n')]));
      f.input.write(JSON.stringify(nextRequest) + '\n');
      expect(f.messages).toEqual([request, nextRequest]);
      expect(f.replies).toEqual([expect.objectContaining({
        error: expect.objectContaining({
          code: -32600,
          data: expect.objectContaining({ bytes: line.length + 1, limitBytes: line.length }),
        }),
      })]);
    } finally {
      await f.transport.close();
    }
  });

  test('frames coalesced lines independently rather than applying the cap to the chunk', async () => {
    const f = fixture(64);
    await f.transport.start();
    try {
      f.input.write((JSON.stringify(nextRequest) + '\r\n').repeat(3));
      expect(f.messages).toEqual([nextRequest, nextRequest, nextRequest]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.transport.close();
    }
  });

  test('reports malformed JSON, UTF-8 and schema errors without dispatching them or losing the next line', async () => {
    const f = fixture();
    await f.transport.start();
    try {
      f.input.write('\n{\n');
      f.input.write(Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","id":1,"method":"'),
        Buffer.from([0xc3, 0x28]), Buffer.from('"}\n'),
      ]));
      f.input.write('{"jsonrpc":"2.0","id":1,"method":12}\n');
      f.input.write(JSON.stringify(nextRequest) + '\n');
      expect(f.messages).toEqual([nextRequest]);
      expect(f.replies).toEqual([-32700, -32700, -32700, -32600].map((code) => ({
        jsonrpc: '2.0', id: null,
        error: expect.objectContaining({ code }),
      })));
      expect(f.errors).toHaveLength(4);
    } finally {
      await f.transport.close();
    }
  });

  test.each([
    [JSON.stringify(nextRequest), -32700, 'stdio_truncated_line', 40],
    ['x'.repeat(65), -32600, 'stdio_request_too_large', 65],
  ])('rejects an unterminated EOF line without dispatch: %s', async (line, code, reason, bytes) => {
    const f = fixture(64);
    const closed = Promise.withResolvers<void>();
    f.transport.onclose = closed.resolve;
    await f.transport.start();
    f.input.end(line);
    await closed.promise;
    expect(f.messages).toEqual([]);
    expect(f.replies).toEqual([{
      jsonrpc: '2.0', id: null,
      error: expect.objectContaining({
        code, data: expect.objectContaining({ code: reason, bytes, limitBytes: 64 }),
      }),
    }]);
  });

  test('supports ordinary McpServer.connect initialization and ping responses', async () => {
    const f = fixture();
    const server = new McpServer({ name: 'stdio-test', version: '1.0.0' });
    const response = Promise.withResolvers<void>();
    f.output.on('data', () => { response.resolve(); });
    await server.connect(f.transport);
    try {
      f.input.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }) + '\n');
      await response.promise;
      expect(f.replies).toEqual([expect.objectContaining({
        id: 1, result: expect.objectContaining({ serverInfo: { name: 'stdio-test', version: '1.0.0' } }),
      })]);
      const pong = Promise.withResolvers<void>();
      f.output.once('data', () => pong.resolve());
      f.input.write(JSON.stringify(nextRequest) + '\n');
      await pong.promise;
      expect(f.replies[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    } finally {
      await server.close();
    }
  });

  test('waits for output drain and does not dispatch a coalesced suffix while backpressured', async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) { completeWrite = callback; },
    });
    const input = new PassThrough();
    const transport = new BoundedStdioTransport(input, output, { maxBufferSize: 64 });
    const messages: JSONRPCMessage[] = [];
    transport.onmessage = (message) => messages.push(message);
    await transport.start();
    try {
      input.write('x'.repeat(65) + '\n' + JSON.stringify(nextRequest) + '\n');
      expect(messages).toEqual([]);
      expect(input.isPaused()).toBe(true);
      completeWrite!();
      expect(messages).toEqual([nextRequest]);
      const pending = transport.send({ jsonrpc: '2.0', id: 2, result: {} });
      let sent = false;
      void pending.then(() => { sent = true; });
      await Promise.resolve();
      expect(sent).toBe(false);
      completeWrite!();
      await pending;
      expect(sent).toBe(true);
    } finally {
      await transport.close();
    }
  });

  test('does not count drained bytes against a response sent while replaying a coalesced request', async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) { completeWrite = callback; },
    });
    const input = new PassThrough();
    const transport = new BoundedStdioTransport(input, output, { maxPendingOutputBytes: 160 });
    const errors: Error[] = [];
    const responses: Promise<void>[] = [];
    const padding = 'x'.repeat(80);
    transport.onerror = (error) => errors.push(error);
    transport.onmessage = () => {
      responses.push(transport.send({ jsonrpc: '2.0', id: 2, result: { padding } }));
    };
    await transport.start();
    try {
      input.write((JSON.stringify(nextRequest) + '\n').repeat(2));
      expect(responses).toHaveLength(1);
      completeWrite!();
      expect(errors).toEqual([]);
      expect(responses).toHaveLength(2);
      completeWrite!();
      await Promise.all(responses);
    } finally {
      await transport.close();
    }
  });

  test('budgets UTF-8 bytes even on socket-style outputs with decodeStrings disabled', async () => {
    const output = new Writable({ highWaterMark: 1, decodeStrings: false, write() {} });
    const transport = new BoundedStdioTransport(new PassThrough(), output, { maxPendingOutputBytes: 200 });
    const onerror = jest.fn();
    transport.onerror = onerror;
    await transport.start();
    try {
      const message = { jsonrpc: '2.0', id: 1, result: { value: '界'.repeat(20) } } as const;
      const first = transport.send(message);
      const second = transport.send(message);
      const settled = Promise.allSettled([first, second]);
      expect(onerror).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('backpressure capacity exceeded'),
      }));
      expect(await settled).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('closed') }) },
        { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('capacity exceeded') }) },
      ]);
    } finally {
      await transport.close();
    }
  });

  test('allows the legacy escaping expansion of a 64 MiB Studio response within the output budget', async () => {
    const value = { returnValue: '"\\'.repeat(1024) };
    const emptyValue = { returnValue: '' };
    const result = normalizeToolResult({
      content: [{ type: 'text', text: JSON.stringify(value) }],
    }, 'legacy');
    const emptyResult = normalizeToolResult({
      content: [{ type: 'text', text: JSON.stringify(emptyValue) }],
    }, 'legacy');
    const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result };
    const emptyMessage: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: emptyResult };
    const emptyWireBytes = Buffer.byteLength(JSON.stringify(emptyMessage) + '\n');
    const emptyStudioBytes = Buffer.byteLength(JSON.stringify(emptyValue));
    const studioGrowth = Buffer.byteLength(JSON.stringify(value)) - emptyStudioBytes;
    const wireGrowth = Buffer.byteLength(JSON.stringify(message) + '\n') - emptyWireBytes;
    // Each quote/backslash pair occupies four bytes in the Studio JSON, then
    // twelve across legacy JSON-in-text plus structuredContent on the MCP wire.
    expect(studioGrowth).toBe(4096);
    expect(wireGrowth).toBe(12288);
    const fullFrameWireBytes = emptyWireBytes + Math.floor(
      (64 * 1024 * 1024 - emptyStudioBytes) / studioGrowth,
    ) * wireGrowth;
    expect(fullFrameWireBytes).toBeGreaterThan(160 * 1024 * 1024);
    expect(fullFrameWireBytes).toBeLessThan(MAX_STDIO_PENDING_OUTPUT_BYTES);
    const f = fixture();
    await f.transport.start();
    try {
      await f.transport.send(message);
      expect(f.replies).toEqual([message]);
    } finally {
      await f.transport.close();
    }
  });

  test('rejects a send waiting for drain when closed and closes only once', async () => {
    const output = new Writable({ highWaterMark: 1, write() {} });
    const transport = new BoundedStdioTransport(new PassThrough(), output);
    const onclose = jest.fn();
    transport.onclose = onclose;
    await transport.start();
    const pending = transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    const rejection = expect(pending).rejects.toThrow('closed');
    await transport.close();
    await rejection;
    await transport.close();
    expect(onclose).toHaveBeenCalledTimes(1);
    await expect(transport.send(nextRequest)).rejects.toThrow('closed');
    await expect(transport.start()).rejects.toThrow('started again');
  });

  test('uses the production 80 MiB inclusive line budget and recovers after its plus-one overflow', async () => {
    const limit = 80 * 1024 * 1024;
    const prefix = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"padding":"');
    const suffix = Buffer.from('"}}');
    const line = Buffer.alloc(limit, 'x');
    prefix.copy(line);
    suffix.copy(line, limit - suffix.length);
    const f = fixture();
    await f.transport.start();
    try {
      for (let offset = 0; offset < line.length; offset += 64 * 1024) {
        f.input.write(line.subarray(offset, offset + 64 * 1024));
      }
      f.input.write('\n');
      expect(f.messages.map((message) => 'id' in message ? message.id : undefined)).toEqual([1]);
      f.messages.length = 0;
      for (let offset = 0; offset < line.length; offset += 64 * 1024) {
        f.input.write(line.subarray(offset, offset + 64 * 1024));
      }
      f.input.write(' \n' + JSON.stringify(nextRequest) + '\n');
      expect(f.messages).toEqual([nextRequest]);
      expect(f.replies).toEqual([{
        jsonrpc: '2.0', id: null,
        error: expect.objectContaining({
          code: -32600,
          data: expect.objectContaining({ bytes: 83886081, limitBytes: 83886080 }),
        }),
      }]);
    } finally {
      await f.transport.close();
    }
  });

  test('reports output failure and rejects a send waiting for drain', async () => {
    const failure = new Error('broken pipe');
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) { completeWrite = callback; },
    });
    const transport = new BoundedStdioTransport(new PassThrough(), output);
    const onerror = jest.fn();
    transport.onerror = onerror;
    await transport.start();
    const pending = transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    const rejection = expect(pending).rejects.toThrow('closed');
    completeWrite!(failure);
    await rejection;
    expect(onerror).toHaveBeenCalledWith(failure);
  });
});

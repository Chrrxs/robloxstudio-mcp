#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { McpClient } from './lib/mcp-client.mjs';

const LARGE_BYTES = 128 * 1024 * 1024;
const CHUNK = 'x'.repeat(8192);
const UNICODE = '界é😀';

async function writeOutput(bytes) {
  if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
}

async function fixture() {
  process.stderr.write('McpClient parser fixture running on stdio\n');
  const paired = [];
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line);
    if (request.method === 'paired') {
      paired.push(request);
      if (paired.length === 2) {
        // Noise, blank lines, reversed RPC order, CRLF, and coalesced records.
        const lines = paired.reverse().map(entry => JSON.stringify({
          jsonrpc: '2.0', id: entry.id, result: entry.params,
        }));
        await writeOutput(`not-json\n\n${lines.join('\r\n')}\n`);
        paired.length = 0;
      }
    } else if (request.method === 'large') {
      await writeOutput(`{"jsonrpc":"2.0","id":${request.id},"result":{"payload":"`);
      // Deliberately split a UTF-8 sequence across physical pipe writes. The
      // production client's setEncoding decoder must retain the partial bytes.
      const unicodeBytes = Buffer.from(UNICODE);
      await writeOutput(unicodeBytes.subarray(0, 1));
      await writeOutput(unicodeBytes.subarray(1));
      for (let offset = 0; offset < LARGE_BYTES; offset += CHUNK.length) await writeOutput(CHUNK);
      await writeOutput('"}}\n');
    } else if (request.method === 'tools/call') {
      await writeOutput(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.params.arguments.response })}\n`);
    } else {
      await writeOutput(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.params })}\n`);
    }
  }
}

async function regression() {
  const client = new McpClient('real-ipc-output-parser', {
    command: process.execPath, args: [fileURLToPath(import.meta.url)],
    env: { RSMCP_CLIENT_PARSER_CHILD: '1', RSMCP_AUTO_ASSIGNED_PORT: '0' },
  });
  try {
    await client.start();
    const first = { value: 'first-界\nline' };
    const second = { value: 'second-é😀', nested: { escaped: '\\"' } };
    const paired = await Promise.all([
      client.rpc('paired', first), client.rpc('paired', second),
    ]);
    assert.deepEqual(paired, [first, second], 'Coalesced responses resolve by ID despite reversed order and framing noise');

    const failureBody = { success: false, error: 'Expected handler failure', summary: { succeeded: 1, failed: 1 } };
    const failure = { response: { isError: true, content: [{ type: 'text', text: JSON.stringify(failureBody) }] } };
    const success = { response: { content: [{ type: 'text', text: '{"success":true}' }] } };
    assert.deepEqual(await client.callToolResult('fixture', failure), { body: failureBody, isError: true });
    assert.deepEqual(await client.callToolError('fixture', failure), failureBody);
    await assert.rejects(client.callTool('fixture', failure), /returned isError/);
    await assert.rejects(client.callToolError('fixture', success), /did not return isError: true/);
    assert.deepEqual(await client.callTool('fixture', success), { success: true });

    const expectedHash = createHash('sha256').update(UNICODE);
    for (let offset = 0; offset < LARGE_BYTES; offset += CHUNK.length) expectedHash.update(CHUNK);
    const started = performance.now();
    const result = await client.rpc('large', {}, 45000);
    const elapsedMs = Math.round(performance.now() - started);
    assert.equal(result.payload.length, UNICODE.length + LARGE_BYTES);
    assert.equal(createHash('sha256').update(result.payload).digest('hex'), expectedHash.digest('hex'),
      'Complete 128MiB IPC payload and split Unicode survive without truncation or corruption');
    const after = { value: 'after-large-界é😀' };
    assert.deepEqual(await client.rpc('echo', after), after, 'Parser remains synchronized after the large line');
    console.log(JSON.stringify({ test: 'McpClient real IPC output parser', payloadBytes: LARGE_BYTES + Buffer.byteLength(UNICODE), elapsedMs }));
  } finally {
    await client.stop();
  }
}

if (process.env.RSMCP_CLIENT_PARSER_CHILD === '1') await fixture();
else await regression();

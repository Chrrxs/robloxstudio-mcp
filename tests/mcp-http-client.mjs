#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { callMcpHttpTool } from './lib/mcp-http-client.mjs';

const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({
    method: request.method,
    url: request.url,
    auth: request.headers['x-mcp-auth'],
    contentType: request.headers['content-type'],
    body,
  });

  response.setHeader('content-type', 'application/json');
  if (body.action === 'fail') {
    response.statusCode = 500;
    response.end(JSON.stringify({
      content: [{ type: 'text', text: 'managed launch failed' }],
      isError: true,
    }));
    return;
  }
  if (body.action === 'soft-fail') {
    response.end(JSON.stringify({ error: 'close refused' }));
    return;
  }
  response.end(JSON.stringify({
    launch_id: 'launch-http',
    instance_id: 'anon:http-managed',
    managed: true,
  }));
});

const listening = once(server, 'listening');
server.listen(0, '127.0.0.1');
await listening;
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not determine HTTP test port');

try {
  const result = await callMcpHttpTool(
    'manage_instance',
    { action: 'launch', source: 'baseplate' },
    {
      port: address.port,
      env: { ROBLOX_STUDIO_AUTH_TOKEN: 'runner-test-token' },
      timeoutMs: 2000,
    },
  );
  assert.equal(result.instance_id, 'anon:http-managed');
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: '/mcp/manage_instance',
    auth: 'runner-test-token',
    contentType: 'application/json',
    body: { action: 'launch', source: 'baseplate' },
  });

  await assert.rejects(
    callMcpHttpTool(
      'manage_instance',
      { action: 'fail' },
      {
        port: address.port,
        env: { ROBLOX_STUDIO_AUTH_TOKEN: 'runner-test-token' },
        timeoutMs: 2000,
      },
    ),
    /HTTP 500.*managed launch failed/,
  );
  await assert.rejects(
    callMcpHttpTool(
      'manage_instance',
      { action: 'soft-fail' },
      {
        port: address.port,
        env: { ROBLOX_STUDIO_AUTH_TOKEN: 'runner-test-token' },
        timeoutMs: 2000,
      },
    ),
    /HTTP 200.*close refused/,
  );
  await assert.rejects(
    callMcpHttpTool('manage_instance', { action: 'status' }, {
      port: address.port,
      env: {},
    }),
    /explicit ROBLOX_STUDIO_AUTH_TOKEN/,
  );
  await assert.rejects(
    callMcpHttpTool('../unsafe', {}, { port: address.port, env: {} }),
    /Invalid MCP tool name/,
  );
} finally {
  const closed = once(server, 'close');
  server.close();
  await closed;
}

console.log('MCP HTTP client passed');

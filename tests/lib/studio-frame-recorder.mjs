import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

// Observes the real bundled plugin's bytes without substituting its socket API.
// Tool calls never traverse this HTTP forwarding path: they use primary stdio.
export async function openStudioFrameRecorder({ port, upstreamPort }) {
  const frames = new Map();
  const errors = [];
  const pairs = new Set();
  let sequence = 0;
  let closing = false;
  // Deliberately above the production boundary so this observer cannot impose it.
  const maxPayload = 128 * 1024 * 1024;
  const sockets = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const server = createServer((incoming, outgoing) => {
    const forwarded = request({
      hostname: '127.0.0.1', port: upstreamPort, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` },
    }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on('error', error => {
      if (!closing) errors.push(`HTTP registration forwarding: ${error.message}`);
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });

  function observe(bytes, direction, connection) {
    const message = JSON.parse(bytes.toString());
    if (typeof message.requestId !== 'string') return;
    if (!['request', 'response', 'progress'].includes(message.kind)) return;
    const entries = frames.get(message.requestId) ?? [];
    entries.push({
      direction, connection, kind: message.kind, bytes: bytes.length,
      ...(message.kind === 'request' ? {
        peerId: message.peerId, target: message.target, endpoint: message.endpoint,
        remainingMs: message.remainingMs,
      } : {}),
      ...(message.kind === 'response' && message.error !== undefined ? { error: message.error } : {}),
      ...(message.kind === 'progress' ? { phase: message.phase, outcome: message.outcome } : {}),
    });
    frames.set(message.requestId, entries);
  }

  server.on('upgrade', (incoming, socket, head) => {
    sockets.handleUpgrade(incoming, socket, head, downstream => {
      const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${incoming.url}`, {
        maxPayload, perMessageDeflate: false,
        headers: { 'X-Studio-Token': incoming.headers['x-studio-token'] ?? '' },
      });
      const pair = { upstream, downstream, connection: ++sequence };
      pairs.add(pair);
      const buffered = [];
      let bufferedBytes = 0;
      const closePair = () => {
        pairs.delete(pair);
        upstream.terminate();
        downstream.terminate();
      };
      const fail = error => {
        if (!closing && errors.length < 50) errors.push(error.message);
        closePair();
      };
      upstream.on('error', fail);
      downstream.on('error', fail);
      upstream.on('close', closePair);
      downstream.on('close', closePair);
      upstream.on('open', () => {
        for (const body of buffered) upstream.send(body, { binary: false });
        buffered.length = 0;
        bufferedBytes = 0;
      });
      downstream.on('message', bytes => {
        try {
          observe(bytes, 'studio_to_server', pair.connection);
          if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary: false });
          else if (upstream.readyState === WebSocket.CONNECTING) {
            bufferedBytes += bytes.length;
            if (bufferedBytes > maxPayload) throw new Error('Recorder connection-establishment buffer exceeded its bound');
            buffered.push(bytes);
          }
        } catch (error) { fail(error); }
      });
      upstream.on('message', bytes => {
        try {
          observe(bytes, 'server_to_studio', pair.connection);
          if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes, { binary: false });
        } catch (error) { fail(error); }
      });
    });
  });

  const listening = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  await listening;
  return {
    frames,
    errors,
    async close() {
      closing = true;
      for (const pair of pairs) { pair.upstream.terminate(); pair.downstream.terminate(); }
      const socketsClosed = once(sockets, 'close');
      sockets.close();
      await socketsClosed;
      if (server.listening) {
        const serverClosed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await serverClosed;
      }
    },
  };
}

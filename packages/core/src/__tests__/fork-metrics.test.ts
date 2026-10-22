import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createToolServer } from '../mcp-runtime.js';
import { readForkLimits, setForkLimits } from '../fork/limits.js';
import { closeMetrics } from '../fork/metrics.js';
import { rgbaToPng } from '../png-encoder.js';
import type { ToolDefinition } from '../tools/definitions.js';
import type { RobloxStudioTools } from '../tools/index.js';

const TOOLS: ToolDefinition[] = [
  { name: 'grep_scripts', category: 'read', description: 'Use to grep.', inputSchema: { type: 'object', properties: {} } },
  { name: 'capture_screenshot', category: 'read', description: 'Use to capture.', inputSchema: { type: 'object', properties: {} } },
];

const bigPng = rgbaToPng(Buffer.alloc(1024 * 768 * 4, 128), 1024, 768).toString('base64');

async function connect() {
  const server = createToolServer({
    config: { name: 'metrics-test', version: '0.0.0', tools: TOOLS },
    getTools: () => ({}) as RobloxStudioTools,
    era: 'modern',
    invoke: async (_tools, name) => {
      if (name === 'capture_screenshot') {
        return { content: [{ type: 'text', text: JSON.stringify({ width: 1024, height: 768 }) }, { type: 'image', data: bigPng, mimeType: 'image/png' }] };
      }
      const matches = Array.from({ length: 200 }, (_, i) => ({ script: `ServerScriptService.S${i}`, line: i, text: 'local x = 1' }));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, matches }) }] };
    },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('caps and metrics through a real MCP client', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fork-metrics-')); });
  afterEach(() => {
    setForkLimits();
    rmSync(dir, { recursive: true, force: true });
  });

  test('every call is capped, shrunk and logged as one JSON line; stdout stays clean', async () => {
    const metricsFile = join(dir, 'metrics.jsonl');
    setForkLimits(readForkLimits(['--profile', 'playtest'], { MCP_METRICS_FILE: metricsFile }));
    const stdout = jest.spyOn(process.stdout, 'write');
    const { client, server } = await connect();
    try {
      const grep = await client.callTool({ name: 'grep_scripts', arguments: {} });
      const structured = grep.structuredContent as { matches: unknown[]; truncated: string };
      expect(Buffer.byteLength(JSON.stringify(structured))).toBeLessThanOrEqual(4096);
      expect(structured.truncated).toMatch(/matches: \d+ of 200\); narrow with maxResults/);

      const shot = await client.callTool({ name: 'capture_screenshot', arguments: {} });
      const image = (shot.content as Array<{ type: string; data?: string }>).find((block) => block.type === 'image');
      expect(Buffer.from(image!.data!, 'base64').readUInt32BE(16)).toBe(512);
    } finally {
      await client.close();
      await server.close();
      await closeMetrics();
    }
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();

    const lines = readFileSync(metricsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      ts: expect.any(String),
      tool: 'grep_scripts',
      profile: 'playtest',
      bytes: expect.any(Number),
      images: [],
      ms: expect.any(Number),
      truncated: true,
      error: false,
    });
    expect(lines[0].bytes).toBeLessThanOrEqual(4096);
    expect(lines[1]).toMatchObject({ tool: 'capture_screenshot', truncated: false, images: [{ w: 512, h: 384, bytes: expect.any(Number) }] });
  });

  test('no metrics file means nothing is written', async () => {
    setForkLimits(readForkLimits([], {}));
    const { client, server } = await connect();
    await client.callTool({ name: 'grep_scripts', arguments: {} });
    await client.close();
    await server.close();
    await closeMetrics();
  });
});

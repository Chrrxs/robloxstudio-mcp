// Field report #12 + #16: robloxstudio://tool-guides is listed and its content carries the
// "Server-side teleportation" note and the "Concurrent agent protocol" section.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { registerResourceHandlers, TOOL_GUIDE_URI } from '../mcp-compat.js';

async function connectedPair() {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerResourceHandlers(server);
  server.registerTool('noop', {}, async () => ({ content: [] }));
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe('field #12/#16 tool guide sections', () => {
  test('lists the tool guide resource and serves both new sections', async () => {
    const { server, client } = await connectedPair();
    try {
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toContain(TOOL_GUIDE_URI);

      const result = await client.readResource({ uri: TOOL_GUIDE_URI });
      const text = result.contents.map((content) => ('text' in content ? content.text : '')).join('\n');
      expect(text).toContain('## Server-side teleportation');
      expect(text).toContain('HumanoidRootPart.CFrame');
      expect(text).toContain('Humanoid:MoveTo');
      expect(text).toContain('## Concurrent agent protocol');
      for (const rule of [
        'one playtest lock',
        'disjoint DataModel subtree',
        'operation_id',
        'solo_playtest action=restart',
        'max_output_bytes',
        'target=edit',
      ]) {
        expect(text).toContain(rule);
      }
      expect(text).not.toContain('—');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

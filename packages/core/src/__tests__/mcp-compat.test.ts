import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import {
  registerResourceHandlers,
  TOOL_GUIDE_MARKDOWN,
  TOOL_GUIDE_URI,
} from '../mcp-compat.js';
import { DOC_CATEGORIES } from '../roblox-docs.js';

describe('MCP resource handlers', () => {
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

  test('handles resource probes without hiding tools capability', async () => {
    const { server, client } = await connectedPair();
    try {
      expect(client.getServerCapabilities()).toEqual({
        resources: { listChanged: true },
        tools: { listChanged: true },
      });
      await expect(client.listResources()).resolves.toEqual({
        resources: [expect.objectContaining({
          name: 'Roblox Studio MCP tool guide',
          uri: TOOL_GUIDE_URI,
          mimeType: 'text/markdown',
        })],
      });
      await expect(client.readResource({ uri: 'robloxstudio://missing' }))
        .rejects.toThrow('Resource not found: robloxstudio://missing');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('serves detailed tool guidance on demand', async () => {
    const { server, client } = await connectedPair();
    try {
      const result = await client.readResource({ uri: TOOL_GUIDE_URI });
      expect(result.contents).toEqual([{
        uri: TOOL_GUIDE_URI,
        mimeType: 'text/markdown',
        text: TOOL_GUIDE_MARKDOWN,
      }]);
      expect(TOOL_GUIDE_MARKDOWN).toContain('## Script changes');
      expect(TOOL_GUIDE_MARKDOWN).toContain('## Debugging and profiling');
      expect(TOOL_GUIDE_MARKDOWN).toContain('## Creator Store and generated assets');
      expect(TOOL_GUIDE_MARKDOWN).not.toContain('—');
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('exposes robloxdocs:// resource templates', async () => {
    const { server, client } = await connectedPair();
    try {
      const { resourceTemplates } = await client.listResourceTemplates();
      const templates = resourceTemplates.map(t => t.uriTemplate);
      // Every readable doc category must be discoverable via a template.
      for (const category of DOC_CATEGORIES) {
        expect(templates.some(t => t.startsWith(`robloxdocs://${category}/`))).toBe(true);
      }
      for (const template of resourceTemplates) {
        expect(template.mimeType).toBe('text/markdown');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('rejects robloxdocs URIs with unknown categories', async () => {
    const { server, client } = await connectedPair();
    try {
      await expect(client.readResource({ uri: 'robloxdocs://bogus/ProximityPrompt' }))
        .rejects.toThrow('not found');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

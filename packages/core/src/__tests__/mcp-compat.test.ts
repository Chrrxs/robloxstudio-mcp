import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerResourceHandlers } from '../mcp-compat.js';
import { DOC_CATEGORIES } from '../roblox-docs.js';

describe('MCP resource handlers', () => {
  async function connectedPair() {
    const server = new Server(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    registerResourceHandlers(server);

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
        resources: {},
        tools: {},
      });
      await expect(client.listResources()).resolves.toEqual({ resources: [] });
      await expect(client.readResource({ uri: 'robloxstudio://missing' }))
        .rejects.toThrow('Resource robloxstudio://missing not found');
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

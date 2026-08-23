import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Server as HttpServer } from 'node:http';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer, TOOL_HANDLERS } from '../http-server.js';
import {
  createToolServer,
  normalizeToolResult,
  publicToolDefinition,
  serverInstructions,
} from '../mcp-runtime.js';
import { getReadOnlyTools, TOOL_DEFINITIONS } from '../tools/definitions.js';
import type { RobloxStudioTools } from '../tools/index.js';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectPropertySchemas(
  schema: unknown,
  path = 'input',
  seen = new Set<object>(),
): Array<{ path: string; schema: JsonObject }> {
  if (!isJsonObject(schema) || seen.has(schema)) return [];
  seen.add(schema);

  const found: Array<{ path: string; schema: JsonObject }> = [];
  if (isJsonObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (!isJsonObject(propertySchema)) continue;
      const propertyPath = `${path}.${name}`;
      found.push({ path: propertyPath, schema: propertySchema });
      found.push(...collectPropertySchemas(propertySchema, propertyPath, seen));
    }
  }

  for (const keyword of ['items', 'additionalProperties'] as const) {
    if (isJsonObject(schema[keyword])) {
      found.push(...collectPropertySchemas(schema[keyword], `${path}[]`, seen));
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      found.push(...collectPropertySchemas(branch, path, seen));
    }
  }
  return found;
}

describe('MCP v2 tool runtime', () => {
  test('projects JSON once for modern clients and preserves media', () => {
    const result = normalizeToolResult({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            value: 42,
            pluginSessionId: 'internal-session',
            diagnostics: { elapsed: 10 },
          }),
        },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
    }, 'modern');

    expect(result.structuredContent).toEqual({ success: true, value: 42 });
    expect(result.content).toEqual([
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ]);
  });

  test('keeps one JSON text projection for legacy clients', () => {
    const result = normalizeToolResult({
      content: [{ type: 'text', text: JSON.stringify({ value: 42 }) }],
    }, 'legacy');

    expect(result.structuredContent).toEqual({ value: 42 });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ value: 42 }) },
    ]);
  });

  test('keeps the catalog within the 3.0 token budget', () => {
    const catalog = TOOL_DEFINITIONS.map(publicToolDefinition);
    const names = new Set(catalog.map((tool) => tool.name));
    const byName = new Map(catalog.map((tool) => [tool.name, tool]));
    const serialized = JSON.stringify(catalog);
    const inspectorCatalog = getReadOnlyTools().map(publicToolDefinition);

    expect(catalog).toHaveLength(47);
    expect(serialized.length).toBeLessThanOrEqual(43_000);
    expect(catalog.filter((tool) => tool.outputSchema)).toHaveLength(46);
    expect(catalog.every((tool) => tool.description.length <= 120)).toBe(true);
    expect(inspectorCatalog).toHaveLength(24);
    expect(JSON.stringify(inspectorCatalog).length).toBeLessThanOrEqual(20_000);
    expect(byName.get('selection')?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: true,
    });

    for (const removed of [
      'start_playtest',
      'stop_playtest',
      'multiplayer_test_start',
      'multiplayer_test_state',
      'multiplayer_test_add_players',
      'multiplayer_test_leave_client',
      'multiplayer_test_end',
      'get_file_tree',
      'search_files',
      'search_by_property',
      'get_class_info',
      'export_build',
      'create_build',
      'generate_build',
      'import_build',
      'list_library',
      'search_materials',
      'get_build',
      'import_scene',
      'smart_duplicate',
      'mass_duplicate',
      'compare_instances',
      'get_services',
      'get_instance_children',
      'get_descendants',
      'set_property',
      'mass_set_property',
      'mass_get_property',
      'create_object',
      'mass_create_objects',
      'delete_object',
      'clone_object',
      'bulk_set_attributes',
      'set_attribute',
      'delete_attribute',
      'get_tags',
      'add_tag',
      'remove_tag',
      'get_tagged',
      'undo',
      'redo',
      'get_selection',
      'set_selection',
      'focus_viewport',
    ]) {
      expect(names.has(removed)).toBe(false);
      expect(TOOL_HANDLERS[removed]).toBeUndefined();
    }

    expect(byName.get('set_properties')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('upload_asset')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName.get('export_rbxm')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get('capture_script_profiler')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    for (const openWorldTool of [
      'execute_luau',
      'eval_server_runtime',
      'eval_client_runtime',
      'insert_asset',
    ]) {
      expect(byName.get(openWorldTool)?.annotations.openWorldHint).toBe(true);
    }
    expect(byName.get('edit_script_lines')?.annotations.idempotentHint).toBe(false);
    expect(byName.get('find_and_replace_in_scripts')?.annotations.idempotentHint).toBe(false);
    expect(byName.get('selection')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test('keeps selection, argument, and behavior metadata in their contract layers', () => {
    const catalog = TOOL_DEFINITIONS.map(publicToolDefinition);
    const toolNames = catalog.map((tool) => tool.name);
    const annotationKeys = [
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
      'readOnlyHint',
    ];

    for (const tool of catalog) {
      expect(tool.description).toMatch(/^Use .+\.$/);
      expect(tool.description.match(/\.(?:\s|$)/g)).toHaveLength(1);
      expect(tool.description).not.toContain('\n');
      expect(tool.description).not.toContain('—');
      expect(Object.keys(tool.annotations).sort()).toEqual(annotationKeys);

      for (const otherName of toolNames) {
        if (otherName !== tool.name) expect(tool.description).not.toContain(otherName);
      }

      for (const property of collectPropertySchemas(tool.inputSchema)) {
        const description = property.schema.description;
        if (typeof description !== 'string' || !description.trim()) {
          throw new Error(`${tool.name} ${property.path} needs an argument description.`);
        }
        expect(description.length).toBeLessThanOrEqual(64);
        expect(description).not.toContain('\n');
        expect(description).not.toContain('—');
        for (const otherName of toolNames) {
          if (otherName !== tool.name) expect(description).not.toContain(otherName);
        }
      }
    }
  });

  test('advertises cross-tool guidance once and only for available tools', () => {
    const fullInstructions = serverInstructions(TOOL_DEFINITIONS);
    expect(fullInstructions).toContain('get_connected_instances');
    expect(fullInstructions).toContain('execute_luau');
    expect(fullInstructions).toContain('set_script_source');
    expect(fullInstructions).toContain('solo_playtest');
    expect(fullInstructions).toContain('preview');
    expect(fullInstructions).toContain('robloxstudio://tool-guides');
    expect(fullInstructions).toContain('selection action=view before capture_screenshot');
    expect(fullInstructions).not.toContain('—');

    const inspectorDefinitions = getReadOnlyTools();
    const inspectorNames = new Set(inspectorDefinitions.map((tool) => tool.name));
    const inspectorInstructions = serverInstructions(inspectorDefinitions);
    for (const definition of TOOL_DEFINITIONS) {
      if (!inspectorNames.has(definition.name)) {
        expect(inspectorInstructions).not.toContain(definition.name);
      }
    }
    expect(inspectorNames.has('selection')).toBe(true);
    expect(inspectorInstructions).toContain('selection action=view before capture_screenshot');
    expect(inspectorInstructions).toContain('get_connected_instances');
    expect(inspectorInstructions).toContain('get_roblox_docs');
    expect(inspectorInstructions).toContain('robloxstudio://tool-guides');
  });

  test('advertises annotations and returns validated structuredContent', async () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_place_info')!;
    const fakeTools = {} as RobloxStudioTools;
    const server = createToolServer({
      config: { name: 'test-server', version: '3.0.0', tools: [definition] },
      getTools: () => fakeTools,
      era: 'modern',
      invoke: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ placeId: 123, serverVersion: 'internal' }) }],
      }),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = (await client.listTools()).tools[0];
      expect(listed.outputSchema).toEqual({ type: 'object', additionalProperties: true });
      expect(listed.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });

      const result = await client.callTool({ name: 'get_place_info', arguments: {} });
      expect(result.structuredContent).toEqual({ placeId: 123 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test.each([
    ['legacy', undefined, true],
    ['2026-07-28', { mode: { pin: '2026-07-28' as const } }, false],
  ])('serves %s clients on the shared HTTP endpoint', async (_label, versionNegotiation, keepsTextProjection) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_place_info')!;
    const getPlaceInfo = jest.fn(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ placeId: 123 }) }],
    }));
    const tools = { getPlaceInfo } as unknown as RobloxStudioTools;
    const bridge = new BridgeService();
    const app = createHttpServer(
      tools,
      bridge,
      new Set(['get_place_info']),
      { name: 'test-server', version: '3.0.0', tools: [definition] },
    );
    const httpServer = await new Promise<HttpServer>((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind a TCP port');

    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      versionNegotiation ? { versionNegotiation } : undefined,
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_place_info', arguments: {} });
      expect(result.structuredContent).toEqual({ placeId: 123 });
      expect(result.content.some((block) => block.type === 'text')).toBe(keepsTextProjection);
      expect(getPlaceInfo).toHaveBeenCalled();
    } finally {
      await client.close().catch(() => {});
      await (app as any).closeMcpHandler?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  test('negotiates 2026-07-28 through the stdio entry', async () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_place_info')!;
    const fakeTools = {} as RobloxStudioTools;
    const eras: string[] = [];
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(
      (context) => {
        eras.push(context.era);
        return createToolServer({
          config: { name: 'test-server', version: '3.0.0', tools: [definition] },
          getTools: () => fakeTools,
          era: context.era,
          invoke: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ placeId: 123 }) }],
          }),
        });
      },
      { transport: serverTransport },
    );
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );

    try {
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'get_place_info', arguments: {} });
      expect(result.structuredContent).toEqual({ placeId: 123 });
      expect(eras).toContain('modern');
    } finally {
      await client.close().catch(() => {});
      await handle.close().catch(() => {});
    }
  });
});

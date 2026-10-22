import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createToolServer, publicToolDefinition } from '../mcp-runtime.js';
import { FORK_TOOL_DEFINITIONS } from '../fork/definitions.js';
import { editionCatalog, PLAYTEST_PROFILE_TOOLS, resolveToolset, ToolsetError } from '../fork/profiles.js';
import { getAllTools, getReadOnlyTools, type ToolDefinition } from '../tools/definitions.js';
import type { RobloxStudioTools } from '../tools/index.js';

const names = (tools: ToolDefinition[]) => tools.map((tool) => tool.name);
const catalogChars = (tools: ToolDefinition[]) => JSON.stringify(tools.map(publicToolDefinition)).length;

async function listedToolNames(tools: ToolDefinition[]): Promise<string[]> {
  const server = createToolServer({
    config: { name: 'profile-test', version: '0.0.0', tools },
    getTools: () => ({}) as RobloxStudioTools,
    allowedTools: new Set(names(tools)),
    era: 'modern',
    invoke: async () => ({ content: [] }),
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('fork tool profiles', () => {
  test('full is the default and keeps the upstream catalog', () => {
    const resolved = resolveToolset('main', [], {});
    expect(resolved.profile).toBe('full');
    expect(names(resolved.tools)).toEqual(names(editionCatalog('main')));
    for (const name of names(getAllTools())) expect(names(resolved.tools)).toContain(name);
  });

  test('inspect keeps only read tools', () => {
    const resolved = resolveToolset('main', ['--profile', 'inspect'], {});
    expect(resolved.tools.every((tool) => tool.category === 'read')).toBe(true);
    expect(names(resolved.tools)).toEqual([...names(getReadOnlyTools()), 'logs_since', 'query_tree', 'ui_layout', 'snapshot', 'diff_state', 'frame_strip']);
    expect(names(resolved.tools)).not.toContain('wait_for');
  });

  test('playtest keeps only its listed tools that exist', () => {
    const resolved = resolveToolset('main', ['--profile=playtest'], {});
    const known = new Set(names(editionCatalog('main')));
    expect(names(resolved.tools).sort()).toEqual(PLAYTEST_PROFILE_TOOLS.filter((name) => known.has(name)).sort());
    expect(names(resolved.tools)).not.toContain('get_runtime_logs');
    expect(names(resolved.tools)).not.toContain('set_script_source');
  });

  test('--tools is a custom allowlist that wins over --profile and env', () => {
    const resolved = resolveToolset(
      'main',
      ['--profile', 'inspect', '--tools', 'execute_luau, get_place_info'],
      { MCP_PROFILE: 'playtest' },
    );
    expect(resolved.profile).toBe('custom');
    expect(names(resolved.tools).sort()).toEqual(['execute_luau', 'get_place_info']);
  });

  test('environment variables apply when no flag is given, flags win', () => {
    expect(resolveToolset('main', [], { MCP_PROFILE: 'inspect' }).profile).toBe('inspect');
    expect(names(resolveToolset('main', [], { MCP_TOOLS: 'get_place_info' }).tools)).toEqual(['get_place_info']);
    expect(resolveToolset('main', ['--profile', 'playtest'], { MCP_TOOLS: 'get_place_info' }).profile).toBe('playtest');
  });

  test('rejects unknown tools and profiles with one clear message', () => {
    expect(() => resolveToolset('main', ['--tools', 'get_place_info,nope'], {})).toThrow(new ToolsetError('Unknown tool for this server: nope.'));
    expect(() => resolveToolset('main', ['--profile', 'tiny'], {})).toThrow(/Unknown profile "tiny"/);
    expect(() => resolveToolset('main', ['--tools'], {})).toThrow(ToolsetError);
  });

  test('the inspector edition can never gain write tools', () => {
    expect(() => resolveToolset('inspector', ['--tools', 'execute_luau'], {})).toThrow(/inspector edition: execute_luau/);
    const playtest = resolveToolset('inspector', ['--profile', 'playtest'], {});
    expect(playtest.tools.every((tool) => tool.category === 'read')).toBe(true);
    expect(names(resolveToolset('inspector', [], {}).tools)).toEqual(names(editionCatalog('inspector')));
  });

  test('unregistered tools are absent from tools/list', async () => {
    const resolved = resolveToolset('main', ['--profile', 'playtest'], {});
    expect(await listedToolNames(resolved.tools)).toEqual(names(resolved.tools).sort());
  });

  test('capture_screenshot gains crop and max_px within upstream description limits', () => {
    for (const edition of ['main', 'inspector'] as const) {
      const capture = editionCatalog(edition).find((tool) => tool.name === 'capture_screenshot')!;
      const props = (capture.inputSchema as { properties: Record<string, { description: string }> }).properties;
      expect(Object.keys(props)).toEqual(expect.arrayContaining(['format', 'quality', 'instance_id', 'crop', 'max_px']));
      for (const prop of Object.values(props)) expect(prop.description.length).toBeLessThanOrEqual(64);
    }
    const upstream = getAllTools().find((tool) => tool.name === 'capture_screenshot')!;
    expect(Object.keys((upstream.inputSchema as { properties: object }).properties)).not.toContain('crop');
  });

  test('fork tools follow upstream description rules', () => {
    for (const tool of FORK_TOOL_DEFINITIONS) {
      expect(tool.description).toMatch(/^Use [^.]+\.$/);
      expect(tool.description.length).toBeLessThanOrEqual(120);
      const props = (tool.inputSchema as { properties: Record<string, { description: string }> }).properties;
      for (const [name, prop] of Object.entries(props)) {
        expect([name, prop.description.length <= 64]).toEqual([name, true]);
      }
    }
  });

  test('profiles shrink the advertised catalog', () => {
    const full = catalogChars(resolveToolset('main', [], {}).tools);
    const playtest = catalogChars(resolveToolset('main', ['--profile', 'playtest'], {}).tools);
    const inspect = catalogChars(resolveToolset('main', ['--profile', 'inspect'], {}).tools);
    expect(playtest).toBeLessThanOrEqual(12_000);
    expect(inspect).toBeLessThan(full);
    expect(playtest).toBeLessThan(full / 3);
  });
});

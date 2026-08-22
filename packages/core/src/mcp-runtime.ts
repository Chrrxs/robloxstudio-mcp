import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type McpHttpHandler,
  type McpRequestContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { RoutingFailure } from './bridge-service.js';
import { registerResourceHandlers } from './mcp-compat.js';
import { StudioLaunchPreDispatchError } from './studio-instance-manager.js';
import type { RobloxStudioTools } from './tools/index.js';
import type { ToolDefinition } from './tools/definitions.js';

export type ProtocolEra = McpRequestContext['era'];

export interface McpRuntimeConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export interface McpRuntimeOptions {
  config: McpRuntimeConfig;
  getTools: () => RobloxStudioTools;
  invoke: (tools: RobloxStudioTools, name: string, args: Record<string, unknown>) => Promise<unknown>;
  allowedTools?: ReadonlySet<string>;
  era: ProtocolEra;
}

type ResultContent =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

type ToolResultLike = {
  content?: ResultContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

const INTERNAL_RESULT_KEYS = new Set([
  'bundleModifiedAt',
  'bundlePath',
  'bundleSha256',
  'connectedAt',
  'debug',
  'diagnostics',
  'internal',
  'lastActivity',
  'pluginSessionId',
  'pluginVariant',
  'pluginVersion',
  'requestId',
  'serverVersion',
  'versionMismatch',
]);

const TEXT_RESULT_TOOLS = new Set(['get_roblox_docs']);
// These remain in the inspector catalog because they do not mutate the
// DataModel, but they can write caller-selected files on the MCP host.
const SIDE_EFFECTING_READ_TOOLS = new Set([
  'capture_micro_profiler',
  'capture_script_profiler',
  'export_rbxm',
]);
const NON_DESTRUCTIVE_SIDE_EFFECT_TOOLS = new Set([
  'capture_device_matrix',
  'generate_model',
  'import_rbxm',
  'insert_asset',
  'insert_script_lines',
  'upload_asset',
]);
const IDEMPOTENT_WRITE_TOOLS = new Set([
  'capture_device_matrix',
  'export_rbxm',
  'reset_simulation_state',
  'set_device_simulator',
  'set_network_profile',
  'set_properties',
  'set_script_source',
]);
const OPEN_WORLD_TOOLS = new Set([
  'eval_client_runtime',
  'eval_server_runtime',
  'execute_luau',
  'generate_model',
  'get_asset_details',
  'get_asset_thumbnail',
  'get_roblox_docs',
  'insert_asset',
  'preview_asset',
  'search_assets',
  'upload_asset',
]);
const STRUCTURED_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

function compactPublicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactPublicValue);
  if (!value || typeof value !== 'object') return value;

  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || INTERNAL_RESULT_KEYS.has(key)) continue;
    compact[key] = compactPublicValue(child);
  }
  return compact;
}

function asStructuredObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return compactPublicValue(value) as Record<string, unknown>;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asStructuredObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Converts the historic JSON-in-text result shape into the lean 2026 MCP shape.
 * Modern clients receive JSON once in structuredContent; legacy clients keep the
 * text projection required by older SDKs. Human-readable text and media survive.
 */
export function normalizeToolResult(raw: unknown, era: ProtocolEra): CallToolResult {
  const result = (raw && typeof raw === 'object' ? raw : {}) as ToolResultLike;
  const originalContent = Array.isArray(result.content) ? result.content : [];
  let structured = asStructuredObject(result.structuredContent);
  const jsonTextIndex = originalContent.findIndex((block) =>
    block.type === 'text' && typeof block.text === 'string' && !!parseJsonObject(block.text));

  if (!structured) {
    if (jsonTextIndex >= 0) {
      structured = parseJsonObject((originalContent[jsonTextIndex] as { type: 'text'; text: string }).text);
    }
  }

  if (!structured) {
    return {
      content: originalContent as CallToolResult['content'],
      ...(result.isError ? { isError: true } : {}),
    };
  }

  const content = era === 'modern'
    ? originalContent.filter((_, index) => index !== jsonTextIndex)
    : [
        { type: 'text' as const, text: JSON.stringify(structured) },
        ...originalContent.filter((_, index) => index !== jsonTextIndex),
      ];

  return {
    content: content as CallToolResult['content'],
    structuredContent: structured,
    ...(result.isError ? { isError: true } : {}),
  };
}

function publicRoutingError(error: RoutingFailure): Record<string, unknown> {
  return {
    error: error.routingError.code,
    message: error.routingError.message,
    instances: error.routingError.data.instances.map((instance) => ({
      instance_id: instance.instanceId,
      role: instance.role,
      place_id: instance.placeId,
      place_name: instance.placeName,
      running: instance.isRunning,
    })),
  };
}

export function publicToolErrorBody(name: string, error: unknown): Record<string, unknown> {
  if (error instanceof StudioLaunchPreDispatchError) {
    return compactPublicValue(error.toResponseBody()) as Record<string, unknown>;
  }
  if (error instanceof RoutingFailure) return publicRoutingError(error);

  console.error(`[tool:${name}]`, error);
  const message = error instanceof Error ? error.message : 'Tool execution failed.';
  return { error: 'tool_failed', message: message.slice(0, 500) };
}

function concise(text: string, maxLength: number, firstSentence = false): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const sentenceEnd = firstSentence ? normalized.search(/\.(?:\s|$)/) : -1;
  const candidate = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized;
  if (candidate.length <= maxLength) return candidate;
  const textBudget = maxLength - 1;
  const clipped = candidate.slice(0, textBudget + 1);
  const wordEnd = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, wordEnd > textBudget / 2 ? wordEnd : textBudget).trimEnd()}…`;
}

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => compactSchema(entry));
  if (!value || typeof value !== 'object') return value;

  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (key === 'description' && typeof child === 'string') {
      compact[key] = concise(child, 64);
      continue;
    }
    compact[key] = compactSchema(child);
  }
  return compact;
}

export function toolAnnotations(definition: ToolDefinition): ToolAnnotations {
  const readOnly = definition.category === 'read'
    && !SIDE_EFFECTING_READ_TOOLS.has(definition.name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && !NON_DESTRUCTIVE_SIDE_EFFECT_TOOLS.has(definition.name),
    idempotentHint: readOnly || IDEMPOTENT_WRITE_TOOLS.has(definition.name),
    openWorldHint: OPEN_WORLD_TOOLS.has(definition.name),
  };
}

export function publicToolDefinition(definition: ToolDefinition) {
  const outputSchema = definition.outputSchema
    ?? (TEXT_RESULT_TOOLS.has(definition.name) ? undefined : STRUCTURED_OBJECT_SCHEMA);
  return {
    name: definition.name,
    description: concise(definition.description, 120, true),
    inputSchema: compactSchema(definition.inputSchema) as Record<string, unknown>,
    ...(outputSchema ? { outputSchema } : {}),
    annotations: definition.annotations ?? toolAnnotations(definition),
  };
}

/** Shared routing and workflow guidance that should be added to the client prompt once. */
export function serverInstructions(definitions: readonly ToolDefinition[]): string {
  const names = new Set(definitions.map((definition) => definition.name));
  const has = (...toolNames: string[]) => toolNames.every((name) => names.has(name));
  const instructions = ['Use canonical DataModel paths returned by tools.'];

  if (has('get_connected_instances')) {
    instructions.push(
      'When more than one place is connected, call get_connected_instances and pass the chosen id as instance_id.',
    );
  }
  if (has('search_objects', 'get_project_structure', 'grep_scripts', 'execute_luau')) {
    instructions.push(
      'Use search_objects, get_project_structure, or grep_scripts for standard discovery. Use execute_luau for custom traversal or bulk edits.',
    );
  }
  if (has('set_script_source', 'edit_script_lines', 'insert_script_lines', 'delete_script_lines')) {
    instructions.push(
      'Use set_script_source only for whole-script replacement. Use edit_script_lines, insert_script_lines, or delete_script_lines for focused changes.',
    );
  }
  if (has('solo_playtest', 'multiplayer_playtest', 'get_runtime_logs')) {
    instructions.push(
      'Start solo_playtest or multiplayer_playtest before targeting a live server or client. Read runtime output with get_runtime_logs.',
    );
  }
  if (has('search_assets', 'preview_asset', 'insert_asset')) {
    instructions.push('Search and preview untrusted Creator Store assets before inserting them.');
  }
  if (has('capture_screenshot', 'simulate_mouse_input')) {
    instructions.push('Capture a screenshot before sending mouse input so its pixel coordinates match the viewport.');
  }
  if (has('get_roblox_docs')) {
    instructions.push('Use get_roblox_docs instead of guessing unfamiliar engine or Luau APIs.');
  }

  instructions.push('Read robloxstudio://tool-guides for detailed workflows and safety notes.');
  return instructions.join(' ');
}

export function createToolServer(options: McpRuntimeOptions): McpServer {
  const definitions = options.config.tools.filter(
    (definition) => !options.allowedTools || options.allowedTools.has(definition.name),
  );
  const server = new McpServer({
    name: options.config.name,
    version: options.config.version,
  }, {
    instructions: serverInstructions(definitions),
  });
  registerResourceHandlers(server);

  for (const definition of definitions) {
    const publicDefinition = publicToolDefinition(definition);

    server.registerTool(
      definition.name,
      {
        description: publicDefinition.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(publicDefinition.inputSchema),
        ...(publicDefinition.outputSchema
          ? { outputSchema: fromJsonSchema<Record<string, unknown>>(publicDefinition.outputSchema as Record<string, unknown>) }
          : {}),
        annotations: publicDefinition.annotations,
      },
      async (args) => {
        try {
          const raw = await options.invoke(options.getTools(), definition.name, args as Record<string, unknown>);
          return normalizeToolResult(raw, options.era);
        } catch (error) {
          return normalizeToolResult({
            content: [{ type: 'text', text: JSON.stringify(publicToolErrorBody(definition.name, error)) }],
            isError: true,
          }, options.era);
        }
      },
    );
  }

  return server;
}

export function createToolHttpHandler(options: Omit<McpRuntimeOptions, 'era'>): McpHttpHandler {
  return createMcpHandler(
    (context) => createToolServer({ ...options, era: context.era }),
    {
      responseMode: 'json',
      onerror: (error) => console.error('[mcp:http]', error),
    },
  );
}

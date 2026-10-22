// Fork-only tool definitions. Kept apart from TOOL_DEFINITIONS so upstream's
// pinned catalog tests and merges stay untouched; profiles.ts merges them in.
import type { ToolDefinition } from '../tools/definitions.js';

const INSTANCE_ID = { type: 'string', description: 'Studio process ID when ambiguous.' };
const PEER_TARGET = { type: 'string', description: 'edit, server or client-N; default server in a playtest.' };

export const FORK_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'wait_for',
    category: 'write',
    description: 'Use to wait in Studio until a Luau expression is truthy, in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        expr: { type: 'string', description: 'Luau expression, polled every 0.1 s until truthy.' },
        target: PEER_TARGET,
        timeout: { type: 'number', description: 'Seconds to wait, up to 120; default 5.' },
        instance_id: INSTANCE_ID,
      },
      required: ['expr'],
    },
  },
  {
    name: 'logs_since',
    category: 'read',
    description: 'Use to read only new runtime log lines, warnings and up by default, with repeats collapsed.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'cursor= value from the last call; omit for the whole buffer.' },
        min_level: { type: 'string', enum: ['out', 'info', 'warn', 'error'], description: 'Lowest level shown; default warn.' },
        pattern: { type: 'string', description: 'Only lines containing this text.' },
        target: { type: 'string', description: 'Only this peer: edit, server or client-N.' },
        instance_id: INSTANCE_ID,
      },
    },
  },
  {
    name: 'query_tree',
    category: 'read',
    description: 'Use to list instances under a path, one line each with only the fields you name.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root instance path; result paths are relative to it.' },
        class: { type: 'string', description: 'Only instances that IsA this class.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Properties (or @Attribute) to show; default none.' },
        depth: { type: 'integer', description: 'Levels below path, 0-10; default 1.' },
        limit: { type: 'integer', description: 'Lines to return, 1-500; default 25.' },
        target: PEER_TARGET,
        instance_id: INSTANCE_ID,
      },
      required: ['path'],
    },
  },
  {
    name: 'run_scenario',
    category: 'write',
    description: 'Use to run a scripted playtest scenario; returns one line per step and PASS or FAIL.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Scenario ModuleScript name in the scenario container.' },
        source: { type: 'string', description: 'Inline scenario module source, instead of name.' },
        params: { type: 'object', description: 'Passed to a scenario module that returns a function.' },
        timeout: { type: 'number', description: 'Whole-run limit in seconds, up to 600; default 120.' },
        instance_id: INSTANCE_ID,
      },
    },
  },
  {
    name: 'ui_layout',
    category: 'read',
    description: 'Use to check GUI layout as text (overlaps, overflow, clipped text) instead of a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        gui_path: { type: 'string', description: 'GUI path; PlayerGui.X = local player GUI (StarterGui in edit).' },
        target: { type: 'string', description: 'edit, server or client-N; default client-1 in a playtest.' },
        limit: { type: 'integer', description: 'Element lines to return, 1-200; default 40.' },
        instance_id: INSTANCE_ID,
      },
      required: ['gui_path'],
    },
  },
  {
    name: 'snapshot',
    category: 'read',
    description: 'Use to save instance properties and attributes for a later diff_state.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Instance paths, up to 50.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Properties to save; attributes are always saved.' },
        target: PEER_TARGET,
        instance_id: INSTANCE_ID,
      },
      required: ['paths'],
    },
  },
  {
    name: 'diff_state',
    category: 'read',
    description: 'Use to see only what changed since a snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'ID printed by snapshot, such as s3.' },
      },
      required: ['snapshot_id'],
    },
  },
  {
    name: 'frame_strip',
    category: 'read',
    description: 'Use to check an animation or transition as several frames in one grid image.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'edit or client-N; default the viewport screenshots use.' },
        crop: { type: 'string', description: 'Instance path, or viewport px "x,y,w,h"; default whole view.' },
        frames: { type: 'integer', description: 'Frames to capture, 2-12; default 4.' },
        interval: { type: 'number', description: 'Seconds between frames, 0-2; default 0.25.' },
        instance_id: INSTANCE_ID,
      },
    },
  },
];

/** Fork tools that return plain text lines instead of structured JSON. */
export const FORK_TEXT_TOOLS: ReadonlySet<string> = new Set(FORK_TOOL_DEFINITIONS.map((tool) => tool.name));

/** Extra arguments the fork adds to upstream tools; their handlers are wrapped in fork/handlers.ts. */
const SCHEMA_EXTENSIONS: Record<string, Record<string, object>> = {
  capture_screenshot: {
    quality: {
      type: 'number',
      description: 'JPEG quality 1-100; default 70 (MCP_IMAGE_QUALITY).',
    },
    crop: {
      type: 'string',
      description: 'Instance path, or viewport px "x,y,w,h"; default whole view.',
    },
    max_px: {
      type: 'integer',
      description: 'Longest image side in px; default 512 (MCP_IMAGE_MAX_PX).',
    },
  },
};

export function withForkSchemaExtensions(tool: ToolDefinition): ToolDefinition {
  const extra = SCHEMA_EXTENSIONS[tool.name];
  if (!extra) return tool;
  const schema = tool.inputSchema as { properties?: Record<string, object> };
  return {
    ...tool,
    inputSchema: { ...tool.inputSchema, properties: { ...schema.properties, ...extra } },
  };
}

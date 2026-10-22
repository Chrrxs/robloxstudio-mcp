// Fork-only tool definitions. Kept apart from TOOL_DEFINITIONS so upstream's
// pinned catalog tests and merges stay untouched; profiles.ts merges them in.
import type { ToolDefinition } from '../tools/definitions.js';

export const FORK_TOOL_DEFINITIONS: ToolDefinition[] = [];

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

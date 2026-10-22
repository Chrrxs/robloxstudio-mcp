// Fork-only tool definitions. Kept apart from TOOL_DEFINITIONS so upstream's
// pinned catalog tests and merges stay untouched; profiles.ts merges them in.
import type { ToolDefinition } from '../tools/definitions.js';

export const FORK_TOOL_DEFINITIONS: ToolDefinition[] = [];

/** Fork tools that return plain text lines instead of structured JSON. */
export const FORK_TEXT_TOOLS: ReadonlySet<string> = new Set(FORK_TOOL_DEFINITIONS.map((tool) => tool.name));

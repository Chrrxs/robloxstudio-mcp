import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DOC_CATEGORIES, fetchRobloxDoc, isDocCategory, DocNotFoundError } from './roblox-docs.js';

/**
 * Resource handlers for the MCP server.
 *
 * Studio state is tool-driven, so concrete resources stay empty — but the
 * official Roblox engine reference is exposed through resource templates
 * (robloxdocs://<category>/<Name>) so clients can attach class/enum/datatype
 * documentation as context (e.g. @-mentions in Claude Code).
 *
 * Registering resource handlers also keeps compatibility with MCP clients
 * that probe optional resource endpoints before considering tool-only
 * servers usable:
 * - https://github.com/openai/codex/issues/14242
 * - https://github.com/openai/codex/issues/14454
 */
export function registerResourceHandlers(server: Server): void {
  server.registerCapabilities({ resources: {} });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: 'robloxdocs://classes/{className}',
        name: 'Roblox class documentation',
        description: 'Official engine reference for a class (e.g. robloxdocs://classes/ProximityPrompt) — properties, methods, events, and usage guidance as markdown.',
        mimeType: 'text/markdown',
      },
      {
        uriTemplate: 'robloxdocs://enums/{enumName}',
        name: 'Roblox enum documentation',
        description: 'Official engine reference for an enum (e.g. robloxdocs://enums/KeyCode).',
        mimeType: 'text/markdown',
      },
      {
        uriTemplate: 'robloxdocs://datatypes/{dataTypeName}',
        name: 'Roblox datatype documentation',
        description: 'Official engine reference for a datatype (e.g. robloxdocs://datatypes/CFrame).',
        mimeType: 'text/markdown',
      },
      {
        uriTemplate: 'robloxdocs://libraries/{libraryName}',
        name: 'Roblox library documentation',
        description: 'Official engine reference for a Luau library (e.g. robloxdocs://libraries/table).',
        mimeType: 'text/markdown',
      },
      {
        uriTemplate: 'robloxdocs://globals/{globalsPage}',
        name: 'Roblox globals documentation',
        description: 'Official engine reference for global functions and variables (e.g. robloxdocs://globals/LuaGlobals, robloxdocs://globals/RobloxGlobals).',
        mimeType: 'text/markdown',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const match = uri.match(/^robloxdocs:\/\/([^/]+)\/([^/]+)$/);
    if (!match || !isDocCategory(match[1])) {
      throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
    }
    const [, category, rawName] = match;
    const name = decodeURIComponent(rawName);
    try {
      const content = await fetchRobloxDoc(category, name);
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: content }],
      };
    } catch (error) {
      if (error instanceof DocNotFoundError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Resource ${uri} not found. Names are case-sensitive PascalCase; valid categories: ${DOC_CATEGORIES.join(', ')}.`
        );
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to read ${uri}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

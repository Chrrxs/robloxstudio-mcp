import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { DOC_CATEGORIES, fetchRobloxDoc, isDocCategory, DocNotFoundError } from './roblox-docs.js';

export const TOOL_GUIDE_URI = 'robloxstudio://tool-guides';

export const TOOL_GUIDE_MARKDOWN = `# Roblox Studio MCP tool guide

Tool descriptions explain selection. Input schemas explain arguments. This guide holds shared workflows and safety notes.

## Connection and paths

- Use canonical DataModel paths returned by the tools. Paths usually start with game.
- Call get_connected_instances when more than one place may be connected. Pass the chosen row's id as instance_id on later calls.
- Use get_place_info for the active place identity and settings.

## Discovery and edit work

- Use get_project_structure for a bounded hierarchy, search_objects for an instance query, and grep_scripts for source text.
- Use get_instance_properties and get_attributes after locating an instance.
- Use execute_luau for custom traversal, bulk edits, and work that would otherwise need many tool calls. It runs through the Studio plugin context.
- Use set_properties when several known properties on one instance can be updated in one request.

## Selection and viewport

- Use selection with action=get when the user's Studio selection should define the scope.
- Use action=set with instance paths to replace, add to, or remove from the selection. An empty paths array in set mode clears it.
- Use action=view with a BasePart or Model path to frame it. The current viewing direction is preserved unless from or angleY overrides it. padding below 1 crops closer and above 1 pulls back.
- For visual proof, change the instance, frame it with selection, then call capture_screenshot.

## Script changes

- Read the relevant source with get_script_source before changing it.
- Use edit_script_lines, insert_script_lines, or delete_script_lines for focused changes with known line numbers.
- Use set_script_source only when replacing the whole script.
- Use find_and_replace_in_scripts with dryRun first when a replacement may affect several scripts.

## Playtests and runtime Luau

Start solo_playtest or multiplayer_playtest before targeting a live server or client. Stop the playtest when the scenario is complete.

execute_luau runs through the Studio plugin. eval_server_runtime and eval_client_runtime run inside a live game VM and share that VM's require cache with game scripts. Use the eval tools when module state or the runtime Script or LocalScript environment matters.

Read output with get_runtime_logs. Reuse nextSince or perCaptureNextSince for incremental reads instead of requesting the full buffer again.

## Simulation and input

- Inspect current settings with get_simulation_state before changing them.
- Apply network conditions with set_network_profile. Roblox caps packet loss at 0.5 percent.
- Inspect built-in device IDs with get_device_simulator_state, then apply one with set_device_simulator or compare several with capture_device_matrix.
- Clear temporary network and device settings with reset_simulation_state after a scenario.
- Capture the viewport with capture_screenshot before simulate_mouse_input so the pixel coordinates match. Keyboard input should target a live client when game input is under test.

## Debugging and profiling

- breakpoints requires Studio's Script Editor API beta feature. Logpoints normally use continue_execution=true. A pausing breakpoint with continue_execution=false needs an OnStopped resume handler.
- breakpoints clear removes only MCP-created breakpoints unless clear_all is true. clear_all also removes user-created breakpoints.
- capture_script_profiler ranks Luau functions by CPU time. Use output_path when the raw capture is needed.
- capture_micro_profiler attributes frame time across engine and game work. Its rows are inclusive or cumulative views, so do not sum them as disjoint totals.
- Use baseline_path or baseline for before-and-after MicroProfiler comparisons.
- Use get_memory_breakdown for memory categories and get_scene_analysis for instance, script, triangle, animation, or audio cost.

## Creator Store and generated assets

Search with search_assets, inspect a shortlist with get_asset_details or get_asset_thumbnail, and preview untrusted content with preview_asset before insert_asset.

Studio must allow third-party asset loading for public third-party previews and insertion. preview_asset scans the complete hierarchy without returning script source. insert_asset removes every LuaSourceContainer and PackageLink before parenting the remaining content, then scans again before insertion.

generate_model stages generated content under ServerStorage for review. upload_asset sends an explicit local file to the chosen Roblox user or group.

## RBXM files

- export_rbxm writes selected instances to an explicit local path. It can read the edit DataModel or a live server DataModel.
- import_rbxm accepts exactly one local path, HTTP or HTTPS URL, or base64 source. It parents imported instances under the supplied canonical path.

## Studio processes

manage_instance can launch, inspect, and close Studio or list published place revisions. A process-identity launch returns a suspended launch that must be authorized and completed explicitly. Keep its launch_id until the connection has an instance_id.

## Roblox reference material

Use get_roblox_docs for official engine and Luau reference pages. Use get_roblox_skills to list or read Roblox-authored Studio Assistant skills when their longer guidance is useful.
`;

/** Official Roblox reference templates shared by the HTTP and stdio servers. */
export function registerResourceHandlers(server: McpServer): void {
  server.registerResource(
    'Roblox Studio MCP tool guide',
    TOOL_GUIDE_URI,
    {
      description: 'Detailed workflows and safety notes for Roblox Studio MCP tools.',
      mimeType: 'text/markdown',
    },
    async (resourceUrl) => ({
      contents: [{
        uri: resourceUrl.href,
        mimeType: 'text/markdown',
        text: TOOL_GUIDE_MARKDOWN,
      }],
    }),
  );

  const templates = [
    ['classes', 'className', 'Roblox class documentation', 'Official Roblox engine class reference.'],
    ['enums', 'enumName', 'Roblox enum documentation', 'Official Roblox engine enum reference.'],
    ['datatypes', 'dataTypeName', 'Roblox datatype documentation', 'Official Roblox engine datatype reference.'],
    ['libraries', 'libraryName', 'Roblox library documentation', 'Official Roblox Luau library reference.'],
    ['globals', 'globalsPage', 'Roblox globals documentation', 'Official Roblox globals reference.'],
  ] as const;

  for (const [category, variable, name, description] of templates) {
    server.registerResource(
      name,
      new ResourceTemplate(`robloxdocs://${category}/{${variable}}`, { list: undefined }),
      { description, mimeType: 'text/markdown' },
      async (resourceUrl) => {
        const uri = resourceUrl.href;
        const match = uri.match(/^robloxdocs:\/\/([^/]+)\/([^/]+)$/);
        if (!match || !isDocCategory(match[1])) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} not found`);
        }

        const [, docCategory, rawName] = match;
        const docName = decodeURIComponent(rawName);
        try {
          const content = await fetchRobloxDoc(docCategory, docName);
          return {
            contents: [{ uri, mimeType: 'text/markdown', text: content }],
          };
        } catch (error) {
          if (error instanceof DocNotFoundError) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Resource ${uri} not found. Names are case-sensitive PascalCase; valid categories: ${DOC_CATEGORIES.join(', ')}.`,
            );
          }
          console.error(`[resource:${uri}]`, error);
          throw new ProtocolError(ProtocolErrorCode.InternalError, `Failed to read ${uri}.`);
        }
      },
    );
  }
}

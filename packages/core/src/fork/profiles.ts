// Tool profiles: limit which tools a server registers, so agents only pay
// catalog tokens for the tools their job needs.
import { getAllTools, getReadOnlyTools, type ToolDefinition } from '../tools/definitions.js';
import { flagValue, nonEmpty, ToolsetError } from './cli.js';
import { FORK_TOOL_DEFINITIONS, withForkSchemaExtensions } from './definitions.js';

export { ToolsetError };

export type Edition = 'main' | 'inspector';

export const PROFILE_NAMES = ['full', 'inspect', 'playtest'] as const;
export type ProfileName = typeof PROFILE_NAMES[number];

/** Tools a playtest agent needs. Names not in the catalog yet are skipped. */
export const PLAYTEST_PROFILE_TOOLS: readonly string[] = [
  'get_connected_instances',
  'get_request_status',
  'solo_playtest',
  'multiplayer_playtest',
  'eval_server_runtime',
  'eval_client_runtime',
  'simulate_keyboard_input',
  'simulate_mouse_input',
  'capture_screenshot',
  'wait_for',
  'logs_since',
  'query_tree',
  'run_scenario',
  'ui_layout',
  'snapshot',
  'diff_state',
  'frame_strip',
];

export interface ResolvedToolset {
  /** Profile name, or "custom" for an explicit --tools allowlist. */
  profile: ProfileName | 'custom';
  tools: ToolDefinition[];
}

/** Every tool this edition can serve, upstream first. */
export function editionCatalog(edition: Edition): ToolDefinition[] {
  const upstream = (edition === 'inspector' ? getReadOnlyTools() : getAllTools()).map(withForkSchemaExtensions);
  return edition === 'inspector'
    ? [...upstream, ...FORK_TOOL_DEFINITIONS.filter((tool) => tool.category === 'read')]
    : [...upstream, ...FORK_TOOL_DEFINITIONS];
}

/** Profile label for metrics, read the same way resolveToolset reads it (no validation). */
export function activeProfileName(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  const profileFlag = nonEmpty(flagValue(argv, '--profile'));
  if (nonEmpty(flagValue(argv, '--tools')) || (!profileFlag && nonEmpty(env.MCP_TOOLS))) return 'custom';
  return profileFlag ?? nonEmpty(env.MCP_PROFILE) ?? 'full';
}

/**
 * Resolves --tools / MCP_TOOLS (custom allowlist, wins) or --profile /
 * MCP_PROFILE (default full). Command-line flags win over environment.
 */
export function resolveToolset(
  edition: Edition,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedToolset {
  const catalog = editionCatalog(edition);
  const toolsFlag = flagValue(argv, '--tools');
  const profileFlag = flagValue(argv, '--profile');
  if (toolsFlag !== undefined && !nonEmpty(toolsFlag)) throw new ToolsetError('--tools needs a comma-separated list of tool names.');
  if (profileFlag !== undefined && !nonEmpty(profileFlag)) throw new ToolsetError(`--profile needs one of: ${PROFILE_NAMES.join(', ')}.`);

  const allowlist = nonEmpty(toolsFlag) ?? (nonEmpty(profileFlag) ? undefined : nonEmpty(env.MCP_TOOLS));
  if (allowlist) {
    const names = [...new Set(allowlist.split(',').map((name) => name.trim()).filter(Boolean))];
    const known = new Set(catalog.map((tool) => tool.name));
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      const scope = edition === 'inspector' ? 'the inspector edition' : 'this server';
      throw new ToolsetError(`Unknown tool${unknown.length > 1 ? 's' : ''} for ${scope}: ${unknown.join(', ')}.`);
    }
    const wanted = new Set(names);
    return { profile: 'custom', tools: catalog.filter((tool) => wanted.has(tool.name)) };
  }

  const profile = nonEmpty(profileFlag) ?? nonEmpty(env.MCP_PROFILE) ?? 'full';
  if (!(PROFILE_NAMES as readonly string[]).includes(profile)) {
    throw new ToolsetError(`Unknown profile "${profile}". Use one of: ${PROFILE_NAMES.join(', ')}.`);
  }
  switch (profile as ProfileName) {
    case 'inspect':
      return { profile: 'inspect', tools: catalog.filter((tool) => tool.category === 'read') };
    case 'playtest': {
      const wanted = new Set(PLAYTEST_PROFILE_TOOLS);
      return { profile: 'playtest', tools: catalog.filter((tool) => wanted.has(tool.name)) };
    }
    default:
      return { profile: 'full', tools: catalog };
  }
}

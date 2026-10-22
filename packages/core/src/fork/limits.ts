// Output limits and metrics settings, read once from flags and environment.
import { flagValue, nonEmpty, ToolsetError } from './cli.js';
import { activeProfileName } from './profiles.js';

export const DEFAULT_RESPONSE_CAP = 4096;
export const DEFAULT_IMAGE_MAX_PX = 512;
export const DEFAULT_IMAGE_QUALITY = 70;

/** Content tools whose whole job is returning text get more room by default. */
export const BUILT_IN_CAP_OVERRIDES: Readonly<Record<string, number>> = {
  get_script_source: 16384,
  get_roblox_docs: 16384,
  get_roblox_skills: 16384,
  execute_luau: 8192,
};

export interface ForkLimits {
  /** Bytes of text per response; 0 turns the cap off. */
  responseCap: number;
  /** Per-tool caps; 0 turns the cap off for that tool. */
  capOverrides: ReadonlyMap<string, number>;
  /** Longest image side in px; 0 turns image downscaling off. */
  imageMaxPx: number;
  imageQuality: number;
  metricsFile?: string;
  profile: string;
}

function parseCount(value: string, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(value.trim())) throw new ToolsetError(`${what} must be a whole number, got "${value}".`);
  const parsed = Number(value.trim());
  if (parsed > max) throw new ToolsetError(`${what} must be at most ${max}, got ${parsed}.`);
  return parsed;
}

function parseOverrides(text: string): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const entry of text.split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9_]+)\s*=\s*(\S+)$/.exec(entry);
    if (!match) throw new ToolsetError(`MCP_RESPONSE_CAP_OVERRIDES entries look like tool=bytes, got "${entry}".`);
    overrides.set(match[1], parseCount(match[2], `Cap for ${match[1]}`));
  }
  return overrides;
}

export function readForkLimits(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): ForkLimits {
  const capFlag = flagValue(argv, '--response-cap');
  if (capFlag !== undefined && !nonEmpty(capFlag)) throw new ToolsetError('--response-cap needs a byte count (0 = off).');
  const capText = nonEmpty(capFlag) ?? nonEmpty(env.MCP_RESPONSE_CAP);
  const maxPxText = nonEmpty(env.MCP_IMAGE_MAX_PX);
  const qualityText = nonEmpty(env.MCP_IMAGE_QUALITY);
  const quality = qualityText === undefined ? DEFAULT_IMAGE_QUALITY : parseCount(qualityText, 'MCP_IMAGE_QUALITY', 100);
  if (quality < 1) throw new ToolsetError('MCP_IMAGE_QUALITY must be 1-100.');
  return {
    responseCap: capText === undefined ? DEFAULT_RESPONSE_CAP : parseCount(capText, 'Response cap'),
    capOverrides: new Map([
      ...Object.entries(BUILT_IN_CAP_OVERRIDES),
      ...parseOverrides(env.MCP_RESPONSE_CAP_OVERRIDES ?? ''),
    ]),
    imageMaxPx: maxPxText === undefined ? DEFAULT_IMAGE_MAX_PX : parseCount(maxPxText, 'MCP_IMAGE_MAX_PX', 8192),
    imageQuality: quality,
    metricsFile: nonEmpty(env.MCP_METRICS_FILE),
    profile: activeProfileName(argv, env),
  };
}

let current: ForkLimits | undefined;

/** Process-wide limits. Entry points call this at startup so bad values fail fast. */
export function forkLimits(): ForkLimits {
  current ??= readForkLimits();
  return current;
}

/** Test hook: replace (or with no argument, reset) the process-wide limits. */
export function setForkLimits(limits?: ForkLimits): void {
  current = limits;
}

export function capFor(limits: ForkLimits, tool: string): number {
  return limits.capOverrides.get(tool) ?? limits.responseCap;
}

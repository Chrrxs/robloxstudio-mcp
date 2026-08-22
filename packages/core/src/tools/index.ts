import { StudioHttpClient } from './studio-client.js';
import { BridgeService, RoutingFailure, type PublicPluginInstance } from '../bridge-service.js';
import {
  OpenCloudClient,
  type AssetSearchParams,
  type CreatorStoreSearchCategory,
} from '../opencloud-client.js';
import { RobloxCookieClient } from '../roblox-cookie-client.js';
import {
  parseStudioProcessEnvironmentPatch,
  StudioInstanceManager,
  type ManagedStudioInstance,
  type StudioLaunchSource,
} from '../studio-instance-manager.js';
import { decodeImagePathToRgba, decodePngToRgba } from '../image-decode.js';
import { DOC_CATEGORIES, getRobloxDoc, isDocCategory } from '../roblox-docs.js';
import { findBuiltInStudioSkill, loadBuiltInStudioSkills } from '../studio-skills.js';
import { rgbaToJpeg } from '../jpeg-encoder.js';
import { rgbaToPng } from '../png-encoder.js';
import * as fs from 'fs';
import * as path from 'path';

type RawImageCaptureResponse = {
  success?: boolean;
  error?: string;
  width?: number;
  height?: number;
  data?: string;
  instancePath?: string;
  instanceName?: string;
  cameraPreset?: string;
};

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

type EncodedViewportCapture = {
  success: true;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
  quality?: number;
  note: string;
  data: string;
  mimeType: string;
  message: string;
} | {
  success: false;
  error: string;
};

type DeviceSimulatorSettings = {
  deviceId?: string;
  orientation?: string;
  resolution?: { width: number; height: number };
  pixelDensity?: number;
  scalingMode?: string;
};

type DeviceSimulatorMatrixEntry = DeviceSimulatorSettings & {
  label?: string;
};

type SimulationInclude = 'network' | 'deviceSimulator' | 'both';

type GenerateModelImage =
  { kind: 'asset'; asset_id: number };

const MAX_INLINE_IMAGE_BYTES = 6_000_000;
const DEFAULT_ASSET_AUDIO_PREVIEWS = 3;
const MAX_ASSET_AUDIO_PREVIEWS = 5;
const MAX_INLINE_AUDIO_PREVIEW_BYTES = 3_000_000;
const MAX_INLINE_AUDIO_PREVIEW_TOTAL_BYTES = 6_000_000;
const DEFAULT_ASSET_PREVIEW_DEPTH = 4;
const MAX_ASSET_PREVIEW_HIERARCHY_NODES = 100;
const MAX_SEARCH_ASSET_DESCRIPTION_LENGTH = 240;
const ROBLOX_CREATOR_USER_ID = 1;
const MAX_DEVICE_MATRIX_ENTRIES = 6;
const MAX_NETWORK_PACKET_LOSS_PERCENT = 0.5;
const STUDIO_ASSISTANT_SOURCE_IMAGE_LABEL = 'Studio Assistant Source Image';
const CREATOR_STORE_SEARCH_TYPES = new Set<string>([
  'Audio',
  'Model',
  'Decal',
  'Plugin',
  'MeshPart',
  'Video',
  'FontFamily',
  'Image',
  'Particle',
  'VFX',
]);
const CREATOR_STORE_SORT_CATEGORIES = new Set<string>([
  'Relevance',
  'Trending',
  'Top',
  'AudioDuration',
  'CreateTime',
  'UpdatedTime',
  'Ratings',
]);
function normalizeCreatorStoreSearch(
  assetType: string,
  query?: string,
): {
  requestedAssetType: string;
  searchCategoryType: CreatorStoreSearchCategory;
  effectiveQuery?: string;
} {
  if (!CREATOR_STORE_SEARCH_TYPES.has(assetType)) {
    throw new Error(
      `search_assets assetType must be one of: ${Array.from(CREATOR_STORE_SEARCH_TYPES).join(', ')}`,
    );
  }

  const trimmedQuery = query?.trim() || undefined;
  if (assetType === 'Image') {
    return {
      requestedAssetType: assetType,
      searchCategoryType: 'Decal',
      effectiveQuery: trimmedQuery,
    };
  }

  if (assetType === 'Particle' || assetType === 'VFX') {
    const suffix = assetType === 'Particle' ? 'particle effect' : 'VFX';
    const alreadyEffectSpecific = trimmedQuery !== undefined && /\b(?:particle|vfx|effect)\b/i.test(trimmedQuery);
    return {
      requestedAssetType: assetType,
      searchCategoryType: 'Model',
      effectiveQuery: trimmedQuery
        ? alreadyEffectSpecific ? trimmedQuery : `${trimmedQuery} ${suffix}`
        : suffix,
    };
  }

  return {
    requestedAssetType: assetType,
    searchCategoryType: assetType as CreatorStoreSearchCategory,
    effectiveQuery: trimmedQuery,
  };
}

function normalizeSearchAssetDescription(description: string | undefined): string {
  const normalized = description?.replace(/\s+/g, ' ').trim() ?? '';
  if (normalized.length <= MAX_SEARCH_ASSET_DESCRIPTION_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SEARCH_ASSET_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

// Encodes the raw RGBA capture into the requested image format.
// - 'png': lossless — sharpest text/UI, but a busy 3D scene can be large.
// - 'jpeg': default; quality 92 with 4:4:4 chroma (no subsampling) keeps text
//   crisp at ~1/3 the size. The image rides back inline as an MCP tool result,
//   so JPEG is the safe default for staying under client result-size caps.
function encodeImageFromRgbaResponse(
  response: RawImageCaptureResponse,
  format: 'jpeg' | 'png',
  quality: number,
): { buffer: Buffer; mimeType: string } {
  if (!response.data || response.width === undefined || response.height === undefined) {
    throw new Error('Render response missing data, width, or height');
  }
  const rgbaBuffer = Buffer.from(response.data, 'base64');
  if (format === 'png') {
    return { buffer: rgbaToPng(rgbaBuffer, response.width, response.height), mimeType: 'image/png' };
  }
  return {
    buffer: rgbaToJpeg(rgbaBuffer, response.width, response.height, quality),
    mimeType: 'image/jpeg',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== undefined)
    : [];
}

function numberField(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumberField(
  row: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === 'string' && value !== '' ? value : '';
}

function robloxAssetIdFromContentId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  const direct = /^(?:rbxassetid:\/\/)?(\d+)$/.exec(trimmed);
  const query = /[?&]id=(\d+)(?:&|$)/i.exec(trimmed);
  const rawId = direct?.[1] ?? query?.[1];
  if (!rawId) return undefined;

  const parsed = Number(rawId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function compactPreviewHierarchy(value: unknown): {
  hierarchy: Record<string, unknown>[];
  truncated: boolean;
} {
  let remaining = MAX_ASSET_PREVIEW_HIERARCHY_NODES;
  let truncated = false;

  const compactNode = (row: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (remaining <= 0) {
      truncated = true;
      return undefined;
    }
    remaining--;

    const node: Record<string, unknown> = {
      name: stringField(row, 'name'),
      className: stringField(row, 'className'),
    };
    const properties = asRecord(row.properties);
    if (properties && Object.keys(properties).length > 0) {
      node.properties = properties;
    }

    const children = asRows(row.children);
    if (children.length > 0) {
      const compactedChildren: Record<string, unknown>[] = [];
      for (const child of children) {
        const compacted = compactNode(child);
        if (!compacted) break;
        compactedChildren.push(compacted);
      }
      if (compactedChildren.length > 0) {
        node.children = compactedChildren;
      }
      if (compactedChildren.length < children.length) {
        node.childCount = children.length;
        node.truncated = true;
        truncated = true;
      }
    } else if (row.truncated === true) {
      node.truncated = true;
      const childCount = numberField(row, 'childCount');
      if (childCount > 0) node.childCount = childCount;
    }
    return node;
  };

  const hierarchy: Record<string, unknown>[] = [];
  for (const root of asRows(value)) {
    const compacted = compactNode(root);
    if (!compacted) break;
    hierarchy.push(compacted);
  }
  return { hierarchy, truncated };
}

function compactSoundReference(sound: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    name: stringField(sound, 'name'),
    className: stringField(sound, 'className'),
  };
  const path = stringField(sound, 'path');
  if (path) compact.path = path;
  const assetId = robloxAssetIdFromContentId(
    sound.assetId ?? sound.soundId ?? sound.asset,
  );
  if (assetId !== undefined) compact.assetId = assetId;

  const volume = optionalNumberField(sound, 'volume');
  if (volume !== undefined && volume !== 1) compact.volume = volume;
  const playbackSpeed = optionalNumberField(sound, 'playbackSpeed');
  if (playbackSpeed !== undefined && playbackSpeed !== 1) {
    compact.playbackSpeed = playbackSpeed;
  }
  const timeLength = optionalNumberField(sound, 'timeLength');
  if (timeLength !== undefined && timeLength > 0) compact.duration = timeLength;
  if (sound.looped === true) compact.looped = true;
  if (sound.autoPlay === true) compact.autoPlay = true;
  return compact;
}

function microProfilerDurationMs(body: Record<string, unknown> | undefined): number {
  const analysisWindow = asRecord(body?.analysis_window);
  const analysisDurationUs = analysisWindow?.analysis_duration_us;
  if (typeof analysisDurationUs === 'number' && Number.isFinite(analysisDurationUs) && analysisDurationUs > 0) {
    return analysisDurationUs / 1000;
  }
  const duration = body?.duration_ms;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 1000;
}

function perSecond(totalUs: number, durationMs: number): number {
  return durationMs > 0 ? totalUs / (durationMs / 1000) : totalUs;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentDelta(current: number, baseline: number): number | undefined {
  if (baseline === 0) return current === 0 ? 0 : undefined;
  return roundNumber(((current - baseline) / baseline) * 100);
}

function inclusiveUsField(row: Record<string, unknown> | undefined): number {
  const inclusive = numberField(row, 'inclusive_us');
  return inclusive !== 0 ? inclusive : numberField(row, 'total_us');
}

function rowSet(body: Record<string, unknown>, key: 'groups' | 'timers' | 'threads' | 'call_edges', fallback: string): Record<string, unknown>[] {
  const comparisonIndex = asRecord(body.comparison_index);
  const indexed = asRows(comparisonIndex?.[key]);
  return indexed.length > 0 ? indexed : asRows(body[fallback]);
}

function nestedRecord(row: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  return asRecord(row?.[key]);
}

function loadMicroProfilerBaseline(source: unknown, sourcePath: unknown): Record<string, unknown> | undefined {
  if (source !== undefined) {
    const inline = asRecord(source);
    if (!inline) throw new Error('baseline must be an object when provided');
    return inline;
  }
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== 'string' || sourcePath === '') {
      throw new Error('baseline_path must be a non-empty string when provided');
    }
    const resolved = path.resolve(sourcePath);
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record) throw new Error(`baseline_path did not contain a JSON object: ${resolved}`);
    return record;
  }
  return undefined;
}

function compareMicroProfilerRows(
  currentRows: Record<string, unknown>[],
  baselineRows: Record<string, unknown>[],
  currentDurationMs: number,
  baselineDurationMs: number,
  keyForRow: (row: Record<string, unknown>) => string,
  labelForRow: (row: Record<string, unknown>, fallbackKey: string) => Record<string, unknown>,
  maxRows: number,
): Record<string, unknown>[] {
  const currentByKey = new Map<string, Record<string, unknown>>();
  const baselineByKey = new Map<string, Record<string, unknown>>();
  for (const row of currentRows) {
    const key = keyForRow(row);
    if (key) currentByKey.set(key, row);
  }
  for (const row of baselineRows) {
    const key = keyForRow(row);
    if (key) baselineByKey.set(key, row);
  }

  const usesFullIndex = currentRows.length > 0 && baselineRows.length > 0;
  const keys = new Set<string>([...currentByKey.keys(), ...baselineByKey.keys()]);
  const deltas: Record<string, unknown>[] = [];
  for (const key of keys) {
    const current = currentByKey.get(key);
    const baseline = baselineByKey.get(key);
    const currentInclusiveUs = inclusiveUsField(current);
    const baselineInclusiveUs = inclusiveUsField(baseline);
    const currentExclusiveUs = numberField(current, 'exclusive_us');
    const baselineExclusiveUs = numberField(baseline, 'exclusive_us');
    const currentCount = numberField(current, 'count');
    const baselineCount = numberField(baseline, 'count');
    const currentUsPerS = perSecond(currentInclusiveUs, currentDurationMs);
    const baselineUsPerS = perSecond(baselineInclusiveUs, baselineDurationMs);
    const currentExclusiveUsPerS = perSecond(currentExclusiveUs, currentDurationMs);
    const baselineExclusiveUsPerS = perSecond(baselineExclusiveUs, baselineDurationMs);
    const currentCountPerS = perSecond(currentCount, currentDurationMs);
    const baselineCountPerS = perSecond(baselineCount, baselineDurationMs);
    const row: Record<string, unknown> = {
      ...labelForRow(current ?? baseline!, key),
      matched_by: 'stable_label',
      match_confidence: 'medium',
      current_inclusive_us: currentInclusiveUs,
      baseline_inclusive_us: baselineInclusiveUs,
      delta_inclusive_us: currentInclusiveUs - baselineInclusiveUs,
      current_inclusive_us_per_s: roundNumber(currentUsPerS),
      baseline_inclusive_us_per_s: roundNumber(baselineUsPerS),
      delta_inclusive_us_per_s: roundNumber(currentUsPerS - baselineUsPerS),
      current_exclusive_us: currentExclusiveUs,
      baseline_exclusive_us: baselineExclusiveUs,
      delta_exclusive_us: currentExclusiveUs - baselineExclusiveUs,
      current_exclusive_us_per_s: roundNumber(currentExclusiveUsPerS),
      baseline_exclusive_us_per_s: roundNumber(baselineExclusiveUsPerS),
      delta_exclusive_us_per_s: roundNumber(currentExclusiveUsPerS - baselineExclusiveUsPerS),
      current_count: currentCount,
      baseline_count: baselineCount,
      delta_count: currentCount - baselineCount,
      current_count_per_s: roundNumber(currentCountPerS),
      baseline_count_per_s: roundNumber(baselineCountPerS),
      delta_count_per_s: roundNumber(currentCountPerS - baselineCountPerS),
    };
    if (!usesFullIndex) row.match_scope = 'returned_rows';
    const pct = percentDelta(currentUsPerS, baselineUsPerS);
    if (pct !== undefined) row.delta_pct = pct;
    deltas.push(row);
  }

  deltas.sort((a, b) => Math.abs(numberField(b, 'delta_inclusive_us_per_s')) - Math.abs(numberField(a, 'delta_inclusive_us_per_s')));
  return deltas.slice(0, maxRows);
}

function compareMicroProfilerCaptures(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>,
  options: { currentLabel?: string; baselineLabel?: string; maxRows?: number } = {},
): Record<string, unknown> {
  const currentDurationMs = microProfilerDurationMs(current);
  const baselineDurationMs = microProfilerDurationMs(baseline);
  const maxRows = Math.max(1, Math.min(100, Math.trunc(options.maxRows ?? 20)));

  const groupDeltas = compareMicroProfilerRows(
    rowSet(current, 'groups', 'top_groups'),
    rowSet(baseline, 'groups', 'top_groups'),
    currentDurationMs,
    baselineDurationMs,
    (row) => stringField(row, 'group'),
    (row, key) => ({ group: stringField(row, 'group') || key }),
    maxRows,
  );

  const timerDeltas = compareMicroProfilerRows(
    rowSet(current, 'timers', 'top_timers'),
    rowSet(baseline, 'timers', 'top_timers'),
    currentDurationMs,
    baselineDurationMs,
    (row) => `${stringField(row, 'group')}::${stringField(row, 'name') || stringField(row, 'timer_id')}`,
    (row, key) => ({
      group: stringField(row, 'group') || key.split('::')[0],
      name: stringField(row, 'name') || key.split('::')[1],
      timer_id: row.timer_id,
    }),
    maxRows,
  );

  const threadDeltas = compareMicroProfilerRows(
    rowSet(current, 'threads', 'top_threads'),
    rowSet(baseline, 'threads', 'top_threads'),
    currentDurationMs,
    baselineDurationMs,
    (row) => stringField(row, 'thread_name') || String(numberField(row, 'thread_id')),
    (row, key) => ({
      thread_id: row.thread_id,
      thread_name: stringField(row, 'thread_name') || key,
      is_gpu: row.is_gpu,
    }),
    maxRows,
  );

  const edgeDeltas = compareMicroProfilerRows(
    rowSet(current, 'call_edges', 'top_call_edges'),
    rowSet(baseline, 'call_edges', 'top_call_edges'),
    currentDurationMs,
    baselineDurationMs,
    (row) => {
      const parent = nestedRecord(row, 'parent');
      const child = nestedRecord(row, 'child');
      return [
        stringField(parent, 'group'),
        stringField(parent, 'name') || stringField(parent, 'timer_id'),
        '>',
        stringField(child, 'group'),
        stringField(child, 'name') || stringField(child, 'timer_id'),
      ].join('::');
    },
    (row, key) => ({
      parent: nestedRecord(row, 'parent') ?? { label: key },
      child: nestedRecord(row, 'child') ?? { label: key },
    }),
    maxRows,
  );

  const currentHasIndex = asRecord(current.comparison_index) !== undefined;
  const baselineHasIndex = asRecord(baseline.comparison_index) !== undefined;
  return {
    baseline_label: options.baselineLabel ?? 'baseline',
    current_label: options.currentLabel ?? 'current',
    basis: 'inclusive_us_per_second normalized by each capture analysis duration; deltas use current minus baseline.',
    coverage: {
      current: currentHasIndex ? 'comparison_index' : 'returned_rows',
      baseline: baselineHasIndex ? 'comparison_index' : 'returned_rows',
    },
    duration_ms: {
      baseline: baselineDurationMs,
      current: currentDurationMs,
    },
    groups: groupDeltas,
    timers: timerDeltas,
    threads: threadDeltas,
    call_edges: edgeDeltas,
  };
}

const NETWORK_PROFILE_KEYS = [
  'InboundNetworkMinDelayMs',
  'OutboundNetworkMinDelayMs',
  'InboundNetworkJitterMs',
  'OutboundNetworkJitterMs',
  'InboundNetworkLossPercent',
  'OutboundNetworkLossPercent',
] as const;

type NetworkProfileKey = typeof NETWORK_PROFILE_KEYS[number];
type NetworkProfileValues = Partial<Record<NetworkProfileKey, number>>;

const NETWORK_PROFILES: Record<'great' | 'good' | 'poor', Record<NetworkProfileKey, number>> = {
  great: {
    InboundNetworkMinDelayMs: 15,
    OutboundNetworkMinDelayMs: 15,
    InboundNetworkJitterMs: 0,
    OutboundNetworkJitterMs: 0,
    InboundNetworkLossPercent: 0,
    OutboundNetworkLossPercent: 0,
  },
  good: {
    InboundNetworkMinDelayMs: 50,
    OutboundNetworkMinDelayMs: 50,
    InboundNetworkJitterMs: 10,
    OutboundNetworkJitterMs: 10,
    InboundNetworkLossPercent: 0,
    OutboundNetworkLossPercent: 0,
  },
  poor: {
    InboundNetworkMinDelayMs: 150,
    OutboundNetworkMinDelayMs: 150,
    InboundNetworkJitterMs: 100,
    OutboundNetworkJitterMs: 100,
    InboundNetworkLossPercent: 0.5,
    OutboundNetworkLossPercent: 0.5,
  },
};

const ZERO_NETWORK_PROFILE: Record<NetworkProfileKey, number> = {
  InboundNetworkMinDelayMs: 0,
  OutboundNetworkMinDelayMs: 0,
  InboundNetworkJitterMs: 0,
  OutboundNetworkJitterMs: 0,
  InboundNetworkLossPercent: 0,
  OutboundNetworkLossPercent: 0,
};

const SIMULATION_PERSISTENCE_NOTES = [
  'Normal Play client changes can write back to edit state.',
  'Multiplayer clients inherit baseline at startup but are isolated afterward.',
  'StudioTestService client device simulator state may appear stale on fresh clients, so reset after client startup is required.',
];

function normalizeNetworkProfile(profile: string, overrides?: Record<string, unknown>): NetworkProfileValues {
  if (!['great', 'good', 'poor', 'custom'].includes(profile)) {
    throw new Error('profile must be "great", "good", "poor", or "custom"');
  }

  const values: NetworkProfileValues = profile === 'custom'
    ? {}
    : { ...NETWORK_PROFILES[profile as 'great' | 'good' | 'poor'] };

  if (overrides !== undefined) {
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
      throw new Error('overrides must be an object when provided');
    }
    const allowed = new Set<string>(NETWORK_PROFILE_KEYS);
    for (const [key, value] of Object.entries(overrides)) {
      if (!allowed.has(key)) {
        throw new Error(`Unsupported network override "${key}". Allowed: ${NETWORK_PROFILE_KEYS.join(', ')}`);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Network override "${key}" must be a finite number`);
      }
      if (value < 0) {
        throw new Error(`Network override "${key}" must be greater than or equal to 0`);
      }
      if ((key === 'InboundNetworkLossPercent' || key === 'OutboundNetworkLossPercent') && value > MAX_NETWORK_PACKET_LOSS_PERCENT) {
        throw new Error(`Network override "${key}" cannot exceed ${MAX_NETWORK_PACKET_LOSS_PERCENT}; Roblox engine limits packet loss simulation to 0.5%.`);
      }
      values[key as NetworkProfileKey] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    throw new Error('custom profile requires at least one override');
  }

  return values;
}

function buildNetworkProfileLuau(profile: string, values: NetworkProfileValues): string {
  const valuesJson = JSON.stringify(values);
  const keysJson = JSON.stringify(NETWORK_PROFILE_KEYS);
  return `
local HttpService = game:GetService("HttpService")
local ns = settings():GetService("NetworkSettings")
local keys = HttpService:JSONDecode(${JSON.stringify(keysJson)})
local desired = HttpService:JSONDecode(${JSON.stringify(valuesJson)})
local before = {}
for _, key in ipairs(keys) do
\tbefore[key] = ns[key]
end
for key, value in pairs(desired) do
\tns[key] = value
end
local after = {}
for _, key in ipairs(keys) do
\tafter[key] = ns[key]
end
return HttpService:JSONEncode({
\tprofile = ${JSON.stringify(profile)},
\tapplied = desired,
\tbefore = before,
\tafter = after,
})
`.trim();
}

function buildNetworkStateLuau(operation: 'get' | 'reset'): string {
  const keysJson = JSON.stringify(NETWORK_PROFILE_KEYS);
  const resetJson = JSON.stringify(ZERO_NETWORK_PROFILE);
  return `
local HttpService = game:GetService("HttpService")
local ns = settings():GetService("NetworkSettings")
local operation = ${JSON.stringify(operation)}
local keys = HttpService:JSONDecode(${JSON.stringify(keysJson)})
local resetValues = HttpService:JSONDecode(${JSON.stringify(resetJson)})

local function readState()
\tlocal state = {}
\tfor _, key in ipairs(keys) do
\t\tstate[key] = ns[key]
\tend
\treturn state
end

if operation == "get" then
\treturn HttpService:JSONEncode({
\t\tsuccess = true,
\t\tstate = readState(),
\t})
end

if operation == "reset" then
\tlocal before = readState()
\tfor key, value in pairs(resetValues) do
\t\tns[key] = value
\tend
\treturn HttpService:JSONEncode({
\t\tsuccess = true,
\t\tapplied = resetValues,
\t\tbefore = before,
\t\tafter = readState(),
\t})
end

error("Unsupported network simulation operation: " .. tostring(operation), 0)
`.trim();
}

function normalizeDeviceSimulatorResolution(value: unknown): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('resolution must be an object with positive integer width and height');
  }
  const resolution = value as { width?: unknown; height?: unknown };
  const width = resolution.width;
  const height = resolution.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) <= 0 || (height as number) <= 0) {
    throw new Error('resolution.width and resolution.height must be positive integers');
  }
  return { width: width as number, height: height as number };
}

function normalizeDeviceSimulatorSettings(input: {
  deviceId?: unknown;
  orientation?: unknown;
  resolution?: unknown;
  pixelDensity?: unknown;
  scalingMode?: unknown;
}): DeviceSimulatorSettings {
  const settings: DeviceSimulatorSettings = {};

  if (input.deviceId !== undefined) {
    if (typeof input.deviceId !== 'string' || input.deviceId.trim() === '') {
      throw new Error('deviceId must be a non-empty string');
    }
    settings.deviceId = input.deviceId;
  }

  if (input.orientation !== undefined) {
    if (typeof input.orientation !== 'string' || input.orientation.trim() === '') {
      throw new Error('orientation must be a non-empty string');
    }
    settings.orientation = input.orientation;
  }

  const resolution = normalizeDeviceSimulatorResolution(input.resolution);
  if (resolution !== undefined) settings.resolution = resolution;

  if (input.pixelDensity !== undefined) {
    if (typeof input.pixelDensity !== 'number' || !Number.isFinite(input.pixelDensity) || input.pixelDensity <= 0) {
      throw new Error('pixelDensity must be a positive finite number');
    }
    settings.pixelDensity = input.pixelDensity;
  }

  if (input.scalingMode !== undefined) {
    if (typeof input.scalingMode !== 'string' || input.scalingMode.trim() === '') {
      throw new Error('scalingMode must be a non-empty string');
    }
    settings.scalingMode = input.scalingMode;
  }

  return settings;
}

function hasDeviceSimulatorSettings(settings: DeviceSimulatorSettings): boolean {
  return settings.deviceId !== undefined ||
    settings.orientation !== undefined ||
    settings.resolution !== undefined ||
    settings.pixelDensity !== undefined ||
    settings.scalingMode !== undefined;
}

function buildDeviceSimulatorLuau(operation: 'get' | 'set', options: Record<string, unknown>): string {
  const payload = JSON.stringify({ operation, ...options });
  return `
local HttpService = game:GetService("HttpService")
local simulator = game:GetService("StudioDeviceSimulatorService")
local opts = HttpService:JSONDecode(${JSON.stringify(payload)})

local function plain(value)
\tlocal valueType = typeof(value)
\tif valueType == "Vector2" then
\t\treturn { x = value.X, y = value.Y, width = value.X, height = value.Y }
\tend
\tif valueType == "EnumItem" then
\t\treturn value.Name
\tend
\tif type(value) == "table" then
\t\tlocal out = {}
\t\tfor k, v in pairs(value) do
\t\t\tout[tostring(k)] = plain(v)
\t\tend
\t\treturn out
\tend
\treturn value
end

local function getDeviceInfo(deviceId)
\tlocal ok, info = pcall(function()
\t\treturn simulator:GetDeviceInfoAsync(deviceId)
\tend)
\tif ok then
\t\treturn plain(info), nil
\tend
\treturn nil, tostring(info)
end

local function normalizeDeviceList(rawList)
\tlocal devices = {}
\tlocal ids = {}
\tfor _, entry in ipairs(rawList) do
\t\tlocal item
\t\tlocal id
\t\tif type(entry) == "table" then
\t\t\titem = plain(entry)
\t\t\tid = item.DeviceId or item.deviceId or item.Id or item.id or item[1]
\t\telse
\t\t\tid = tostring(entry)
\t\t\titem = { DeviceId = id }
\t\tend
\t\tif id ~= nil then
\t\t\tid = tostring(id)
\t\t\tlocal info = getDeviceInfo(id)
\t\t\tif type(info) == "table" then
\t\t\t\titem = info
\t\t\t\tif item.DeviceId == nil then item.DeviceId = id end
\t\t\tend
\t\t\tif item.IsCustom ~= true then
\t\t\t\tids[id] = true
\t\t\t\ttable.insert(devices, item)
\t\t\tend
\t\tend
\tend
\treturn devices, ids
end

local function getDeviceList()
\tlocal rawList = simulator:GetDeviceListAsync()
\treturn normalizeDeviceList(rawList)
end

local function assertBuiltInDeviceExists(deviceId)
\tlocal _, ids = getDeviceList()
\tif ids[deviceId] then return end
\tlocal available = {}
\tfor id in pairs(ids) do table.insert(available, id) end
\ttable.sort(available)
\terror('deviceId "' .. tostring(deviceId) .. '" is not an available built-in device. Use get_device_simulator_state to list supported device IDs. Available: ' .. table.concat(available, ", "), 0)
end

local function enumByName(enumType, raw, label)
\tlocal name = tostring(raw)
\tname = string.match(name, "([^%.]+)$") or name
\tlocal available = {}
\tfor _, item in ipairs(enumType:GetEnumItems()) do
\t\ttable.insert(available, item.Name)
\t\tif item.Name == name then
\t\t\treturn item, item.Name
\t\tend
\tend
\terror(label .. ' "' .. tostring(raw) .. '" is not valid. Available: ' .. table.concat(available, ", "), 0)
end

local function tryActiveGetter(state, key, fn)
\tlocal ok, value = pcall(fn)
\tif ok then
\t\tstate[key] = plain(value)
\telse
\t\tstate.unavailable = state.unavailable or {}
\t\tstate.unavailable[key] = tostring(value)
\tend
end

local function readState(includeDeviceList, requestedDeviceId)
\tlocal activeDeviceId = tostring(simulator:GetDeviceAsync())
\tlocal state = {
\t\tactiveDeviceId = activeDeviceId,
\t\tisSimulating = activeDeviceId ~= "default",
\t}

\tif includeDeviceList then
\t\tlocal devices = getDeviceList()
\t\tstate.devices = devices
\tend

\tif requestedDeviceId ~= nil then
\t\tassertBuiltInDeviceExists(requestedDeviceId)
\t\tstate.deviceInfo = plain(simulator:GetDeviceInfoAsync(requestedDeviceId))
\tend

\tif state.isSimulating then
\t\ttryActiveGetter(state, "resolution", function() return simulator:GetResolutionAsync() end)
\t\ttryActiveGetter(state, "pixelDensity", function() return simulator:GetPixelDensityAsync() end)
\t\ttryActiveGetter(state, "orientation", function() return simulator:GetOrientationAsync() end)
\t\ttryActiveGetter(state, "scalingMode", function() return simulator:GetScalingModeAsync() end)
\tend

\treturn state
end

local function applySettings(settings)
\tlocal applied = {}
\tif settings.deviceId ~= nil then
\t\tassertBuiltInDeviceExists(settings.deviceId)
\t\tsimulator:SetDeviceAsync(settings.deviceId)
\t\tapplied.deviceId = settings.deviceId
\tend
\tif settings.orientation ~= nil then
\t\tlocal item, name = enumByName(Enum.ScreenOrientation, settings.orientation, "orientation")
\t\tsimulator:SetOrientationAsync(item)
\t\tapplied.orientation = name
\tend
\tif settings.resolution ~= nil then
\t\tsimulator:SetResolutionAsync(settings.resolution.width, settings.resolution.height)
\t\tapplied.resolution = { width = settings.resolution.width, height = settings.resolution.height }
\tend
\tif settings.pixelDensity ~= nil then
\t\tsimulator:SetPixelDensityAsync(settings.pixelDensity)
\t\tapplied.pixelDensity = settings.pixelDensity
\tend
\tif settings.scalingMode ~= nil then
\t\tlocal item, name = enumByName(Enum.DeviceSimulatorScalingMode, settings.scalingMode, "scalingMode")
\t\tsimulator:SetScalingModeAsync(item)
\t\tapplied.scalingMode = name
\tend
\treturn applied
end

if opts.operation == "get" then
\treturn readState(opts.includeDeviceList ~= false, opts.deviceId)
end

if opts.operation == "set" then
\tlocal before = readState(false, nil)
\tlocal applied
\tif opts.stopSimulation == true then
\t\tsimulator:StopSimulationAsync()
\t\tapplied = { stopSimulation = true }
\telse
\t\tapplied = applySettings(opts.settings or {})
\tend
\treturn {
\t\tsuccess = true,
\t\tapplied = applied,
\t\tbefore = before,
\t\tafter = readState(false, nil),
\t}
end

error("Unsupported device simulator operation: " .. tostring(opts.operation), 0)
`.trim();
}

export class RobloxStudioTools {
  private client: StudioHttpClient;
  private bridge: BridgeService;
  private openCloudClient: OpenCloudClient;
  private cookieClient: RobloxCookieClient;
  private instanceManager: StudioInstanceManager;
  private managedConnectionAssociations: Promise<void> = Promise.resolve();

  constructor(bridge: BridgeService) {
    this.client = new StudioHttpClient(bridge);
    this.bridge = bridge;
    this.openCloudClient = new OpenCloudClient();
    this.cookieClient = new RobloxCookieClient();
    this.instanceManager = new StudioInstanceManager();
    this.bridge.onInstanceRegistered((instance) => {
      const instanceManager = this.instanceManager;
      const association = this.managedConnectionAssociations.then(() =>
        this._associateManagedEditConnection(instance, instanceManager),
      );
      this.managedConnectionAssociations = association.catch((error) => {
        console.warn(
          `[robloxstudio-mcp] managed Studio connection association failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  getStudioLifecycleCapabilities() {
    return this.instanceManager.getLifecycleCapabilities();
  }

  private _textResult(body: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async getRobloxSkills(action: string, name?: string) {
    if (action !== 'list' && action !== 'get') {
      throw new Error('get_roblox_skills action must be "list" or "get"');
    }

    const bundle = loadBuiltInStudioSkills();
    const bundleMetadata = {
      source: 'installed-studio-assistant',
      studioVersion: bundle.studioVersion,
      bundlePath: bundle.bundlePath,
      bundleModifiedAt: bundle.bundleModifiedAt,
      bundleSha256: bundle.bundleSha256,
    };

    if (action === 'list') {
      return this._textResult({
        action,
        ...bundleMetadata,
        count: bundle.skills.length,
        skills: bundle.skills.map((skill) => ({
          name: skill.name,
          sourceName: skill.sourceName,
          description: skill.description,
          document: skill.document,
          hasCombinedDocument: skill.hasCombinedDocument,
          contentLength: skill.contentLength,
          contentSha256: skill.contentSha256,
        })),
      });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('get_roblox_skills action="get" requires a skill name from action="list"');
    }
    const skill = findBuiltInStudioSkill(bundle, name);
    if (!skill) {
      throw new Error(
        `Built-in Studio skill "${name}" was not found. Available skills: ` +
        bundle.skills.map((candidate) => candidate.name).join(', '),
      );
    }
    return this._textResult({
      action,
      ...bundleMetadata,
      skill,
    });
  }

  async getRobloxDocs(name: string, docType?: string, section?: string) {
    if (!name || typeof name !== 'string') {
      throw new Error('get_roblox_docs requires a name (e.g. "ProximityPrompt")');
    }
    const category = docType ?? 'classes';
    if (!isDocCategory(category)) {
      throw new Error(`Invalid doc_type "${category}". Valid categories: ${DOC_CATEGORIES.join(', ')}`);
    }
    const result = await getRobloxDoc(category, name.trim(), section);
    return { content: [{ type: 'text', text: result.content }] };
  }

  private _parseTextResult(result: any): Record<string, any> {
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private _briefRoles(instanceId: string, equivalentInstances = false): { roles: string[]; runtimeRoles: string[] } {
    const roles = equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId);
    return {
      roles,
      runtimeRoles: roles.filter((role) => role === 'server' || /^client-\d+$/.test(role)),
    };
  }

  // Resolve (instance_id, target-role) → concrete (instanceId, role) and
  // dispatch a single request. Throws RoutingFailure if the resolution is
  // ambiguous, missing, or asks for fanout on a non-fanout-capable tool —
  // the MCP transport layer surfaces it as a structured error result so
  // the LLM can recover via the embedded data.instances list.
  private async _callSingle(
    endpoint: string,
    data: any,
    target: string | undefined,
    instance_id: string | undefined,
    timeoutMs?: number,
  ): Promise<any> {
    // Pass target through as-is so resolveTarget can tell "caller didn't
    // specify" (target=undefined → multiple_instances_connected) apart
    // from "caller picked edit explicitly" (target='edit' → ambiguous_target).
    // Tools that intrinsically need a specific role pass it as a string
    // literal here; tools without a target arg pass undefined.
    const r = this.bridge.resolveTarget({ instance_id, target });
    if (!r.ok) throw new RoutingFailure(r.error);
    if (r.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    return this.client.request(endpoint, data, r.targetInstanceId, r.targetRole, timeoutMs);
  }

  // Resolves which connected place a tool should target and whether a playtest
  // CLIENT peer is present on it. Used by capture/input to auto-route to the
  // running client (where the live viewport + input pipeline are) without the
  // caller having to pass target. Throws RoutingFailure with the standard
  // instance list if the place is ambiguous (multiple connected, no instance_id).
  private _resolveRuntime(instance_id?: string): { instanceId: string; clientRole?: string } {
    const r = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!r.ok) throw new RoutingFailure(r.error);
    // resolveTarget(target=undefined) prefers the edit role and always returns
    // a single target, so targetInstanceId is the resolved place.
    const resolvedId = (r as { targetInstanceId: string }).targetInstanceId;
    const equivalentIds = new Set(this.bridge.getEquivalentInstanceIds(resolvedId));
    const instances = this.bridge
      .getInstances()
      .filter((i) => equivalentIds.has(i.instanceId));
    // Prefer client-1 when several clients are connected (multi-client playtest).
    const client = instances
      .filter((inst) => inst.role.startsWith('client'))
      .sort((a, b) => a.role.localeCompare(b.role))[0];
    return { instanceId: client?.instanceId ?? resolvedId, clientRole: client?.role };
  }

  private _resolveInstanceIdOnly(instance_id?: string): string {
    const instances = this.bridge.getInstances();
    const publicList = this.bridge.getPublicInstances();
    const errorData = { instances: publicList, count: publicList.length };

    if (instance_id !== undefined) {
      const resolvedInstanceId = this.bridge.resolveInstanceId(instance_id);
      if (!instances.some((i) => i.instanceId === resolvedInstanceId)) {
        throw new RoutingFailure({
          code: 'unrecognized_instance_id',
          message: `instance_id "${instance_id}" is not connected. Pass one from data.instances.`,
          data: errorData,
        });
      }
      return resolvedInstanceId;
    }

    const distinct = Array.from(new Set(instances.map((i) => i.instanceId)));
    if (distinct.length === 0) {
      throw new RoutingFailure({
        code: 'unrecognized_instance_id',
        message: 'No Studio plugin is connected.',
        data: errorData,
      });
    }
    if (distinct.length > 1) {
      throw new RoutingFailure({
        code: 'multiple_instances_connected',
        message: 'Multiple Studio places are connected. Pass instance_id to disambiguate.',
        data: errorData,
      });
    }
    return distinct[0];
  }

  private _resolveSingleTarget(target: string, instance_id?: string): { instanceId: string; role: string } {
    const resolved = this.bridge.resolveTarget({ instance_id, target });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'Pick a specific target role for this tool.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    return { instanceId: resolved.targetInstanceId, role: resolved.targetRole };
  }

  private _rolesForInstance(instanceId: string): string[] {
    return this.bridge.getInstances()
      .filter((i) => i.instanceId === instanceId)
      .map((i) => i.role);
  }

  private _rolesForEquivalentInstances(instanceId: string): string[] {
    const instanceIds = new Set(this.bridge.getEquivalentInstanceIds(instanceId));
    return this.bridge.getInstances()
      .filter((i) => instanceIds.has(i.instanceId))
      .map((i) => i.role);
  }

  private _clientRolesForInstance(instanceId: string): string[] {
    return this._rolesForInstance(instanceId)
      .filter((role) => /^client-\d+$/.test(role))
      .sort((a, b) => Number(a.slice('client-'.length)) - Number(b.slice('client-'.length)));
  }

  private _runtimeTargetsForEquivalentInstances(instanceId: string): { instanceId: string; role: string }[] {
    const instanceIds = new Set(this.bridge.getEquivalentInstanceIds(instanceId));
    return this.bridge.getInstances()
      .filter((i) => instanceIds.has(i.instanceId) && (i.role === 'server' || /^client-\d+$/.test(i.role)))
      .map((i) => ({ instanceId: i.instanceId, role: i.role }));
  }

  private _compactSimulationResetResult(result: Record<string, unknown>): Record<string, unknown> {
    const compact: Record<string, unknown> = {};
    if ('network' in result) compact.network = true;
    if ('deviceSimulator' in result) compact.deviceSimulator = true;
    if (result.errors !== undefined) compact.errors = result.errors;
    return compact;
  }

  private _resolveDeviceSimulatorSingleTarget(
    target: string | undefined,
    instance_id: string | undefined,
    toolName: string,
  ): { instanceId: string; role: string; selectedTarget: string } {
    const selectedTarget = target ?? 'edit';
    if (selectedTarget === 'server' || selectedTarget === 'all' || selectedTarget === 'all-clients' || selectedTarget === 'edit-proxy') {
      throw new Error(`${toolName} target must be "edit" or "client-N" (got: ${selectedTarget})`);
    }
    if (selectedTarget !== 'edit' && !/^client-\d+$/.test(selectedTarget)) {
      throw new Error(`${toolName} target must be "edit" or "client-N" (got: ${selectedTarget})`);
    }
    const resolved = this._resolveSingleTarget(selectedTarget, instance_id);
    return { ...resolved, selectedTarget };
  }

  private _resolveDeviceSimulatorSetTargets(
    target: string | undefined,
    instance_id: string | undefined,
  ): { instanceId: string; selectedTarget: string; roles: string[] } {
    const selectedTarget = target ?? 'edit';
    if (selectedTarget === 'all-clients') {
      const instanceId = this._resolveInstanceIdOnly(instance_id);
      const roles = this._clientRolesForInstance(instanceId);
      if (roles.length === 0) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no connected playtest client roles. Start a playtest first.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      return { instanceId, selectedTarget, roles };
    }

    const resolved = this._resolveDeviceSimulatorSingleTarget(selectedTarget, instance_id, 'set_device_simulator');
    return { instanceId: resolved.instanceId, selectedTarget, roles: [resolved.role] };
  }

  private _normalizeSimulationInclude(include: string | undefined): SimulationInclude {
    const selectedInclude = include ?? 'both';
    if (selectedInclude !== 'network' && selectedInclude !== 'deviceSimulator' && selectedInclude !== 'both') {
      throw new Error(`get_simulation_state include must be "network", "deviceSimulator", or "both" (got: ${selectedInclude})`);
    }
    return selectedInclude;
  }

  private _resolveSimulationTargets(
    target: string | undefined,
    instance_id: string | undefined,
    toolName: string,
  ): { instanceId: string; selectedTarget: string; roles: string[]; warnings: string[] } {
    const selectedTarget = target ?? 'edit-and-clients';
    if (selectedTarget === 'server' || selectedTarget === 'all' || selectedTarget === 'edit-proxy') {
      throw new Error(`${toolName} target must be "edit", "client-N", "all-clients", or "edit-and-clients" (got: ${selectedTarget})`);
    }

    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const connectedRoles = this._rolesForInstance(instanceId);
    const clientRoles = this._clientRolesForInstance(instanceId);
    const warnings: string[] = [];
    let roles: string[];

    if (selectedTarget === 'edit') {
      if (!connectedRoles.includes('edit')) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "edit". Available roles: ${connectedRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      roles = ['edit'];
    } else if (selectedTarget === 'all-clients') {
      roles = clientRoles;
      if (roles.length === 0) {
        warnings.push(`No connected playtest client roles found for instance "${instanceId}".`);
      }
    } else if (selectedTarget === 'edit-and-clients') {
      roles = [];
      if (connectedRoles.includes('edit')) {
        roles.push('edit');
      } else {
        warnings.push(`No edit role found for instance "${instanceId}".`);
      }
      roles.push(...clientRoles);
    } else if (/^client-\d+$/.test(selectedTarget)) {
      if (!clientRoles.includes(selectedTarget)) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "${selectedTarget}". Available client roles: ${clientRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      roles = [selectedTarget];
    } else {
      throw new Error(`${toolName} target must be "edit", "client-N", "all-clients", or "edit-and-clients" (got: ${selectedTarget})`);
    }

    return { instanceId, selectedTarget, roles, warnings };
  }

  private _parseExecuteLuauJsonResponse(response: unknown, toolName: string): unknown {
    const r = response as { success?: boolean; error?: string; message?: string; returnValue?: unknown };
    if (r?.success === false) {
      throw new Error(r.error || r.message || `${toolName} Luau execution failed`);
    }
    if (typeof r?.returnValue !== 'string') {
      return response;
    }
    if (r.returnValue === '') {
      return {};
    }
    try {
      return JSON.parse(r.returnValue);
    } catch {
      throw new Error(`${toolName} returned non-JSON data: ${r.returnValue}`);
    }
  }

  private async _executeNetworkStateOperation(
    instanceId: string,
    role: string,
    operation: 'get' | 'reset',
  ): Promise<unknown> {
    const code = buildNetworkStateLuau(operation);
    const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
    return this._parseExecuteLuauJsonResponse(response, `network simulation ${operation}`);
  }

  private async _executeDeviceSimulatorOperation(
    instanceId: string,
    role: string,
    operation: 'get' | 'set',
    options: Record<string, unknown>,
  ): Promise<unknown> {
    const code = buildDeviceSimulatorLuau(operation, options);
    const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
    return this._parseExecuteLuauJsonResponse(response, `device simulator ${operation}`);
  }

  private _settingsFromDeviceSimulatorState(state: unknown): DeviceSimulatorSettings | { stopSimulation: true } {
    const s = state as {
      isSimulating?: boolean;
      activeDeviceId?: unknown;
      orientation?: unknown;
      resolution?: unknown;
      pixelDensity?: unknown;
      scalingMode?: unknown;
    };
    if (!s || s.isSimulating !== true || typeof s.activeDeviceId !== 'string' || s.activeDeviceId === 'default') {
      return { stopSimulation: true };
    }
    return normalizeDeviceSimulatorSettings({
      deviceId: s.activeDeviceId,
      orientation: s.orientation,
      resolution: s.resolution,
      pixelDensity: s.pixelDensity,
      scalingMode: s.scalingMode,
    });
  }

  private _deviceSimulatorStateWithoutDeviceList(state: unknown): unknown {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return state;
    }
    const rest = { ...(state as Record<string, unknown>) };
    delete rest.devices;
    return rest;
  }

  private _assertCanRestoreDeviceSimulatorState(state: unknown): void {
    const s = state as {
      isSimulating?: boolean;
      activeDeviceId?: unknown;
      devices?: unknown;
    };
    if (!s || s.isSimulating !== true || typeof s.activeDeviceId !== 'string' || s.activeDeviceId === 'default') {
      return;
    }
    const devices = Array.isArray(s.devices) ? s.devices : [];
    const isBuiltIn = devices.some((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
      const device = entry as { DeviceId?: unknown; deviceId?: unknown; Id?: unknown; id?: unknown; IsCustom?: unknown };
      const id = device.DeviceId ?? device.deviceId ?? device.Id ?? device.id;
      return id === s.activeDeviceId && device.IsCustom !== true;
    });
    if (!isBuiltIn) {
      throw new Error(
        `capture_device_matrix cannot safely restore active custom device "${s.activeDeviceId}". ` +
        'Switch the simulator to default or a built-in preset first, or pass restoreAfter=false only if you intentionally accept changing the simulator state.',
      );
    }
  }

  private async _waitForRuntimeRoles(
    instanceId: string,
    opts: { server?: boolean; clientCount?: number; absentRole?: string; noRuntime?: boolean },
    timeoutSec = 30,
    equivalentInstances = false,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const roles = equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId);
      const clientRoles = equivalentInstances
        ? roles.filter((role) => /^client-\d+$/.test(role))
        : this._clientRolesForInstance(instanceId);
      const hasServer = !opts.server || roles.includes('server');
      const hasClients = opts.clientCount === undefined || clientRoles.length >= opts.clientCount;
      const absent = opts.absentRole === undefined || !roles.includes(opts.absentRole);
      const runtimeAbsent = !opts.noRuntime || !roles.some((role) => role === 'server' || /^client-\d+$/.test(role));
      if (hasServer && hasClients && absent && runtimeAbsent) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return {
      ok: false,
      roles: equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId),
      timedOut: true,
    };
  }

  private async _waitForExactClientCount(
    instanceId: string,
    expectedClientCount: number,
    timeoutSec = 30,
    stableMs = 3000,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; extraClients: boolean; clientCount: number }> {
    const deadline = Date.now() + timeoutSec * 1000;
    let exactSince: number | undefined;

    while (Date.now() < deadline) {
      const roles = this._rolesForInstance(instanceId);
      const clientCount = this._clientRolesForInstance(instanceId).length;
      if (clientCount > expectedClientCount) {
        return { ok: false, roles, timedOut: false, extraClients: true, clientCount };
      }
      if (roles.includes('server') && clientCount === expectedClientCount) {
        exactSince ??= Date.now();
        if (Date.now() - exactSince >= stableMs) {
          return { ok: true, roles, timedOut: false, extraClients: false, clientCount };
        }
      } else {
        exactSince = undefined;
      }
      await sleep(250);
    }

    const roles = this._rolesForInstance(instanceId);
    const clientCount = this._clientRolesForInstance(instanceId).length;
    return { ok: false, roles, timedOut: true, extraClients: clientCount > expectedClientCount, clientCount };
  }

  private async _waitForRuntimeRolesFresh(
    instanceId: string,
    connectedAfter: number,
    requiredRoles: string[],
    timeoutSec = 60,
    equivalentInstances = false,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const instanceIds = equivalentInstances ? new Set(this.bridge.getEquivalentInstanceIds(instanceId)) : new Set([instanceId]);
      const instances = this.bridge.getInstances().filter((i) => instanceIds.has(i.instanceId));
      const roles = instances.map((i) => i.role);
      const freshRoles = new Set(
        instances
          .filter((i) => i.connectedAt >= connectedAfter)
          .map((i) => i.role),
      );
      if (requiredRoles.every((role) => freshRoles.has(role))) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return {
      ok: false,
      roles: equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId),
      timedOut: true,
    };
  }


  async getFileTree(path: string = '', instance_id?: string) {
    const response = await this._callSingle('/api/file-tree', { path }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async searchFiles(query: string, searchType: string = 'name', instance_id?: string) {
    const response = await this._callSingle('/api/search-files', { query, searchType }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getPlaceInfo(instance_id?: string) {
    const response = await this._callSingle('/api/place-info', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async searchObjects(query: string, searchType: string = 'name', propertyName?: string, instance_id?: string) {
    const response = await this._callSingle('/api/search-objects', {
      query,
      searchType,
      propertyName
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getInstanceProperties(instancePath: string, excludeSource?: boolean, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_instance_properties');
    }
    const response = await this._callSingle('/api/instance-properties', { instancePath, excludeSource }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async searchByProperty(propertyName: string, propertyValue: string, instance_id?: string) {
    if (!propertyName || !propertyValue) {
      throw new Error('Property name and value are required for search_by_property');
    }
    const response = await this._callSingle('/api/search-by-property', {
      propertyName,
      propertyValue
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getClassInfo(className: string, instance_id?: string) {
    if (!className) {
      throw new Error('Class name is required for get_class_info');
    }
    const response = await this._callSingle('/api/class-info', { className }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getProjectStructure(path?: string, maxDepth?: number, scriptsOnly?: boolean, instance_id?: string) {
    const response = await this._callSingle('/api/project-structure', {
      path,
      maxDepth,
      scriptsOnly
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async setProperties(instancePath: string, properties: Record<string, any>, instance_id?: string) {
    if (!instancePath || !properties) {
      throw new Error('instancePath and properties are required for set_properties');
    }
    const response = await this._callSingle('/api/set-properties', { instancePath, properties }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }


  async getScriptSource(instancePath: string, startLine?: number, endLine?: number, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_script_source');
    }
    const response = await this._callSingle('/api/get-script-source', { instancePath, startLine, endLine }, undefined, instance_id);

    if (response.error) {
      return this._textResult({ error: response.error });
    }
    const pathStr = (response.instancePath as string) || instancePath;
    const showRange = Boolean(response.isPartial || response.truncated)
      && response.startLine !== undefined
      && response.endLine !== undefined;
    return this._textResult({
      path: pathStr,
      className: response.className,
      lineCount: response.lineCount,
      ...(showRange ? { startLine: response.startLine, endLine: response.endLine } : {}),
      ...(response.enabled === false ? { enabled: false } : {}),
      ...(response.truncated ? { truncated: true } : {}),
      ...(typeof response.note === 'string' && response.note.length > 0 ? { note: response.note } : {}),
      source: response.numberedSource || response.source,
    });
  }

  async setScriptSource(instancePath: string, source: string, instance_id?: string) {
    if (!instancePath || typeof source !== 'string') {
      throw new Error('Instance path and source code string are required for set_script_source');
    }
    const response = await this._callSingle('/api/set-script-source', { instancePath, source }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async editScriptLines(instancePath: string, oldString: string, newString: string, startLine?: number, instance_id?: string) {
    if (!instancePath || typeof oldString !== 'string' || typeof newString !== 'string') {
      throw new Error('Instance path, old_string, and new_string are required for edit_script_lines');
    }
    const payload: Record<string, unknown> = { instancePath, old_string: oldString, new_string: newString };
    if (startLine !== undefined) payload.startLine = startLine;
    const response = await this._callSingle('/api/edit-script-lines', payload, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async insertScriptLines(instancePath: string, afterLine: number, newContent: string, instance_id?: string) {
    if (!instancePath || typeof newContent !== 'string') {
      throw new Error('Instance path and newContent are required for insert_script_lines');
    }
    const response = await this._callSingle('/api/insert-script-lines', { instancePath, afterLine: afterLine || 0, newContent }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async deleteScriptLines(instancePath: string, startLine: number, endLine: number, instance_id?: string) {
    if (!instancePath || !startLine || !endLine) {
      throw new Error('Instance path, startLine, and endLine are required for delete_script_lines');
    }
    const response = await this._callSingle('/api/delete-script-lines', { instancePath, startLine, endLine }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async grepScripts(
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      contextLines?: number;
      maxResults?: number;
      maxResultsPerScript?: number;
      filesOnly?: boolean;
      path?: string;
      classFilter?: string;
    },
    instance_id?: string
  ) {
    if (!pattern) {
      throw new Error('Pattern is required for grep_scripts');
    }
    const response = await this._callSingle('/api/grep-scripts', {
      pattern,
      ...(options ?? {}),
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getAttributes(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_attributes');
    }
    const response = await this._callSingle('/api/get-attributes', { instancePath }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getSelection(instance_id?: string) {
    const response = await this._callSingle('/api/get-selection', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async executeLuau(code: string, target?: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for execute_luau');
    }
    const response = await this._callSingle('/api/execute-luau', { code }, target || 'edit', instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalServerRuntime(code: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for eval_server_runtime');
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, 'server', instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalClientRuntime(code: string, target?: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for eval_client_runtime');
    }
    const clientTarget = target || 'client-1';
    if (!clientTarget.startsWith('client-')) {
      throw new Error(`eval_client_runtime requires target=client-N (got: ${clientTarget})`);
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, clientTarget, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async setNetworkProfile(profile: string, target?: string, overrides?: Record<string, unknown>, instance_id?: string) {
    const values = normalizeNetworkProfile(profile, overrides);
    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const clientRoles = this._clientRolesForInstance(instanceId);
    const selectedTarget = target ?? 'client-1';

    let targetRoles: string[];
    if (selectedTarget === 'all-clients') {
      targetRoles = clientRoles;
    } else if (/^client-\d+$/.test(selectedTarget)) {
      if (!clientRoles.includes(selectedTarget)) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "${selectedTarget}". Available client roles: ${clientRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      targetRoles = [selectedTarget];
    } else {
      throw new Error(`set_network_profile target must be "client-N" or "all-clients" (got: ${selectedTarget})`);
    }

    if (targetRoles.length === 0) {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: `instance "${instanceId}" has no connected playtest client roles. Start a playtest first.`,
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }

    const code = buildNetworkProfileLuau(profile, values);
    const responses = await Promise.allSettled(
      targetRoles.map(async (role) => {
        const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
        const result = this._parseExecuteLuauJsonResponse(response, 'set_network_profile');
        return { role, result };
      }),
    );

    const body: Record<string, unknown> = {
      profile,
      target: selectedTarget,
      applied: values,
      targets: {},
    };
    const targetResults = body.targets as Record<string, unknown>;
    const failures: string[] = [];
    for (let i = 0; i < responses.length; i++) {
      const role = targetRoles[i];
      const response = responses[i];
      if (response.status === 'fulfilled') {
        targetResults[role] = response.value.result;
      } else {
        const message = errorMessage(response.reason);
        targetResults[role] = { error: message };
        failures.push(`${role}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`set_network_profile failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(body),
        },
      ],
    };
  }

  async getSimulationState(include?: string, target?: string, instance_id?: string) {
    const selectedInclude = this._normalizeSimulationInclude(include);
    const includeNetwork = selectedInclude === 'network' || selectedInclude === 'both';
    const includeDeviceSimulator = selectedInclude === 'deviceSimulator' || selectedInclude === 'both';
    const resolved = this._resolveSimulationTargets(target, instance_id, 'get_simulation_state');

    const roleEntries = await Promise.all(resolved.roles.map(async (role) => {
      const state: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (includeNetwork) {
        try {
          state.network = await this._executeNetworkStateOperation(resolved.instanceId, role, 'get');
        } catch (error) {
          errors.network = errorMessage(error);
        }
      }

      if (includeDeviceSimulator) {
        try {
          state.deviceSimulator = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            role,
            'get',
            { includeDeviceList: false },
          );
        } catch (error) {
          errors.deviceSimulator = errorMessage(error);
        }
      }

      if (Object.keys(errors).length > 0) {
        state.errors = errors;
      }
      return { role, state };
    }));

    const roles: Record<string, unknown> = {};
    for (const entry of roleEntries) {
      roles[entry.role] = entry.state;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          include: selectedInclude,
          target: resolved.selectedTarget,
          roles,
          warnings: resolved.warnings,
          persistenceNotes: SIMULATION_PERSISTENCE_NOTES,
        }),
      }],
    };
  }

  async resetSimulationState(target?: string, network?: boolean, deviceSimulator?: boolean, instance_id?: string) {
    const resetNetwork = network !== false;
    const resetDeviceSimulator = deviceSimulator !== false;
    if (!resetNetwork && !resetDeviceSimulator) {
      throw new Error('reset_simulation_state requires network=true and/or deviceSimulator=true; both default to true');
    }

    const resolved = this._resolveSimulationTargets(target, instance_id, 'reset_simulation_state');
    const roleEntries = await Promise.all(resolved.roles.map(async (role) => {
      const result: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (resetNetwork) {
        try {
          result.network = await this._executeNetworkStateOperation(resolved.instanceId, role, 'reset');
        } catch (error) {
          errors.network = errorMessage(error);
        }
      }

      if (resetDeviceSimulator) {
        try {
          result.deviceSimulator = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            role,
            'set',
            { stopSimulation: true },
          );
        } catch (error) {
          errors.deviceSimulator = errorMessage(error);
        }
      }

      if (Object.keys(errors).length > 0) {
        result.errors = errors;
      }
      return { role, result };
    }));

    const rawRoles: Record<string, unknown> = {};
    const roles: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const entry of roleEntries) {
      rawRoles[entry.role] = entry.result;
      roles[entry.role] = this._compactSimulationResetResult(entry.result);
      const errors = (entry.result as { errors?: Record<string, string> }).errors;
      if (errors) {
        for (const [kind, message] of Object.entries(errors)) {
          failures.push(`${entry.role}.${kind}: ${message}`);
        }
      }
    }

    const body = {
      success: true,
      target: resolved.selectedTarget,
      network: resetNetwork,
      deviceSimulator: resetDeviceSimulator,
      roles,
      warnings: resolved.warnings,
    };

    if (failures.length > 0) {
      throw new Error(`reset_simulation_state failed for ${failures.join('; ')}. Partial result: ${JSON.stringify({ ...body, roles: rawRoles })}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(body),
      }],
    };
  }

  async getDeviceSimulatorState(target?: string, deviceId?: string, includeDeviceList?: boolean, instance_id?: string) {
    if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.trim() === '')) {
      throw new Error('deviceId must be a non-empty string when provided');
    }
    const resolved = this._resolveDeviceSimulatorSingleTarget(target, instance_id, 'get_device_simulator_state');
    const state = await this._executeDeviceSimulatorOperation(
      resolved.instanceId,
      resolved.role,
      'get',
      {
        includeDeviceList: includeDeviceList !== false,
        deviceId,
      },
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          target: resolved.selectedTarget,
          role: resolved.role,
          ...(state as Record<string, unknown>),
        }),
      }],
    };
  }

  async setDeviceSimulator(
    target?: string,
    deviceId?: string,
    orientation?: string,
    resolution?: unknown,
    pixelDensity?: number,
    scalingMode?: string,
    stopSimulation?: boolean,
    instance_id?: string,
  ) {
    const settings = normalizeDeviceSimulatorSettings({ deviceId, orientation, resolution, pixelDensity, scalingMode });
    if (stopSimulation === true && hasDeviceSimulatorSettings(settings)) {
      throw new Error('stopSimulation=true cannot be combined with deviceId, orientation, resolution, pixelDensity, or scalingMode');
    }
    if (stopSimulation !== true && !hasDeviceSimulatorSettings(settings)) {
      throw new Error('set_device_simulator requires stopSimulation=true or at least one simulator setting');
    }

    const resolved = this._resolveDeviceSimulatorSetTargets(target, instance_id);
    const responses = await Promise.allSettled(
      resolved.roles.map(async (role) => {
        const result = await this._executeDeviceSimulatorOperation(
          resolved.instanceId,
          role,
          'set',
          stopSimulation === true ? { stopSimulation: true } : { settings },
        );
        return { role, result };
      }),
    );

    const body: Record<string, unknown> = {
      target: resolved.selectedTarget,
      targets: {},
    };
    const targets = body.targets as Record<string, unknown>;
    const failures: string[] = [];
    for (let i = 0; i < responses.length; i++) {
      const role = resolved.roles[i];
      const response = responses[i];
      if (response.status === 'fulfilled') {
        targets[role] = response.value.result;
      } else {
        const message = errorMessage(response.reason);
        targets[role] = { error: message };
        failures.push(`${role}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`set_device_simulator failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(body),
      }],
    };
  }

  async captureDeviceMatrix(
    entries: unknown,
    target?: string,
    format?: string,
    quality?: number,
    settleSeconds?: number,
    restoreAfter?: boolean,
    instance_id?: string,
  ) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('capture_device_matrix requires a non-empty entries array');
    }
    if (entries.length > MAX_DEVICE_MATRIX_ENTRIES) {
      throw new Error(`capture_device_matrix supports at most ${MAX_DEVICE_MATRIX_ENTRIES} entries per call; split larger matrices into multiple calls`);
    }

    const matrixEntries: DeviceSimulatorMatrixEntry[] = entries.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`entries[${index}] must be an object`);
      }
      const raw = entry as Record<string, unknown>;
      if (raw.label !== undefined && typeof raw.label !== 'string') {
        throw new Error(`entries[${index}].label must be a string when provided`);
      }
      return {
        ...normalizeDeviceSimulatorSettings({
          deviceId: raw.deviceId,
          orientation: raw.orientation,
          resolution: raw.resolution,
          pixelDensity: raw.pixelDensity,
          scalingMode: raw.scalingMode,
        }),
        label: raw.label as string | undefined,
      };
    });

    const resolved = this._resolveDeviceSimulatorSingleTarget(target, instance_id, 'capture_device_matrix');
    if (resolved.role.startsWith('client-') && await this._isMultiplayerTestRunning(resolved.instanceId)) {
      throw new Error('capture_device_matrix does not support StudioTestService multiplayer client targets because Roblox scopes temporary screenshot textures per client process');
    }

    const settleMs = settleSeconds === undefined ? 300 : Math.max(0, Math.floor(settleSeconds * 1000));
    const shouldRestore = restoreAfter !== false;
    const before = await this._executeDeviceSimulatorOperation(
      resolved.instanceId,
      resolved.role,
      'get',
      { includeDeviceList: shouldRestore },
    );
    if (shouldRestore) {
      this._assertCanRestoreDeviceSimulatorState(before);
    }

    const summary: Record<string, unknown> = {
      target: resolved.selectedTarget,
      role: resolved.role,
      restoreAfter: shouldRestore,
      before: this._deviceSimulatorStateWithoutDeviceList(before),
      entries: [],
    };
    const entrySummaries = summary.entries as Array<Record<string, unknown>>;
    const content: ToolContent[] = [];
    const failures: string[] = [];

    try {
      for (let i = 0; i < matrixEntries.length; i++) {
        const entry = matrixEntries[i];
        const label = entry.label ?? `entry-${i + 1}`;
        const entrySummary: Record<string, unknown> = {
          index: i,
          label,
          settings: entry,
        };
        entrySummaries.push(entrySummary);

        try {
          const settings = { ...entry };
          delete settings.label;
          const applied = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            resolved.role,
            'set',
            { settings },
          );
          entrySummary.applied = applied;
          if (settleMs > 0) await sleep(settleMs);

          const capture = await this._captureViewportImage(resolved.instanceId, resolved.role, format, quality);
          if (capture.success) {
            entrySummary.screenshot = {
              width: capture.width,
              height: capture.height,
              format: capture.format,
              quality: capture.quality,
              mimeType: capture.mimeType,
            };
            content.push({
              type: 'text',
              text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${capture.message}`,
            });
            content.push({
              type: 'image',
              data: capture.data,
              mimeType: capture.mimeType,
            });
          } else {
            entrySummary.error = capture.error;
            failures.push(`${label}: ${capture.error}`);
            content.push({
              type: 'text',
              text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${capture.error}`,
            });
          }
        } catch (error) {
          const message = errorMessage(error);
          entrySummary.error = message;
          failures.push(`${label}: ${message}`);
          content.push({
            type: 'text',
            text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${message}`,
          });
        }
      }
    } finally {
      if (shouldRestore) {
        try {
          const restoreSettings = this._settingsFromDeviceSimulatorState(before);
          if ('stopSimulation' in restoreSettings) {
            summary.restore = await this._executeDeviceSimulatorOperation(
              resolved.instanceId,
              resolved.role,
              'set',
              { stopSimulation: true },
            );
          } else {
            summary.restore = await this._executeDeviceSimulatorOperation(
              resolved.instanceId,
              resolved.role,
              'set',
              { settings: restoreSettings },
            );
          }
        } catch (error) {
          const message = errorMessage(error);
          summary.restoreError = message;
          failures.push(`restore: ${message}`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`capture_device_matrix failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(summary)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary),
        },
        ...content,
      ],
    };
  }

  async getRuntimeLogs(target?: string, since?: number, tail?: number, filter?: string, instance_id?: string) {
    // Per-capture in-memory log buffer (see studio-plugin RuntimeLogBuffer.ts).
    // target="all" (default) fans out to every connected instance except
    // edit-proxy (which has no buffer, just polls for stop-playtest), merges
    // by (ts, seq) and dedups same-message-and-level entries captured within
    // 2 seconds in different buffers. Ordinary Studio playtests reflect logs
    // across edit/server/client, so capturedBy is not a reliable origin peer;
    // only StudioTestService multiplayer sessions get a peer attribution.
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (since !== undefined) data.since = since;
    if (tail !== undefined) data.tail = tail;
    if (filter !== undefined) data.filter = filter;

    // Resolve once. Single mode → one request and pass-through. Fanout
    // mode → iterate the resolved (instanceId, role) tuples; results keyed
    // by role within the selected instance, so duplicate roles across
    // different places no longer collapse (the v2.11.x bug).
    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const originPeerReliable = await this._isMultiplayerTestRunning(resolved.targetInstanceId);
      const response = (await this.client.request(
        '/api/get-runtime-logs',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      )) as { capturedBy?: string; peer?: string; entries?: Array<{ capturedBy?: string; peer?: string }> } & Record<string, unknown>;
      // The plugin-side handler can only report generic "client" because the
      // client DM doesn't know its server-assigned client-N role. Normalize to
      // the resolved capture buffer, but do not claim script-origin peer unless
      // the selected place is running a StudioTestService multiplayer test.
      response.capturedBy = resolved.targetRole;
      delete response.peer;
      response.originPeerReliable = originPeerReliable;
      response.peerAttribution = originPeerReliable ? 'guaranteed_multiplayer' : 'unavailable_shared_logservice';
      if (originPeerReliable) response.peer = resolved.targetRole;
      if (Array.isArray(response.entries)) {
        for (const e of response.entries) {
          e.capturedBy = resolved.targetRole;
          delete e.peer;
          if (originPeerReliable) e.peer = resolved.targetRole;
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
      };
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    type PeerResponse = {
      capturedBy?: string;
      entries?: Entry[];
      totalDropped?: number;
      nextSince?: number;
      error?: string;
    };
    type Entry = {
      seq: number;
      ts: number;
      level: string;
      message: string;
      data?: Record<string, unknown>;
      capturedBy?: string;
      peer?: string;
    };
    const originPeerReliable = targets.length > 0
      ? await this._isMultiplayerTestRunning(targets[0].targetInstanceId)
      : false;

    const responses = await Promise.allSettled(
      targets.map(async (t) => {
        const r = (await this.client.request(
          '/api/get-runtime-logs',
          data,
          t.targetInstanceId,
          t.targetRole,
        )) as PeerResponse;
        return { ...r, capturedBy: t.targetRole };
      }),
    );

    const merged: Entry[] = [];
    const perCaptureNextSince: Record<string, number> = {};
    const perCaptureErrors: Record<string, string> = {};
    let totalDropped = 0;

    for (const r of responses) {
      if (r.status !== 'fulfilled') continue;
      const v = r.value;
      const capturedBy = v.capturedBy ?? 'unknown';
      if (v.error) {
        perCaptureErrors[capturedBy] = v.error;
        continue;
      }
      if (v.nextSince !== undefined) perCaptureNextSince[capturedBy] = v.nextSince;
      totalDropped += v.totalDropped ?? 0;
      for (const e of v.entries ?? []) {
        const entry = { ...e };
        delete entry.peer;
        merged.push({ ...entry, capturedBy });
      }
    }

    merged.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.seq - b.seq));

    // Cross-peer dedup. LogService reflects prints across peers in Studio
    // Play, so the same message can land in multiple peers' buffers within
    // ~250ms (client batch) + ~700ms (peer-listener startup skew). 2s window
    // matches the LogBuffer primitive's heuristic.
    const DEDUP_WINDOW = 2.0;
    const deduped: Entry[] = [];
    for (const e of merged) {
      const isDup = deduped.some(
        (d) =>
          d.message === e.message &&
          d.level === e.level &&
          Math.abs(d.ts - e.ts) <= DEDUP_WINDOW &&
          d.capturedBy !== e.capturedBy,
      );
      if (!isDup) deduped.push(e);
    }

    // Re-apply tail post-merge since per-peer tail may have over-returned.
    let final = deduped;
    if (tail !== undefined && deduped.length > tail) {
      final = deduped.slice(deduped.length - tail);
    }
    const finalEntries = originPeerReliable
      ? final.map((e) => ({ ...e, peer: e.capturedBy }))
      : final;

    const body: Record<string, unknown> = {
      entries: finalEntries,
      totalDropped,
      perCaptureNextSince,
      originPeerReliable,
      peerAttribution: originPeerReliable ? 'guaranteed_multiplayer' : 'unavailable_shared_logservice',
    };
    if (originPeerReliable) {
      body.perPeerNextSince = perCaptureNextSince;
    }
    if (Object.keys(perCaptureErrors).length > 0) {
      body.perCaptureErrors = perCaptureErrors;
      if (originPeerReliable) body.perPeerErrors = perCaptureErrors;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  async captureScriptProfiler(target?: string, request: Record<string, unknown> = {}, instance_id?: string) {
    const targetRole = target ?? 'server';
    const data: Record<string, unknown> = { ...request };
    const outputPath = data.output_path;
    delete data.output_path;

    if (outputPath !== undefined && typeof outputPath !== 'string') {
      throw new Error('output_path must be a string when provided');
    }
    if (outputPath) {
      data.__mcp_include_raw_json = true;
    }

    const resolved = this.bridge.resolveTarget({ instance_id, target: targetRole });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'capture_script_profiler profiles one runtime peer at a time. Pick target="server" or a specific "client-N".',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }

    data.__mcp_instance_id = resolved.targetInstanceId;
    data.__mcp_target_role = resolved.targetRole;
    const response = await this.client.request(
      '/api/capture-script-profiler',
      data,
      resolved.targetInstanceId,
      resolved.targetRole,
    );

    const body: unknown = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? { ...response, target: resolved.targetRole }
      : response;

    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const mutable = body as Record<string, unknown>;
      const rawJson = mutable.raw_json;
      if (typeof rawJson === 'string') {
        if (typeof outputPath === 'string' && outputPath !== '') {
          const resolvedOutputPath = path.resolve(outputPath);
          fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
          fs.writeFileSync(resolvedOutputPath, rawJson, 'utf8');
          mutable.output_path = resolvedOutputPath;
        }
        delete mutable.raw_json;
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async captureMicroProfiler(target?: string, request: Record<string, unknown> = {}, instance_id?: string) {
    const targetRole = target ?? 'server';
    const data: Record<string, unknown> = { ...request };
    const outputPath = data.output_path;
    const summaryOutputPath = data.summary_output_path;
    const baselinePath = data.baseline_path;
    const baseline = data.baseline;
    const baselineLabel = typeof data.baseline_label === 'string' ? data.baseline_label : undefined;
    const currentLabel = typeof data.current_label === 'string' ? data.current_label : undefined;
    const maxComparisonRows = typeof data.max_comparison_rows === 'number' ? data.max_comparison_rows : undefined;
    const includeComparisonIndex = data.include_comparison_index === true;
    delete data.output_path;
    delete data.summary_output_path;
    delete data.baseline_path;
    delete data.baseline;
    delete data.baseline_label;
    delete data.current_label;
    delete data.max_comparison_rows;
    delete data.include_comparison_index;

    if (outputPath !== undefined && typeof outputPath !== 'string') {
      throw new Error('output_path must be a string when provided');
    }
    if (summaryOutputPath !== undefined && typeof summaryOutputPath !== 'string') {
      throw new Error('summary_output_path must be a string when provided');
    }
    if (outputPath) {
      data.__mcp_include_raw_buffer = true;
    }
    if (summaryOutputPath || baselinePath || baseline || includeComparisonIndex) {
      data.__mcp_include_comparison_index = true;
    }

    const resolved = this.bridge.resolveTarget({ instance_id, target: targetRole });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'capture_micro_profiler profiles one runtime peer at a time. Pick target="server" or a specific "client-N".',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }

    data.__mcp_instance_id = resolved.targetInstanceId;
    data.__mcp_target_role = resolved.targetRole;
    const response = await this.client.request(
      '/api/capture-micro-profiler',
      data,
      resolved.targetInstanceId,
      resolved.targetRole,
    );

    const body: unknown = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? { ...response, target: resolved.targetRole }
      : response;

    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const mutable = body as Record<string, unknown>;
      const rawSnapshotBase64 = mutable.raw_snapshot_base64;
      if (typeof rawSnapshotBase64 === 'string') {
        if (typeof outputPath === 'string' && outputPath !== '') {
          const resolvedOutputPath = path.resolve(outputPath);
          fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
          fs.writeFileSync(resolvedOutputPath, Buffer.from(rawSnapshotBase64, 'base64'));
          mutable.output_path = resolvedOutputPath;
        }
        delete mutable.raw_snapshot_base64;
      }

      const baselineCapture = loadMicroProfilerBaseline(baseline, baselinePath);
      if (baselineCapture) {
        mutable.baseline_comparison = compareMicroProfilerCaptures(mutable, baselineCapture, {
          baselineLabel,
          currentLabel,
          maxRows: maxComparisonRows,
        });
      }

      if (typeof summaryOutputPath === 'string' && summaryOutputPath !== '') {
        const resolvedSummaryPath = path.resolve(summaryOutputPath);
        fs.mkdirSync(path.dirname(resolvedSummaryPath), { recursive: true });
        fs.writeFileSync(resolvedSummaryPath, JSON.stringify(mutable, null, 2), 'utf8');
        mutable.summary_output_path = resolvedSummaryPath;
      }

      if (!includeComparisonIndex) {
        delete mutable.comparison_index;
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async breakpoints(action: string, request: Record<string, unknown> = {}, target?: string, instance_id?: string) {
    if (!action || typeof action !== 'string') {
      throw new Error('breakpoints requires action=set|remove|clear|list');
    }
    const targetRole = target ?? 'edit';
    const data: Record<string, unknown> = { ...request, action };
    delete data.target;
    delete data.instance_id;
    const resolved = this.bridge.resolveTarget({ instance_id, target: targetRole });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    data.__mcp_instance_id = resolved.targetInstanceId;
    data.__mcp_target_role = resolved.targetRole;
    const response = await this.client.request('/api/breakpoints', data, resolved.targetInstanceId, resolved.targetRole);
    const body = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? { ...response, target: resolved.targetRole }
      : response;
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  private _positiveInteger(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number.`);
    }
    return Math.trunc(value);
  }

  private _optionalPositiveInteger(value: unknown, name: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    return this._positiveInteger(value, name);
  }

  private _optionalFiniteNumber(value: unknown, name: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number.`);
    }
    return value;
  }

  private _publicInstanceKey(instance: PublicPluginInstance): string {
    return `${instance.instanceId}:${instance.role}:${instance.connectedAt}`;
  }

  private async _isLatestPublishedPlaceOpen(placeId: number): Promise<boolean> {
    const publishedInstanceId = `place:${placeId}`;
    return this.bridge.getPublicInstances().some((instance) =>
      instance.placeId === placeId || instance.instanceId === publishedInstanceId,
    ) || (await this.instanceManager.list()).some((record) =>
      record.closedAt === undefined &&
      record.source === 'published_place' &&
      record.placeId === placeId,
    );
  }

  private _matchesManagedLaunch(record: ManagedStudioInstance, instance: PublicPluginInstance): boolean {
    if (record.source === 'published_place') {
      return record.placeId !== undefined && instance.placeId === record.placeId;
    }
    if ((record.source === 'baseplate' || record.source === 'local_file') && record.localPlaceFile) {
      const expectedName = path.basename(record.localPlaceFile);
      return instance.placeName === expectedName || instance.dataModelName === expectedName;
    }
    return true;
  }

  private async _associateManagedEditConnection(
    instance: PublicPluginInstance,
    instanceManager: StudioInstanceManager,
  ): Promise<void> {
    if (instance.role !== 'edit') return;
    const candidate = (await instanceManager.pendingLaunches())
      .filter((record) => instance.connectedAt >= record.launchedAt - 1000)
      .filter((record) => this._matchesManagedLaunch(record, instance))
      .sort((a, b) => a.launchedAt - b.launchedAt)[0];
    if (candidate) await instanceManager.attachInstanceId(candidate, instance.instanceId);
  }

  private async _deriveUniverseId(placeId: number): Promise<number> {
    const response = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Could not resolve the universe for place_id ${placeId} (${response.status}): ${body}`);
    }
    const data = await response.json() as { universeId?: number };
    if (typeof data.universeId !== 'number' || !Number.isFinite(data.universeId)) {
      throw new Error(`Could not resolve the universe for place_id ${placeId}.`);
    }
    return Math.trunc(data.universeId);
  }

  private async _waitForManagedEditConnection(
    record: ManagedStudioInstance,
    beforeKeys: Set<string>,
    timeoutMs: number,
  ): Promise<PublicPluginInstance | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.instanceManager.refresh(record);
      if (record.state === 'failed' || record.state === 'exited' || record.closedAt !== undefined) {
        return undefined;
      }
      const candidates = this.bridge.getPublicInstances()
        .filter((instance) => instance.role === 'edit')
        .filter((instance) => !beforeKeys.has(this._publicInstanceKey(instance)))
        .filter((instance) => instance.connectedAt >= record.launchedAt - 1000)
        .filter((instance) => this._matchesManagedLaunch(record, instance))
        .sort((a, b) => b.connectedAt - a.connectedAt);

      if (candidates[0]) return candidates[0];
      await sleep(500);
    }
    return undefined;
  }

  private _managedStatus(record: ManagedStudioInstance): Record<string, unknown> {
    const connected = record.instanceId
      ? this.bridge.getPublicInstances().filter((instance) => instance.instanceId === record.instanceId)
      : [];
    return {
      launch_id: record.recordId,
      instance_id: record.instanceId,
      managed: true,
      state: record.state,
      pid: record.nativeProcessId ?? record.spawnPid,
      process_started_at_file_time: record.nativeProcessStartedAt,
      process_authorized: record.processAuthorizationState !== 'pending',
      process_ownership_released: record.processAuthorizationState === 'released',
      process_running: record.closedAt !== undefined || record.exitedAt !== undefined
        ? false
        : record.processObservationStatus === 'running'
          ? true
          : record.processObservationStatus === 'not_running'
            ? false
            : null,
      process_observation_status: record.processObservationStatus ?? 'unknown',
      last_process_observation_at: record.lastProcessObservationAt
        ? new Date(record.lastProcessObservationAt).toISOString()
        : undefined,
      last_successful_process_observation_at: record.lastSuccessfulProcessObservationAt
        ? new Date(record.lastSuccessfulProcessObservationAt).toISOString()
        : undefined,
      last_process_observation_error: record.lastProcessObservationError,
      consecutive_confirmed_misses: record.consecutiveConfirmedMisses ?? 0,
      source: record.source,
      local_place_file: record.localPlaceFile,
      place_id: record.placeId,
      place_version: record.placeVersion,
      launched_at: new Date(record.launchedAt).toISOString(),
      connected_at: record.connectedAt ? new Date(record.connectedAt).toISOString() : undefined,
      failed_at: record.failedAt ? new Date(record.failedAt).toISOString() : undefined,
      exited_at: record.exitedAt ? new Date(record.exitedAt).toISOString() : undefined,
      exit_code: record.exitCode,
      failure_reason: record.failureReason,
      connected: connected.length > 0,
      roles: connected.map((instance) => instance.role).sort(),
    };
  }

  private _versionNumberFromPath(pathValue: string): number | undefined {
    const match = pathValue.match(/\/versions\/(\d+)$/);
    return match ? Number(match[1]) : undefined;
  }

  async manageInstance(request: Record<string, unknown>) {
    const action = request.action;
    const instance_id = typeof request.instance_id === 'string' ? request.instance_id : undefined;
    const launch_id = typeof request.launch_id === 'string' ? request.launch_id : undefined;

    if (instance_id && launch_id) {
      throw new Error('manage_instance accepts only one of instance_id or launch_id.');
    }

    if (
      action !== 'launch' &&
      action !== 'authorize' &&
      action !== 'complete' &&
      action !== 'close' &&
      action !== 'status' &&
      action !== 'list_place_versions'
    ) {
      throw new Error('manage_instance requires action=launch|authorize|complete|close|status|list_place_versions');
    }

    if (action === 'list_place_versions') {
      if (!this.openCloudClient.hasApiKey()) {
        return this._textResult({
          error: 'ROBLOX_OPEN_CLOUD_API_KEY is required to list place versions.',
        });
      }
      const placeId = this._positiveInteger(request.place_id, 'place_id');
      const rawMaxPageSize = Math.trunc(this._optionalFiniteNumber(request.max_page_size, 'max_page_size') ?? 10);
      const maxPageSize = Math.max(1, Math.min(50, rawMaxPageSize));
      const pageToken = typeof request.page_token === 'string' ? request.page_token : undefined;
      const response = await this.openCloudClient.listAssetVersions(placeId, maxPageSize, pageToken);
      const body: Record<string, unknown> = {
        versions: (response.assetVersions ?? []).map((version) => ({
          version: this._versionNumberFromPath(version.path),
          created_at: version.createTime,
          path: version.path,
          moderation_state: version.moderationResult?.moderationState,
        })),
      };
      if (response.nextPageToken) body.next_page_token = response.nextPageToken;
      return this._textResult(body);
    }

    if (action === 'close' || action === 'status') {
      await this.managedConnectionAssociations;
    }

    if (action === 'authorize') {
      if (!launch_id) throw new Error('manage_instance action=authorize requires launch_id.');
      const record = await this.instanceManager.authorizeByLaunchId(launch_id);
      return this._textResult(this._managedStatus(record));
    }

    if (action === 'complete') {
      if (!launch_id) throw new Error('manage_instance action=complete requires launch_id.');
      const record = await this.instanceManager.completeByLaunchId(launch_id);
      return this._textResult(this._managedStatus(record));
    }

    if (action === 'status') {
      if (launch_id) {
        const record = await this.instanceManager.getByLaunchId(launch_id);
        if (!record) return this._textResult({ error: 'Launch is not managed.', launch_id });
        return this._textResult(this._managedStatus(record));
      }
      if (instance_id) {
        const record = await this.instanceManager.get(instance_id);
        const connected = this.bridge.getPublicInstances().filter((instance) => instance.instanceId === instance_id);
        if (!record && connected.length === 0) {
          return this._textResult({ error: 'Instance is not connected or managed.', instance_id });
        }
        if (record) return this._textResult(this._managedStatus(record));
        return this._textResult({
          instance_id,
          managed: false,
          state: 'connected',
          place_id: connected[0]?.placeId,
          connected: true,
          roles: connected.map((instance) => instance.role).sort(),
        });
      }
      return this._textResult({
        managed: (await this.instanceManager.list())
          .filter((record) => record.closedAt === undefined)
          .map((record) => this._managedStatus(record)),
        connected: this.bridge.getPublicInstances().map((instance) => ({
          instance_id: instance.instanceId,
          role: instance.role,
          place_id: instance.placeId,
          place_name: instance.placeName,
        })),
      });
    }

    if (action === 'close') {
      let record: ManagedStudioInstance | undefined;
      if (launch_id) {
        record = await this.instanceManager.getByLaunchId(launch_id);
        if (!record) return this._textResult({ error: 'Launch is not managed.', launch_id });
        const connectedInstanceId = record.instanceId;
        const closeResult = record.closedAt === undefined
          ? await this.instanceManager.close(record)
          : { status: 'already_closed' as const };
        if (connectedInstanceId) {
          await this.bridge.unregisterInstanceIdEverywhere(connectedInstanceId);
          await sleep(500);
          await this.bridge.unregisterInstanceIdEverywhere(connectedInstanceId);
        }
        return this._textResult({
          ...this._managedStatus(record),
          close_status: closeResult.status,
          message: closeResult.status === 'already_closed'
            ? 'Studio instance was already closed.'
            : 'Studio instance closed.',
        });
      }
      if (instance_id) {
        const recordBeforeClose = await this.instanceManager.get(instance_id);
        const managedClose = await this.instanceManager.closeByInstanceId(instance_id);
        if (managedClose.status !== 'not_found') {
          await this.bridge.unregisterInstanceIdEverywhere(instance_id);
          await sleep(500);
          await this.bridge.unregisterInstanceIdEverywhere(instance_id);
          const closedRecord = managedClose.launchId
            ? await this.instanceManager.getByLaunchId(managedClose.launchId)
            : recordBeforeClose;
          return this._textResult({
            ...(closedRecord ? this._managedStatus(closedRecord) : { instance_id }),
            close_status: managedClose.status,
            message: managedClose.status === 'already_closed'
              ? 'Studio instance was already closed.'
              : 'Studio instance closed.',
          });
        }

        const connected = this.bridge.getPublicInstances().filter((instance) => instance.instanceId === instance_id);
        const edit = connected.find((instance) => instance.role === 'edit');
        if (!edit) {
          return this._textResult({
            error: 'Instance is not connected or managed.',
            instance_id,
          });
        }
        try {
          await this.instanceManager.closeConnectedInstance(edit);
          await sleep(500);
        } catch (error) {
          return this._textResult({
            error: error instanceof Error ? error.message : String(error),
            instance_id,
          });
        }
        await this.bridge.unregisterInstanceIdEverywhere(instance_id);
        return this._textResult({
          instance_id,
          close_status: 'closed',
          message: 'Studio instance closed.',
        });
      } else {
        const active = (await this.instanceManager.list()).filter((entry) => entry.closedAt === undefined);
        if (active.length === 0) {
          return this._textResult({ message: 'No managed Studio instances are active.' });
        }
        if (active.length > 1) {
          return this._textResult({
            error: 'instance_id is required because multiple managed Studio instances are active.',
            managed: active.map((entry) => this._managedStatus(entry)),
          });
        }
        record = active[0];
      }

      if (record.instanceId) await this.bridge.unregisterInstanceIdEverywhere(record.instanceId);
      const closeResult = await this.instanceManager.close(record);
      if (record.instanceId) {
        await sleep(500);
        await this.bridge.unregisterInstanceIdEverywhere(record.instanceId);
      }
      return this._textResult({
        ...this._managedStatus(record),
        close_status: closeResult.status,
        message: closeResult.status === 'already_closed'
          ? 'Studio instance was already closed.'
          : 'Studio instance closed.',
      });
    }

    const source = request.source;
    if (
      source !== 'baseplate' &&
      source !== 'local_file' &&
      source !== 'published_place' &&
      source !== 'place_revision'
    ) {
      throw new Error('manage_instance action=launch requires source=baseplate|local_file|published_place|place_revision');
    }

    const launchSource = source as StudioLaunchSource;
    const placeId = launchSource === 'published_place' || launchSource === 'place_revision'
      ? this._positiveInteger(request.place_id, 'place_id')
      : undefined;
    const placeVersion = launchSource === 'place_revision'
      ? this._positiveInteger(request.place_version, 'place_version')
      : undefined;
    const localPlaceFile = typeof request.local_place_file === 'string' ? request.local_place_file : undefined;
    let studioExecutable: string | undefined;
    if (request.studio_executable !== undefined) {
      if (typeof request.studio_executable !== 'string' || request.studio_executable.length === 0) {
        throw new Error('studio_executable must be a non-empty string when provided.');
      }
      studioExecutable = request.studio_executable;
    }
    const processEnvironment = parseStudioProcessEnvironmentPatch(request.process_environment);

    if (launchSource === 'published_place' && placeId !== undefined && await this._isLatestPublishedPlaceOpen(placeId)) {
      return this._textResult({
        error: 'Place is already open.',
        message: `place_id ${placeId} is already connected. Use the existing instance or launch a specific place_revision.`,
      });
    }

    const universeId = launchSource === 'published_place' || launchSource === 'place_revision'
      ? await this._deriveUniverseId(placeId as number)
      : undefined;
    if (request.require_process_identity !== undefined && typeof request.require_process_identity !== 'boolean') {
      throw new Error('require_process_identity must be a boolean when provided.');
    }
    const requireProcessIdentity = request.require_process_identity === true;
    const waitForConnection = !requireProcessIdentity && request.wait_for_connection !== false;
    const timeoutMs = this._optionalPositiveInteger(request.timeout_ms, 'timeout_ms') ?? 120000;
    const beforeKeys = new Set(this.bridge.getPublicInstances().map((instance) => this._publicInstanceKey(instance)));

    const record = await this.instanceManager.launch({
      source: launchSource,
      localPlaceFile,
      placeId,
      universeId,
      placeVersion,
      connectionTimeoutMs: timeoutMs,
      studioExecutable,
      processEnvironment,
      ...(requireProcessIdentity ? { requireProcessIdentity: true } : {}),
    });

    if (!waitForConnection) {
      return this._textResult({
        ...this._managedStatus(record),
        message: 'Studio launch requested.',
      });
    }

    const connected = await this._waitForManagedEditConnection(record, beforeKeys, timeoutMs);
    if (!connected) {
      if (record.state === 'launching') {
        await this.instanceManager.markFailed(record, 'Studio launched, but the MCP plugin did not connect before timeout.');
      }
      if (record.closedAt === undefined) {
        try {
          await this.instanceManager.close(record);
        } catch {
          // Best effort cleanup; the lifecycle error remains the useful result.
        }
      }
      return this._textResult({
        ...this._managedStatus(record),
        error: record.failureReason ?? 'Studio launched, but the MCP plugin did not connect before timeout.',
      });
    }

    await this.instanceManager.attachInstanceId(record, connected.instanceId);
    return this._textResult({
      ...this._managedStatus(record),
      message: launchSource === 'place_revision'
        ? `Studio opened place revision ${placeVersion}.`
        : 'Studio opened.',
    });
  }

  async soloPlaytest(action: string, mode?: string, timeout?: number, instance_id?: string) {
    if (action !== 'start' && action !== 'stop' && action !== 'status') {
      throw new Error('solo_playtest requires action=start|stop|status');
    }

    if (action === 'status') {
      const instanceId = this._resolveInstanceIdOnly(instance_id);
      const { roles, runtimeRoles } = this._briefRoles(instanceId, true);
      return this._textResult({
        success: true,
        action,
        running: runtimeRoles.length > 0,
        roles,
      });
    }

    if (action === 'start') {
      if (mode !== 'play' && mode !== 'run') {
        throw new Error('solo_playtest action=start requires mode=play|run');
      }
      const body = this._parseTextResult(await this.startPlaytest(mode, undefined, instance_id, timeout));
      if (body.success === true && body.runtimeReady !== false) {
        return this._textResult({
          success: true,
          action,
          message: 'Playtest started.',
          roles: Array.isArray(body.roles) ? body.roles : undefined,
        });
      }
      return this._textResult({
        success: false,
        action,
        error: body.error ?? 'start_failed',
        message: body.success === true
          ? 'Playtest did not become ready before timeout.'
          : body.message ?? 'Playtest did not start.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    const body = this._parseTextResult(await this.stopPlaytest(instance_id, timeout));
    if (body.success === true && body.runtimeStopped !== false) {
      return this._textResult({
        success: true,
        action,
        message: 'Playtest stopped.',
      });
    }
    return this._textResult({
      success: false,
      action,
      error: body.error ?? 'stop_failed',
      message: body.message ?? 'Playtest did not stop.',
      roles: Array.isArray(body.roles) ? body.roles : undefined,
      requiresBuiltInMcp: body.requiresBuiltInMcp === true ? true : undefined,
      recoveryHint: typeof body.recoveryHint === 'string' ? body.recoveryHint : undefined,
    });
  }

  async startPlaytest(mode: string, numPlayers?: number, instance_id?: string, timeout = 60) {
    if (mode !== 'play' && mode !== 'run') {
      throw new Error('mode must be "play" or "run"');
    }
    if (numPlayers !== undefined) {
      throw new Error('start_playtest is single-player only. Use multiplayer_playtest action="start" for multi-client StudioTestService sessions.');
    }
    const data: Record<string, unknown> = { mode };
    const startedAt = Date.now();
    const resolved = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    const existingRuntime = this._runtimeTargetsForEquivalentInstances(resolved.targetInstanceId);
    if (existingRuntime.length > 0) {
      const roles = this._rolesForEquivalentInstances(resolved.targetInstanceId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Playtest already running.',
            message: 'A playtest is already running for this Studio place. Stop the current playtest before starting another.',
            runtimeReady: true,
            timedOut: false,
            roles,
            runtimeRoles: existingRuntime.map((target) => target.role),
          }),
        }],
      };
    }
    const response = await this.client.request(
      '/api/start-playtest',
      data,
      resolved.targetInstanceId,
      resolved.targetRole,
    );
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      const requiredRoles = mode === 'play' ? ['server', 'client-1'] : ['server'];
      wait = await this._waitForRuntimeRolesFresh(resolved.targetInstanceId, startedAt, requiredRoles, timeout, true);
    }
    const body = wait
      ? {
        ...response,
        runtimeReady: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(body)
        }
      ]
    };
  }

  async stopPlaytest(instance_id?: string, timeout = 15) {
    // The edit DM's stopPlaytest handler writes a plugin:SetSetting request
    // that StopPlayMonitor reads from inside the play-server DM (the only DM where
    // StudioTestService:EndTest is legal). No edit-proxy peer registration is
    // involved — the cross-DM signal works regardless of MCP server state,
    // peer-role bookkeeping, or restart cycles.
    const { instanceId } = this._resolveSingleTarget('edit', instance_id);
    let response: Record<string, unknown>;
    let stopRequestError: string | undefined;
    try {
      response = await this.client.request('/api/stop-playtest', {}, instanceId, 'edit');
    } catch (error) {
      stopRequestError = errorMessage(error);
      response = {
        success: false,
        error: 'Edit stop request failed.',
        detail: stopRequestError,
      };
    }
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      wait = await this._waitForRuntimeRoles(instanceId, { noRuntime: true }, timeout, true);
    } else if (this._runtimeTargetsForEquivalentInstances(instanceId).length > 0) {
      wait = {
        ok: false,
        roles: this._rolesForEquivalentInstances(instanceId),
        timedOut: false,
      };
    }
    const body = wait
      ? {
        ...response,
        runtimeStopped: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    if (wait && !wait.ok) {
      const runtimeRoles = wait.roles.filter((role) => role === 'server' || /^client-\d+$/.test(role));
      const failureBody = {
        ...body,
        success: false,
        error: 'Playtest teardown did not complete.',
        message: response?.success === true
          ? wait.timedOut
            ? 'Stop signal was accepted, but runtime peers did not disconnect before timeout.'
            : 'Stop signal was accepted, but runtime peers are still connected.'
          : 'Edit stop request failed, and runtime peers are still connected.',
        stopSignalAccepted: response?.success === true,
        stopRequestError,
        runtimeRoles,
        possibleCause:
          'A game shutdown hook such as BindToClose may be blocking Studio teardown. ' +
          'No runtime hard-stop or synthetic keyboard fallback was attempted.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(failureBody) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  private async _buildMultiplayerState(instanceId: string): Promise<Record<string, unknown>> {
    const peers = this.bridge.getPublicInstances()
      .filter((i) => i.instanceId === instanceId)
      .sort((a, b) => a.role.localeCompare(b.role));

    const body: Record<string, unknown> = {
      instanceId,
      peers,
      peerCount: peers.length,
    };

    const edit = peers.find((p) => p.role === 'edit');
    const server = peers.find((p) => p.role === 'server');

    let editState: any | undefined;
    let serverState: any | undefined;

    if (edit) {
      try {
        editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        body.edit = editState;
      } catch (err) {
        body.edit = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (server) {
      try {
        serverState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'server');
        body.server = serverState;
      } catch (err) {
        body.server = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const session = editState?.session;
    const rawPhase = typeof session?.phase === 'string' ? session.phase : undefined;
    const hasRuntime = peers.some((p) => p.role === 'server' || p.role.startsWith('client-'));
    body.phase = rawPhase === 'starting' && hasRuntime ? 'running' : (rawPhase ?? (hasRuntime ? 'running' : 'idle'));
    body.testId = session?.testId;
    body.numPlayers = session?.numPlayers;
    body.testArgs = session?.testArgs ?? serverState?.testArgs;
    body.result = session?.result;
    body.error = session?.error;
    body.players = serverState?.players ?? [];
    body.playerCount = serverState?.playerCount ?? 0;
    body.clientRoles = this._clientRolesForInstance(instanceId);

    return body;
  }

  private async _waitForMultiplayerEditDone(instanceId: string, timeoutSec = 30): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (!this._rolesForInstance(instanceId).includes('edit')) return false;
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const phase = editState?.session?.phase;
        if (phase === 'completed' || phase === 'failed') return true;
      } catch {
        // The edit peer may be temporarily busy while Studio tears down.
      }
      await sleep(250);
    }
    return false;
  }

  private async _isMultiplayerTestRunning(instanceId: string): Promise<boolean> {
    const roles = this._rolesForInstance(instanceId);
    const hasServer = roles.includes('server');
    const clientCount = roles.filter((role) => role.startsWith('client-')).length;
    if (roles.includes('edit')) {
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const phase = editState?.session?.phase;
        if (phase === 'starting' || phase === 'running') return true;
      } catch {
        // Fall through to the runtime-shape heuristic below. Direct/manual
        // StudioTestService multiplayer sessions do not update the edit peer's
        // MCP-managed session state, but they still expose distinct server and
        // client plugin peers.
      }
    }
    return hasServer && clientCount >= 2;
  }

  private async _waitForMultiplayerStart(
    instanceId: string,
    clientCount: number,
    timeoutSec = 30,
    connectedAfter?: number,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; phase?: string; error?: unknown }> {
    const deadline = Date.now() + timeoutSec * 1000;
    let lastPhase: string | undefined;
    while (Date.now() < deadline) {
      const exact = await this._waitForExactClientCount(instanceId, clientCount, 0.25, 0);
      if (exact.ok || exact.extraClients) {
        if (exact.ok && connectedAfter !== undefined) {
          const instances = this.bridge.getInstances().filter((inst) => inst.instanceId === instanceId);
          const freshRoles = new Set(instances.filter((inst) => inst.connectedAt >= connectedAfter).map((inst) => inst.role));
          const freshClientCount = [...freshRoles].filter((role) => /^client-\d+$/.test(role)).length;
          if (!freshRoles.has('server') || freshClientCount !== clientCount) {
            await sleep(250);
            continue;
          }
        }
        return { ok: exact.ok, roles: exact.roles, timedOut: false, error: exact.extraClients ? `Expected ${clientCount} client(s), but Studio registered ${exact.clientCount}.` : undefined };
      }
      try {
        const remainingMs = Math.max(1, Math.min(1000, deadline - Date.now()));
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit', remainingMs);
        const session = editState?.session;
        if (typeof session?.phase === 'string') {
          lastPhase = session.phase;
        }
        if (session?.phase === 'failed') {
          return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: false, phase: session.phase, error: session.error };
        }
      } catch {
        // Keep waiting; normal startup is driven by runtime peers registering.
      }
      await sleep(250);
    }
    return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: true, phase: lastPhase };
  }

  async multiplayerPlaytest(
    action: string,
    numPlayers?: number,
    target?: string,
    testArgs?: unknown,
    value?: unknown,
    timeout?: number,
    instance_id?: string,
  ) {
    if (
      action !== 'start' &&
      action !== 'status' &&
      action !== 'add_players' &&
      action !== 'leave_client' &&
      action !== 'end'
    ) {
      throw new Error('multiplayer_playtest requires action=start|status|add_players|leave_client|end');
    }

    const briefState = async (instanceId?: string) => {
      const state = await this._buildMultiplayerState(this._resolveInstanceIdOnly(instanceId));
      return {
        phase: state.phase,
        roles: Array.isArray(state.peers) ? state.peers.map((peer: any) => peer.role).filter((role: unknown) => typeof role === 'string') : [],
        playerCount: typeof state.playerCount === 'number' ? state.playerCount : undefined,
        error: typeof state.error === 'string' ? state.error : undefined,
      };
    };

    if (action === 'status') {
      return this._textResult({
        success: true,
        action,
        ...(await briefState(instance_id)),
      });
    }

    if (action === 'start') {
      const body = this._parseTextResult(await this.multiplayerTestStart(numPlayers as number, testArgs, timeout, instance_id));
      const state = body.state && typeof body.state === 'object' ? body.state as Record<string, any> : {};
      const launched = body.success === true && body.ready === true;
      return this._textResult(launched ? {
        success: true,
        action,
        message: 'Multiplayer playtest started.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
        playerCount: typeof state.playerCount === 'number' ? state.playerCount : undefined,
      } : {
        success: false,
        action,
        error: body.error ?? body.wait?.error ?? 'multiplayer_start_not_detected',
        message: body.success === true
          ? 'Multiplayer playtest start was requested, but MCP did not detect the required server/client peers before timeout.'
          : body.message ?? 'Multiplayer playtest did not start.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    if (action === 'add_players') {
      const body = this._parseTextResult(await this.multiplayerTestAddPlayers(numPlayers as number, timeout, instance_id));
      const state = body.state && typeof body.state === 'object' ? body.state as Record<string, any> : {};
      const success = body.success === true && body.ready === true;
      return this._textResult(success ? {
        success: true,
        action,
        message: 'Players added.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
        playerCount: typeof state.playerCount === 'number' ? state.playerCount : undefined,
      } : {
        success: false,
        action,
        error: body.error ?? 'add_players_failed',
        message: body.success === true
          ? 'Players did not finish joining before timeout.'
          : body.message ?? 'Players were not added.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    if (action === 'leave_client') {
      const body = this._parseTextResult(await this.multiplayerTestLeaveClient(target ?? 'client-1', timeout, instance_id));
      return this._textResult(body.success === true && body.left === true ? {
        success: true,
        action,
        message: 'Client left.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      } : {
        success: false,
        action,
        error: body.error ?? 'leave_client_failed',
        message: body.message ?? 'Client did not leave.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    const body = this._parseTextResult(await this.multiplayerTestEnd(value, timeout, instance_id));
    return this._textResult(body.success === true && body.ended === true ? {
      success: true,
      action,
      message: body.alreadyEnded === true
        ? 'Multiplayer playtest already ended.'
        : (body.teardownConfirmed === false
          ? 'Multiplayer playtest end requested; teardown still in progress. Use multiplayer_playtest action="status" to confirm.'
          : 'Multiplayer playtest ended.'),
      teardownConfirmed: body.teardownConfirmed === true,
    } : {
      success: false,
      action,
      error: body.error ?? 'end_failed',
      message: body.message ?? 'Multiplayer playtest did not end.',
      roles: Array.isArray(body.roles) ? body.roles : undefined,
      editDone: body.editDone === false ? false : undefined,
    });
  }

  async multiplayerTestStart(numPlayers: number, testArgs?: unknown, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const editTarget = this._resolveSingleTarget('edit', instance_id);
    const existingRuntime = this._runtimeTargetsForEquivalentInstances(editTarget.instanceId);
    if (existingRuntime.length > 0) {
      const roles = this._rolesForEquivalentInstances(editTarget.instanceId);
      return this._textResult({
        success: false,
        error: 'Multiplayer playtest already running.',
        message: 'A Studio runtime is already connected for this place. End the existing playtest before starting another multiplayer playtest.',
        ready: true,
        timedOut: false,
        roles,
        runtimeRoles: existingRuntime.map((target) => target.role),
      });
    }

    const startedAt = Date.now();
    const response = await this.client.request(
      '/api/multiplayer-test-start',
      { numPlayers, testArgs: testArgs ?? {} },
      editTarget.instanceId,
      editTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }

    const wait = await this._waitForMultiplayerStart(editTarget.instanceId, numPlayers, timeout ?? 60, startedAt);
    const launched = wait.ok;
    const state = await this._buildMultiplayerState(editTarget.instanceId);
    const success = response.success === true && wait.ok;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          success,
          ready: wait.ok,
          launched,
          startRequested: response.success === true,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
          error: success ? undefined : wait.error ?? 'multiplayer_start_not_detected',
          message: success
            ? 'Multiplayer Studio test started and runtime peers detected.'
            : 'Multiplayer Studio test start was requested, but MCP did not detect the required server/client peers before timeout.',
          startedAt,
        }),
      }],
    };
  }

  async multiplayerTestState(instance_id?: string) {
    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const state = await this._buildMultiplayerState(instanceId);
    return { content: [{ type: 'text', text: JSON.stringify(state) }] };
  }

  async multiplayerTestAddPlayers(numPlayers: number, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const serverTarget = this._resolveSingleTarget('server', instance_id);
    const before = this._clientRolesForInstance(serverTarget.instanceId).length;
    const response = await this.client.request(
      '/api/multiplayer-test-add-players',
      { numPlayers, timeout: timeout ?? 10 },
      serverTarget.instanceId,
      serverTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForExactClientCount(serverTarget.instanceId, before + numPlayers, timeout ?? 30);
    const state = await this._buildMultiplayerState(serverTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ready: wait.ok,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestLeaveClient(target: string = 'client-1', timeout?: number, instance_id?: string) {
    if (!/^client-\d+$/.test(target)) {
      throw new Error(`multiplayer_test_leave_client requires target=client-N (got: ${target})`);
    }
    const clientTarget = this._resolveSingleTarget(target, instance_id);
    const response = await this.client.request(
      '/api/multiplayer-test-leave-client',
      {},
      clientTarget.instanceId,
      clientTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForRuntimeRoles(
      clientTarget.instanceId,
      { absentRole: clientTarget.role },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(clientTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          left: wait.ok,
          timedOut: wait.timedOut,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestEnd(value?: unknown, timeout?: number, instance_id?: string) {
    let serverTarget: { instanceId: string; role: string };
    try {
      serverTarget = this._resolveSingleTarget('server', instance_id);
    } catch (err) {
      const instanceId = this._resolveInstanceIdOnly(instance_id);
      const hasRuntime = this._rolesForInstance(instanceId).some(
        (role) => role === 'server' || /^client-\d+$/.test(role),
      );
      if (!hasRuntime) {
        return this._textResult({
          success: true,
          ended: true,
          alreadyEnded: true,
          teardownConfirmed: true,
          message: 'No active multiplayer test to end (already ended).',
        });
      }
      throw err;
    }
    const response = await this.client.request(
      '/api/multiplayer-test-end',
      { value: value ?? 'ended_by_mcp' },
      serverTarget.instanceId,
      serverTarget.role,
    );
    if (response?.error) {
      return this._textResult(response);
    }
    const editDone = await this._waitForMultiplayerEditDone(serverTarget.instanceId, timeout ?? 30);
    const wait = await this._waitForRuntimeRoles(
      serverTarget.instanceId,
      { noRuntime: true },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(serverTarget.instanceId);
    return this._textResult({
      ...response,
      ended: response.success === true,
      teardownConfirmed: wait.ok,
      editDone,
      timedOut: wait.timedOut,
      roles: wait.roles,
      state,
    });
  }

  async getConnectedInstances() {
    const places = new Map<string, { id: string; name: string; roles: string[] }>();

    for (const peer of this.bridge.getPublicInstances()) {
      let place = places.get(peer.instanceId);
      if (!place) {
        place = {
          id: peer.instanceId,
          name: peer.placeName || peer.dataModelName,
          roles: [],
        };
        places.set(peer.instanceId, place);
      }

      if (!place.roles.includes(peer.role)) {
        place.roles.push(peer.role);
      }
    }

    return this._textResult({ instances: [...places.values()] });
  }


  // === Asset Tools ===

  async searchAssets(
    assetType: string,
    query?: string,
    maxResults?: number,
    sortBy?: string,
    robloxCreatedOnly?: boolean
  ) {
    const normalized = normalizeCreatorStoreSearch(assetType, query);
    if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100)) {
      throw new Error('search_assets maxResults must be an integer from 1 to 100');
    }
    if (sortBy !== undefined && !CREATOR_STORE_SORT_CATEGORIES.has(sortBy)) {
      throw new Error(
        `search_assets sortBy must be one of: ${Array.from(CREATOR_STORE_SORT_CATEGORIES).join(', ')}`,
      );
    }

    const response = await this.openCloudClient.searchAssets({
      searchCategoryType: normalized.searchCategoryType,
      query: normalized.effectiveQuery,
      maxPageSize: maxResults,
      sortCategory: sortBy as AssetSearchParams['sortCategory'],
      ...(robloxCreatedOnly ? { userId: ROBLOX_CREATOR_USER_ID } : {}),
    });

    const results = response.creatorStoreAssets.flatMap((entry) => {
      const asset = entry.asset;
      if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0) return [];
      const result: Record<string, unknown> = {
        assetId: asset.id,
        name: asset.name,
        description: normalizeSearchAssetDescription(asset.description),
      };
      if (
        typeof asset.durationSeconds === 'number'
        && Number.isFinite(asset.durationSeconds)
      ) {
        result.duration = asset.durationSeconds;
      }
      return [result];
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          assetType: normalized.requestedAssetType,
          query: normalized.effectiveQuery ?? '',
          ...(normalized.searchCategoryType !== normalized.requestedAssetType
            ? { searchedAs: normalized.searchCategoryType }
            : {}),
          totalResults: response.totalResults,
          results,
        })
      }]
    };
  }

  async getAssetDetails(assetId: number) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_details');
    }

    const response = await this.openCloudClient.getAssetDetails(assetId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getAssetThumbnail(assetId: number, size?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_thumbnail');
    }
    const result = await this.openCloudClient.getAssetThumbnail(assetId, size as any);
    if (!result) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Thumbnail not available for this asset' })
        }]
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ assetId, mimeType: result.mimeType }),
        },
        {
          type: 'image',
          data: result.base64,
          mimeType: result.mimeType,
        },
      ]
    };
  }

  async insertAsset(assetId: number, parentPath?: string, position?: { x: number; y: number; z: number }, instance_id?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for insert_asset');
    }
    const response = await this._callSingle('/api/insert-asset', {
      assetId,
      parentPath: parentPath || 'game.Workspace',
      position
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async generateModel(request: Record<string, unknown> = {}, instance_id?: string) {
    try {
      return await this._generateModel(request, instance_id);
    } catch (error) {
      if (error instanceof RoutingFailure) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: message }),
        }],
      };
    }
  }

  private async _generateModel(request: Record<string, unknown> = {}, instance_id?: string) {
    const prompt = typeof request.prompt === 'string' && request.prompt.trim() !== ''
      ? request.prompt
      : undefined;
    const imagePath = typeof request.image_path === 'string' && request.image_path !== ''
      ? request.image_path
      : undefined;
    const imageBase64 = typeof request.image_base64 === 'string' && request.image_base64 !== ''
      ? request.image_base64
      : undefined;
    const imageAssetId = typeof request.image_asset_id === 'number' && Number.isFinite(request.image_asset_id)
      ? Math.trunc(request.image_asset_id)
      : undefined;

    const imageSourceCount = [imagePath, imageBase64, imageAssetId].filter((value) => value !== undefined).length;
    if (!prompt && imageSourceCount === 0) {
      throw new Error('generate_model requires prompt, image_path, image_base64, or image_asset_id.');
    }
    if (imageSourceCount > 1) {
      throw new Error('generate_model accepts only one image source: image_path, image_base64, or image_asset_id.');
    }

    const schema = typeof request.schema === 'string' && request.schema !== ''
      ? request.schema
      : undefined;
    const schemaGroups = Array.isArray(request.schema_groups) ? request.schema_groups : undefined;
    if (schema && schemaGroups) {
      throw new Error('schema and schema_groups are mutually exclusive.');
    }
    if (schema && schema !== 'Body1' && schema !== 'Car5') {
      throw new Error('schema must be Body1 or Car5.');
    }
    if (schemaGroups) {
      if (schemaGroups.length === 0 || !schemaGroups.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
        throw new Error('schema_groups must be a non-empty array of strings.');
      }
    }

    const size = request.size;
    let modelSize: { x: number; y: number; z: number } | undefined;
    if (size !== undefined) {
      if (!size || typeof size !== 'object' || Array.isArray(size)) {
        throw new Error('size must be an object with positive x, y, and z numbers.');
      }
      const rawSize = size as Record<string, unknown>;
      const x = rawSize.x;
      const y = rawSize.y;
      const z = rawSize.z;
      if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || x <= 0 || y <= 0 || z <= 0) {
        throw new Error('size must be an object with positive x, y, and z numbers.');
      }
      modelSize = { x, y, z };
    }

    let image: GenerateModelImage | undefined;
    if (imagePath) {
      const decoded = decodeImagePathToRgba(imagePath);
      const png = rgbaToPng(decoded.rgba, decoded.width, decoded.height);
      const imageAssetId = await this.uploadGenerateModelReferenceImage(
        png,
        instance_id,
      );
      image = {
        kind: 'asset',
        asset_id: imageAssetId,
      };
    } else if (imageBase64) {
      const imageMimeType = request.image_mime_type;
      if (imageMimeType !== 'image/png') {
        throw new Error('image_mime_type must be "image/png" when image_base64 is provided.');
      }
      const decoded = decodePngToRgba(Buffer.from(imageBase64, 'base64'));
      const png = rgbaToPng(decoded.rgba, decoded.width, decoded.height);
      const imageAssetId = await this.uploadGenerateModelReferenceImage(
        png,
        instance_id,
      );
      image = {
        kind: 'asset',
        asset_id: imageAssetId,
      };
    } else if (imageAssetId !== undefined) {
      if (imageAssetId <= 0) throw new Error('image_asset_id must be a positive number.');
      image = { kind: 'asset', asset_id: imageAssetId };
    }

    const maxTriangles = request.max_triangles !== undefined
      ? this._optionalPositiveInteger(request.max_triangles, 'max_triangles')
      : undefined;
    const timeoutMs = request.timeout_ms !== undefined
      ? this._optionalPositiveInteger(request.timeout_ms, 'timeout_ms')
      : 120000;
    if (timeoutMs !== undefined && timeoutMs > 300000) {
      throw new Error('timeout_ms must be 300000 or less.');
    }

    const payload: Record<string, unknown> = {
      prompt,
      image,
      schema_groups: schemaGroups,
      name: typeof request.name === 'string' && request.name !== '' ? request.name : undefined,
      size: modelSize,
      max_triangles: maxTriangles,
      generate_textures: typeof request.generate_textures === 'boolean' ? request.generate_textures : undefined,
    };
    if (!schemaGroups) {
      payload.schema = schema ?? 'Body1';
    }

    const response = await this._callSingle('/api/generate-model', payload, 'edit', instance_id, timeoutMs);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response),
      }],
    };
  }

  async previewAsset(
    assetId: number,
    includeProperties?: boolean,
    maxDepth?: number,
    instance_id?: string,
    includeAudio = true,
    maxAudioPreviews = DEFAULT_ASSET_AUDIO_PREVIEWS,
  ) {
    if (!assetId) {
      throw new Error('Asset ID is required for preview_asset');
    }
    if (
      !Number.isSafeInteger(maxAudioPreviews)
      || maxAudioPreviews < 1
      || maxAudioPreviews > MAX_ASSET_AUDIO_PREVIEWS
    ) {
      throw new Error(
        `maxAudioPreviews must be an integer between 1 and ${MAX_ASSET_AUDIO_PREVIEWS}.`,
      );
    }
    const response = await this._callSingle('/api/preview-asset', {
      assetId,
      includeProperties: includeProperties ?? false,
      maxDepth: maxDepth ?? DEFAULT_ASSET_PREVIEW_DEPTH,
    }, undefined, instance_id);

    const responseRecord = asRecord(response);
    if (!responseRecord) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ assetId, error: 'Studio returned an invalid asset preview response.' }),
        }],
      };
    }
    const previewError = stringField(responseRecord, 'error');
    if (previewError) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ assetId, error: previewError }),
        }],
      };
    }

    const soundRows = asRows(responseRecord.sounds);
    const soundsByAssetId = new Map<number, Record<string, unknown>[]>();
    for (const sound of soundRows) {
      const soundAssetId = robloxAssetIdFromContentId(
        sound.assetId ?? sound.soundId ?? sound.asset,
      );
      if (soundAssetId === undefined) continue;
      const rows = soundsByAssetId.get(soundAssetId) ?? [];
      rows.push(sound);
      soundsByAssetId.set(soundAssetId, rows);
    }

    let directAudioAsset = false;
    if (includeAudio && soundsByAssetId.size === 0) {
      try {
        const details = await this.openCloudClient.getAssetDetails(assetId);
        const detailsRecord = asRecord(details);
        const assetRecord = asRecord(detailsRecord?.asset);
        if (assetRecord?.assetTypeId === 3) {
          directAudioAsset = true;
          soundsByAssetId.set(assetId, []);
        }
      } catch {
        // Structural preview remains useful when public metadata is unavailable.
      }
    }

    const audioContent: ToolContent[] = [];
    const audioPreviews: Record<string, unknown>[] = [];
    let totalBytes = 0;
    let attempted = 0;
    for (const [soundAssetId, sources] of soundsByAssetId) {
      const isDirectAsset = directAudioAsset && soundAssetId === assetId;
      if (!includeAudio) {
        continue;
      }
      if (attempted >= maxAudioPreviews) {
        audioPreviews.push({
          assetId: soundAssetId,
          status: 'skipped_limit',
          ...(sources.length > 0 ? { references: sources.length } : {}),
          ...(isDirectAsset ? { direct: true } : {}),
        });
        continue;
      }

      const remainingBytes = MAX_INLINE_AUDIO_PREVIEW_TOTAL_BYTES - totalBytes;
      if (remainingBytes <= 0) {
        audioPreviews.push({
          assetId: soundAssetId,
          status: 'skipped_total_size_limit',
          ...(sources.length > 0 ? { references: sources.length } : {}),
          ...(isDirectAsset ? { direct: true } : {}),
        });
        continue;
      }

      attempted++;
      try {
        const downloaded = await this.openCloudClient.downloadAudioAssetContent(
          soundAssetId,
          Math.min(MAX_INLINE_AUDIO_PREVIEW_BYTES, remainingBytes),
        );
        totalBytes += downloaded.data.length;
        audioPreviews.push({
          assetId: soundAssetId,
          status: 'included',
          ...(sources.length > 0 ? { references: sources.length } : {}),
          ...(isDirectAsset ? { direct: true } : {}),
          mimeType: downloaded.mimeType,
          bytes: downloaded.data.length,
          contentIndex: audioContent.length + 1,
        });
        audioContent.push({
          type: 'audio',
          data: downloaded.data.toString('base64'),
          mimeType: downloaded.mimeType,
        });
      } catch (error) {
        audioPreviews.push({
          assetId: soundAssetId,
          status: 'unavailable',
          ...(sources.length > 0 ? { references: sources.length } : {}),
          ...(isDirectAsset ? { direct: true } : {}),
          error: errorMessage(error),
        });
      }
    }

    const summary = asRecord(responseRecord.summary);
    const capabilities = [
      ['hasAnimations', 'animations'],
      ['hasSounds', 'sounds'],
      ['hasParticles', 'particles'],
      ['hasVfx', 'vfx'],
      ['hasDecalsOrTextures', 'decalsOrTextures'],
      ['hasMeshes', 'meshes'],
      ['hasLights', 'lights'],
      ['hasAttachments', 'attachments'],
    ]
      .filter(([field]) => summary?.[field] === true)
      .map(([, label]) => label);
    const classes = asRecord(summary?.classCounts);
    const compactHierarchy = compactPreviewHierarchy(responseRecord.hierarchy);
    const compactBody: Record<string, unknown> = {
      success: true,
      assetId,
      totalInstances: numberField(summary, 'totalInstances'),
      ...(classes && Object.keys(classes).length > 0 ? { classes } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      security: {
        scanDepth: 'unlimited',
        scripts: numberField(summary, 'scriptCount'),
        packageLinks: numberField(summary, 'packageLinkCount'),
      },
      ...(compactHierarchy.hierarchy.length > 0
        ? { hierarchy: compactHierarchy.hierarchy }
        : {}),
      ...(compactHierarchy.truncated ? { hierarchyTruncated: true } : {}),
      ...(soundRows.length > 0
        ? { sounds: soundRows.map(compactSoundReference) }
        : {}),
      ...(directAudioAsset ? { directAudioAsset: true } : {}),
      ...(includeAudio
        ? {
          audio: {
            returned: audioContent.length,
            bytes: totalBytes,
            ...(audioPreviews.length > 0 ? { items: audioPreviews } : {}),
          },
        }
        : {}),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(compactBody),
        },
        ...audioContent,
      ],
    };
  }

  // Decal asset IDs are the wrapper asset; ImageLabel.Image needs the underlying image
  // content ID. The only reliable cross-auth way to resolve this is InsertService:LoadAsset
  // via the connected Studio plugin - the unauthenticated economy endpoint returns 401.
  private async resolveImageId(decalAssetId: string, instance_id?: string): Promise<string | null> {
    const code = `
      local InsertService = game:GetService("InsertService")
      local ok, result = pcall(function() return InsertService:LoadAsset(${decalAssetId}) end)
      if not ok then return nil end
      local decal = result:FindFirstChildWhichIsA("Decal", true)
      local id = decal and decal.Texture:match("(%d+)") or nil
      result:Destroy()
      return id
    `;
    try {
      const response = await this._callSingle('/api/execute-luau', { code }, 'edit', instance_id) as { returnValue?: unknown };
      const returnValue = response?.returnValue;
      if (returnValue !== undefined && returnValue !== null && /^\d+$/.test(String(returnValue))) {
        return String(returnValue);
      }
    } catch {
      // plugin not connected or luau execution failed
    }
    return null;
  }

  private async resolveUploadedReferenceImageId(decalAssetId: string, instance_id?: string): Promise<number> {
    let lastError = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      if (this.openCloudClient.hasApiKey()) {
        try {
          const details = await this.openCloudClient.getAssetDetails(Number(decalAssetId));
          const textureId = details.asset?.textureId;
          if (typeof textureId === 'number' && Number.isFinite(textureId) && textureId > 0) {
            return Math.trunc(textureId);
          }
        } catch (error) {
          lastError = errorMessage(error);
        }
      }

      const studioImageId = await this.resolveImageId(decalAssetId, instance_id);
      if (studioImageId !== null) {
        return Number(studioImageId);
      }

      if (attempt < 9) {
        await sleep(1000);
      }
    }

    const suffix = lastError ? ` Last resolver error: ${lastError}` : '';
    throw new Error(`Reference image upload succeeded, but the backing image asset ID could not be resolved for Decal ${decalAssetId}.${suffix}`);
  }

  private async uploadGenerateModelReferenceImage(
    imageContent: Buffer,
    instance_id?: string,
  ): Promise<number> {
    if (this.cookieClient.hasCookie()) {
      const result = await this.cookieClient.uploadImage({
        fileContent: imageContent,
        fileName: 'generate-model-reference.png',
        displayName: STUDIO_ASSISTANT_SOURCE_IMAGE_LABEL,
        description: STUDIO_ASSISTANT_SOURCE_IMAGE_LABEL,
        userId: process.env.ROBLOX_CREATOR_USER_ID,
        groupId: process.env.ROBLOX_CREATOR_GROUP_ID,
      });
      return result.assetId;
    }

    if (!this.openCloudClient.hasApiKey()) {
      throw new Error(
        'image_path and image_base64 require Roblox asset upload credentials because GenerateModelAsync only accepts rbxassetid:// or rbxasset:// image inputs. Set ROBLOX_OPEN_CLOUD_API_KEY plus ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID, or pass image_asset_id.'
      );
    }

    const resolvedGroupId = process.env.ROBLOX_CREATOR_GROUP_ID;
    const resolvedUserId = process.env.ROBLOX_CREATOR_USER_ID;
    if (!resolvedUserId && !resolvedGroupId) {
      throw new Error(
        'Creator identity required for image upload. Set ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID, or pass image_asset_id.'
      );
    }

    const creator: { userId?: string; groupId?: string } = {};
    if (resolvedGroupId) {
      creator.groupId = resolvedGroupId;
    } else {
      creator.userId = resolvedUserId;
    }

    const result = await this.openCloudClient.createAsset(
      {
        assetType: 'Decal',
        displayName: STUDIO_ASSISTANT_SOURCE_IMAGE_LABEL,
        description: STUDIO_ASSISTANT_SOURCE_IMAGE_LABEL,
        creationContext: { creator },
      },
      imageContent,
      'generate-model-reference.png',
    );

    const decalId = result.response?.assetId;
    if (!decalId || !/^\d+$/.test(decalId)) {
      throw new Error('Reference image upload did not return an asset ID.');
    }
    return this.resolveUploadedReferenceImageId(decalId, instance_id);
  }

  async uploadAsset(
    filePath: string,
    assetType: string,
    displayName: string,
    description?: string,
    userId?: string,
    groupId?: string
  ) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const resolvedGroupId = groupId || process.env.ROBLOX_CREATOR_GROUP_ID;
    const resolvedUserId = userId || process.env.ROBLOX_CREATOR_USER_ID;

    if (assetType === 'Decal' && this.cookieClient.hasCookie()) {
      const result = await this.cookieClient.uploadImage({
        fileContent,
        fileName,
        displayName,
        description: description || '',
        userId: resolvedUserId,
        groupId: resolvedGroupId,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            done: true,
            response: {
              assetId: String(result.assetId),
              displayName,
              assetType: 'Image',
              decalId: null,
              imageId: String(result.assetId),
            },
          })
        }]
      };
    }

    if (!this.openCloudClient.hasApiKey()) {
      const cookieHint = assetType === 'Decal'
        ? ' Alternatively, set ROBLOSECURITY to use cookie auth.'
        : '';
      throw new Error(
        `No auth configured for ${assetType} upload. Set ROBLOX_OPEN_CLOUD_API_KEY (needs asset:write scope).${cookieHint}`
      );
    }

    if (!resolvedUserId && !resolvedGroupId) {
      throw new Error(
        'Creator identity required for Open Cloud upload. Set ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID, or pass userId/groupId as parameters.'
      );
    }

    const creator: { userId?: string; groupId?: string } = {};
    if (resolvedGroupId) {
      creator.groupId = resolvedGroupId;
    } else {
      creator.userId = resolvedUserId;
    }

    const result = await this.openCloudClient.createAsset(
      {
        assetType: assetType as 'Audio' | 'Decal' | 'Model' | 'Animation' | 'Video',
        displayName,
        description: description || '',
        creationContext: { creator },
      },
      fileContent,
      fileName
    );

    // Decals: also resolve the underlying image content ID for ImageLabel.Image usage.
    if (assetType === 'Decal') {
      const decalId = result.response?.assetId;
      const imageId = decalId ? await this.resolveImageId(decalId) : null;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...result,
            decalId: decalId ?? null,
            imageId,
          })
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result)
      }]
    };
  }

  async simulateMouseInput(action: string, x: number, y: number, button?: string, scrollDirection?: string, target?: string, instance_id?: string) {
    if (!action) {
      throw new Error('action is required for simulate_mouse_input');
    }
    // Default to the running playtest client (where the input pipeline lives)
    // when the caller didn't pick a target; fall back to edit otherwise.
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-mouse-input', {
      action, x, y, button
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async simulateKeyboardInput(keyCode?: string, action?: string, duration?: number, text?: string, target?: string, instance_id?: string) {
    if (!keyCode && text === undefined) {
      throw new Error('keyCode or text is required for simulate_keyboard_input');
    }
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-keyboard-input', {
      keyCode, action, duration, text
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async findAndReplaceInScripts(
    pattern: string,
    replacement: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      path?: string;
      classFilter?: string;
      dryRun?: boolean;
      maxReplacements?: number;
    },
    instance_id?: string
  ) {
    if (!pattern) {
      throw new Error('pattern is required for find_and_replace_in_scripts');
    }
    if (replacement === undefined || replacement === null) {
      throw new Error('replacement is required for find_and_replace_in_scripts');
    }
    const response = await this._callSingle('/api/find-and-replace-in-scripts', {
      pattern,
      replacement,
      ...options
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getMemoryBreakdown(target?: string, tags?: string[], instance_id?: string) {
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (tags !== undefined) data.tags = tags;

    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const response = await this.client.request(
        '/api/get-memory-breakdown',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      );
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    const responses = await Promise.allSettled(
      targets.map(async (t) => ({
        peer: t.targetRole,
        result: await this.client.request(
          '/api/get-memory-breakdown',
          data,
          t.targetInstanceId,
          t.targetRole,
        ),
      })),
    );

    const body: Record<string, unknown> = {};
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      const peer = targets[i].targetRole;
      if (r.status === 'fulfilled') {
        body[peer] = r.value.result;
      } else {
        body[peer] = { error: 'disconnected' };
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async getSceneAnalysis(mode?: string, target?: string, topN?: number, raw?: boolean, instance_id?: string) {
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (mode !== undefined) data.mode = mode;
    if (topN !== undefined) data.topN = topN;
    if (raw !== undefined) data.raw = raw;

    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const response = await this.client.request(
        '/api/get-scene-analysis',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      );
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    const responses = await Promise.allSettled(
      targets.map(async (t) => ({
        peer: t.targetRole,
        result: await this.client.request(
          '/api/get-scene-analysis',
          data,
          t.targetInstanceId,
          t.targetRole,
        ),
      })),
    );

    const body: Record<string, unknown> = {};
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      const peer = targets[i].targetRole;
      if (r.status === 'fulfilled') {
        body[peer] = r.value.result;
      } else {
        body[peer] = { error: 'disconnected' };
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async exportRbxm(instancePaths: string[], outputPath: string, target?: string, instance_id?: string) {
    if (!Array.isArray(instancePaths) || instancePaths.length === 0) {
      throw new Error('instance_paths must be a non-empty array for export_rbxm');
    }
    if (!outputPath || typeof outputPath !== 'string') {
      throw new Error('output_path is required for export_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`export_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const response = await this._callSingle(
      '/api/export-rbxm',
      { instance_paths: instancePaths },
      tgt,
      instance_id,
    ) as { error?: string; base64?: string; instance_count?: number };

    if (response.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }] };
    }
    if (!response.base64) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'plugin returned no base64 payload' }) }] };
    }

    const bytes = Buffer.from(response.base64, 'base64');
    const resolved = path.resolve(outputPath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, bytes);
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to write ${resolved}: ${(err as Error).message}` }) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          bytes_written: bytes.length,
          instance_count: response.instance_count ?? instancePaths.length,
          output_path: resolved,
        }),
      }],
    };
  }

  async importRbxm(
    source: { path?: string; url?: string; base64?: string } | undefined,
    parentPath: string,
    target?: string,
    instance_id?: string
  ) {
    if (!source || typeof source !== 'object') {
      throw new Error('source is required for import_rbxm');
    }
    if (!parentPath || typeof parentPath !== 'string') {
      throw new Error('parent_path is required for import_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`import_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const modes = ['path', 'url', 'base64'].filter((k) => (source as Record<string, unknown>)[k] !== undefined);
    if (modes.length !== 1) {
      throw new Error(`source must contain exactly one of { path, url, base64 } (got: ${modes.join(', ') || 'none'})`);
    }

    let bytes: Buffer;
    let sourceLabel: string;
    if (source.path !== undefined) {
      const resolved = path.resolve(source.path);
      try {
        bytes = fs.readFileSync(resolved);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to read ${resolved}: ${(err as Error).message}` }) }] };
      }
      sourceLabel = resolved;
    } else if (source.url !== undefined) {
      // SSRF guard: only http(s). Blocks file://, ftp://, gopher://, etc.
      // Does NOT block requests to internal IPs (127.0.0.1, 169.254.x, RFC1918) —
      // a local MCP server has legitimate reasons to hit localhost, so internal-IP
      // blocking should be opt-in if needed.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(source.url);
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url is not a valid URL: ${source.url}` }) }] };
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url must use http(s); got ${parsedUrl.protocol}` }) }] };
      }

      // 50 MiB matches the project's existing express.json('50mb') cap and is
      // empirically well within the Studio plugin's HttpService:RequestAsync
      // response ceiling (probed up to 100 MiB without issue, 150+ stalls on
      // Studio memory, not protocol). Far above any realistic rbxm size.
      const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
      try {
        const res = await fetch(source.url);
        if (!res.ok) {
          const snippet = (await res.text()).slice(0, 500);
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} returned ${res.status}: ${snippet}` }) }] };
        }
        const claimed = Number(res.headers.get('content-length') ?? '0');
        if (claimed > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: content-length ${claimed} exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        const arr = await res.arrayBuffer();
        if (arr.byteLength > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: downloaded ${arr.byteLength} bytes exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        bytes = Buffer.from(arr);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = source.url;
    } else {
      try {
        bytes = Buffer.from(source.base64 as string, 'base64');
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `base64 decode failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = `base64(${bytes.length}B)`;
    }

    const response = await this._callSingle(
      '/api/import-rbxm',
      {
        base64: bytes.toString('base64'),
        parent_path: parentPath,
        source_label: sourceLabel,
      },
      tgt,
      instance_id,
    );

    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  private async _captureViewportImage(
    instanceId: string,
    targetRole: string,
    format?: string,
    quality?: number,
  ): Promise<EncodedViewportCapture> {
    let response: RawImageCaptureResponse;
    if (targetRole.startsWith('client-')) {
      // Play mode. The running game VM can trigger CaptureScreenshot but can't
      // read the resulting temp texture back (privilege gate). So capture on
      // the client to get the rbxtemp:// id, then read it back in the edit DM —
      // the rbxtemp handle is process-scoped and the edit/plugin identity is
      // allowed to promote it into a readable EditableImage.
      const begin = await this._callSingle('/api/capture-begin', {}, targetRole, instanceId) as { contentId?: string; error?: string };
      if (begin.error) {
        return { success: false, error: begin.error };
      }
      if (!begin.contentId) {
        return { success: false, error: 'Screenshot capture failed: no content id returned from client.' };
      }
      response = await this._callSingle('/api/capture-read', { contentId: begin.contentId }, 'edit', instanceId) as RawImageCaptureResponse;
    } else {
      // Edit mode: capture and read back in the same (edit) context.
      response = await this._callSingle('/api/capture-screenshot', {}, 'edit', instanceId) as RawImageCaptureResponse;
    }

    if (response.error) {
      let text = response.error;
      if (
        targetRole.startsWith('client-') &&
        response.error.includes('Failed to load texture, unexpected format') &&
        await this._isMultiplayerTestRunning(instanceId)
      ) {
        text =
          'Screenshot capture reached the multiplayer client, but Roblox returned a temporary screenshot texture ' +
          'that the edit peer cannot read in StudioTestService multiplayer sessions. Regular solo_playtest capture ' +
          'works because the temporary rbxtemp:// handle is readable from the edit process; multiplayer client handles ' +
          `appear to be scoped to the client process. Raw error: ${response.error}`;
      }
      return { success: false, error: text };
    }

    const w = response.width;
    const h = response.height;
    if (w === undefined || h === undefined) {
      return { success: false, error: 'Screenshot response missing dimensions.' };
    }

    const fmt: 'jpeg' | 'png' = format === 'png' ? 'png' : 'jpeg';
    const q = quality === undefined ? 92 : Math.max(1, Math.min(100, Math.floor(quality)));

    // Cap the inline image size. Measured empirically: an ~8MB image (11MB
    // base64) returns fine, but ~16MB (22MB base64) CLOSES the MCP connection
    // and drops every Studio registration — a catastrophic failure, not a
    // graceful error. 6MB is in the proven-safe range with comfortable margin.
    // For PNG we refuse (rather than silently dropping the lossless guarantee
    // the caller asked for); for JPEG we step quality down so the call still
    // succeeds.
    const encoded = encodeImageFromRgbaResponse(response, fmt, q);
    let { buffer } = encoded;
    const { mimeType } = encoded;
    let usedQ = q;
    let note = '';

    if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
      if (fmt === 'png') {
        const mb = (buffer.length / 1048576).toFixed(1);
        return {
          success: false,
          error:
            `PNG screenshot is ${mb}MB, over the ~${(MAX_INLINE_IMAGE_BYTES / 1048576).toFixed(0)}MB inline image limit. ` +
            `Use the default jpeg format (optionally with a "quality" value) or make the Studio window smaller for a lossless capture.`,
        };
      }
      while (buffer.length > MAX_INLINE_IMAGE_BYTES && usedQ > 25) {
        usedQ = Math.max(25, usedQ - 20);
        buffer = encodeImageFromRgbaResponse(response, 'jpeg', usedQ).buffer;
      }
      note = ` — auto-reduced to q${usedQ} to fit the inline size limit; enlarge the Studio window or capture a smaller region for finer detail`;
    }

    // Explicit coordinate contract: the image is returned at native viewport
    // resolution and is never downscaled, so its pixel grid IS the coordinate
    // space simulate_mouse_input expects. Stating the dimensions removes any
    // ambiguity about what (x, y) mean.

    const message =
      `Screenshot ${w}x${h}px (${fmt}${fmt === 'jpeg' ? ` q${usedQ}` : ''})${note}. ` +
      `For simulate_mouse_input, x/y are pixel coordinates in this exact image with (0,0) at the ` +
      `top-left; it is not downscaled, so use coordinates as you read them off the image.`;

    return {
      success: true,
      width: w,
      height: h,
      format: fmt,
      quality: fmt === 'jpeg' ? usedQ : undefined,
      note,
      data: buffer.toString('base64'),
      mimeType,
      message,
    };
  }

  async captureScreenshot(instance_id?: string, format?: string, quality?: number) {
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const capture = await this._captureViewportImage(instanceId, clientRole ?? 'edit', format, quality);
    if (!capture.success) {
      return this._textResult({ error: capture.error });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            width: capture.width,
            height: capture.height,
            format: capture.format,
            mimeType: capture.mimeType,
            ...(capture.quality === undefined ? {} : { quality: capture.quality }),
          }),
        },
        {
          type: 'image',
          data: capture.data,
          mimeType: capture.mimeType,
        },
      ],
    };
  }
}

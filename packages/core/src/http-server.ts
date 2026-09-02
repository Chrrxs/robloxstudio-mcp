import express from 'express';
import type { Express } from 'express';
import http from 'http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService, RoutingFailure } from './bridge-service.js';
import type { PublicStudioInstance, PublicStudioPeer, RegisterPeerResult } from './bridge-service.js';
import type { ToolDefinition } from './tools/definitions.js';
import { createToolHttpHandler, normalizeToolResult, publicToolErrorBody } from './mcp-runtime.js';
import type { ToolInvocationContext } from './mcp-runtime.js';
import { tokensMatch } from './auth.js';
import { StudioLaunchPreDispatchError } from './studio-instance-manager.js';
import {
  SseStudioTransport,
  MAX_ACTIVE_EVENT_STREAMS,
  type EventStreamHandle,
  type StudioStatusEvent,
} from './studio-transport.js';

export interface HttpSecurityOptions {
  /** When set, tool-invoking endpoints require this token. */
  authToken?: string;
  /** Where the token came from — used to build a helpful 401 message. */
  authTokenHint?: string;
  /** Origins allowed to make cross-origin (browser) requests. Default: none. */
  allowedOrigins?: string[];
}

export interface RobloxStudioHttpApp extends Express {
  isPluginConnected(): boolean;
  setMCPServerActive(active: boolean): void;
  isMCPServerActive(): boolean;
  trackMCPActivity(): void;
  closeMcpHandler(): Promise<void> | undefined;
  cleanup(): Promise<void>;
}

interface StreamableHttpConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

type PassiveStudioPeer = Omit<PublicStudioPeer, 'peerId'>;
type PassiveStudioInstance = Omit<PublicStudioInstance, 'peers'> & {
  peers: PassiveStudioPeer[];
};

function toPassivePeer(peer: PublicStudioPeer): PassiveStudioPeer {
  return {
    instanceId: peer.instanceId,
    multiplayerGroupId: peer.multiplayerGroupId,
    role: peer.role,
    placeId: peer.placeId,
    placeName: peer.placeName,
    placeKey: peer.placeKey,
    dataModelName: peer.dataModelName,
    isRunning: peer.isRunning,
    pluginVersion: peer.pluginVersion,
    pluginVariant: peer.pluginVariant,
    serverVersion: peer.serverVersion,
    lastActivity: peer.lastActivity,
    connectedAt: peer.connectedAt,
  };
}

function toPassiveInstance(instance: PublicStudioInstance): PassiveStudioInstance {
  return {
    id: instance.id,
    multiplayerGroupId: instance.multiplayerGroupId,
    placeId: instance.placeId,
    placeName: instance.placeName,
    peers: instance.peers.map(toPassivePeer),
  };
}

export type ToolHandler = (
  tools: RobloxStudioTools,
  body: any,
  context?: ToolInvocationContext,
) => Promise<any>;

type ParsedLineRange = {
  startLine?: number;
  endLine?: number;
};

/**
 * Normalize a line_range string into internal [startLine, endLine] coordinates.
 * Accepts "100-200", "100:200", open-ended "100-" / "-200", or a single "42".
 * Returns undefined when nothing usable is present.
 */
export function parseLineRange(lineRange: unknown): ParsedLineRange | undefined {
  const validLine = (line: number | undefined) => line === undefined || line >= 1;
  if (typeof lineRange === 'string') {
    const ranged = lineRange.match(/^\s*(\d+)?\s*[-:]\s*(\d+)?\s*$/);
    if (ranged) {
      const s = ranged[1] !== undefined ? parseInt(ranged[1], 10) : undefined;
      const e = ranged[2] !== undefined ? parseInt(ranged[2], 10) : undefined;
      if (!validLine(s) || !validLine(e)) return undefined;
      if (s !== undefined && e !== undefined && s > e) return undefined;
      if (s !== undefined || e !== undefined) return { startLine: s, endLine: e };
    }
    const single = lineRange.match(/^\s*(\d+)\s*$/);
    if (single) {
      const n = parseInt(single[1], 10);
      if (n < 1) return undefined;
      return { startLine: n, endLine: n };
    }
  }
  return undefined;
}

function optionalLineRange(body: any, toolName: string): ParsedLineRange {
  if (body.line_range === undefined) return {};
  const parsed = parseLineRange(body.line_range);
  if (!parsed) throw new Error(`${toolName} line_range must be a string like "42", "10-20", "10-", or "-20"`);
  return parsed;
}

function optionalLineAnchor(body: any, toolName: string): number | undefined {
  const parsed = optionalLineRange(body, toolName);
  if (parsed.startLine === undefined && parsed.endLine === undefined) return undefined;
  if (parsed.startLine === undefined || parsed.endLine === undefined || parsed.endLine !== parsed.startLine) {
    throw new Error(`${toolName} line_range must be a single line like "42"`);
  }
  return parsed.startLine;
}

function requiredClosedLineRange(body: any, toolName: string): { startLine: number; endLine: number } {
  const parsed = optionalLineRange(body, toolName);
  if (parsed.startLine === undefined || parsed.endLine === undefined) {
    throw new Error(`${toolName} requires line_range as "start-end" or a single line like "42"`);
  }
  return { startLine: parsed.startLine, endLine: parsed.endLine };
}

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_roblox_skills: (tools, body) => tools.getRobloxSkills(body.action, body.name),
  get_roblox_docs: (tools, body) => tools.getRobloxDocs(body.name, body.doc_type, body.section),
  get_place_info: (tools, body) => tools.getPlaceInfo(body.instance_id),
  search_objects: (tools, body) => tools.searchObjects(body.query, body.searchType, body.propertyName, body.instance_id),
  get_instance_properties: (tools, body) => tools.getInstanceProperties(body.instancePath, body.excludeSource, body.instance_id),
  get_project_structure: (tools, body) => tools.getProjectStructure(body.path, body.maxDepth, body.scriptsOnly, body.instance_id),
  set_properties: (tools, body) => tools.setProperties(body.instancePath, body.properties, body.instance_id),
  grep_scripts: (tools, body, context) => tools.grepScripts(body.pattern, {
    caseSensitive: body.caseSensitive,
    usePattern: body.usePattern,
    contextLines: body.contextLines,
    maxResults: body.maxResults,
    maxResultsPerScript: body.maxResultsPerScript,
    filesOnly: body.filesOnly,
    path: body.path,
    classFilter: body.classFilter,
  }, body.instance_id, context?.signal),
  get_script_source: (tools, body) => {
    const { startLine, endLine } = optionalLineRange(body, 'get_script_source');
    return tools.getScriptSource(body.instancePath, startLine, endLine, body.instance_id);
  },
  set_script_source: (tools, body) => tools.setScriptSource(body.instancePath, body.source, body.instance_id),
  edit_script_lines: (tools, body) => tools.editScriptLines(body.instancePath, body.old_string, body.new_string, optionalLineAnchor(body, 'edit_script_lines'), body.instance_id),
  insert_script_lines: (tools, body) => tools.insertScriptLines(body.instancePath, body.afterLine, body.newContent, body.instance_id),
  delete_script_lines: (tools, body) => {
    const { startLine, endLine } = requiredClosedLineRange(body, 'delete_script_lines');
    return tools.deleteScriptLines(body.instancePath, startLine, endLine, body.instance_id);
  },
  get_attributes: (tools, body) => tools.getAttributes(body.instancePath, body.instance_id),
  selection: (tools, body) => tools.selection(body.action, body, body.instance_id),
  execute_luau: (tools, body) => tools.executeLuau(body.code, body.target, body.instance_id),
  eval_server_runtime: (tools, body) => tools.evalServerRuntime(body.code, body.instance_id),
  eval_client_runtime: (tools, body) => tools.evalClientRuntime(body.code, body.target, body.instance_id),
  set_network_profile: (tools, body) => tools.setNetworkProfile(body.profile, body.target, body.overrides, body.instance_id),
  get_simulation_state: (tools, body) => tools.getSimulationState(body.include, body.target, body.instance_id),
  reset_simulation_state: (tools, body) => tools.resetSimulationState(body.target, body.network, body.deviceSimulator, body.instance_id),
  get_device_simulator_state: (tools, body) => tools.getDeviceSimulatorState(body.target, body.deviceId, body.includeDeviceList, body.instance_id),
  set_device_simulator: (tools, body) => tools.setDeviceSimulator(body.target, body.deviceId, body.orientation, body.resolution, body.pixelDensity, body.scalingMode, body.stopSimulation, body.instance_id),
  capture_device_matrix: (tools, body) => tools.captureDeviceMatrix(body.entries, body.target, body.format, body.quality, body.settleSeconds, body.restoreAfter, body.instance_id),
  manage_instance: (tools, body) => tools.manageInstance(body),
  solo_playtest: (tools, body) => tools.soloPlaytest(body.action, body.mode, body.timeout, body.instance_id),
  multiplayer_playtest: (tools, body) => tools.multiplayerPlaytest(body.action, body.numPlayers, body.target, body.testArgs, body.value, body.timeout, body.instance_id),
  get_runtime_logs: (tools, body) => tools.getRuntimeLogs(body.instance_id, body.multiplayer_group_id, body.cursor, body.cursor_by_instance, body.tail, body.filter),
  capture_script_profiler: (tools, body) => tools.captureScriptProfiler(body.target, {
    duration_ms: body.duration_ms,
    frequency: body.frequency,
    max_functions: body.max_functions,
    min_total_us: body.min_total_us,
    filter: body.filter,
    include_native: body.include_native,
    include_plugin: body.include_plugin,
    output_path: body.output_path,
  }, body.instance_id),
  capture_micro_profiler: (tools, body) => tools.captureMicroProfiler(body.target, {
    duration_ms: body.duration_ms,
    focus: body.focus,
    filter: body.filter,
    max_timers: body.max_timers,
    min_total_us: body.min_total_us,
    include_idle: body.include_idle,
    include_gpu: body.include_gpu,
    max_events: body.max_events,
    frame_window: body.frame_window,
    max_groups: body.max_groups,
    max_timers_per_group: body.max_timers_per_group,
    summary_output_path: body.summary_output_path,
    baseline_path: body.baseline_path,
    baseline: body.baseline,
    baseline_label: body.baseline_label,
    current_label: body.current_label,
    max_comparison_rows: body.max_comparison_rows,
    output_path: body.output_path,
  }, body.instance_id),
  breakpoints: (tools, body) => tools.breakpoints(body.action, body, body.target, body.instance_id),
  get_connected_instances: (tools) => tools.getConnectedInstances(),
  search_assets: (tools, body) => tools.searchAssets(body.assetType, body.query, body.maxResults, body.sortBy, body.robloxCreatedOnly),
  get_asset_details: (tools, body) => tools.getAssetDetails(body.assetId),
  get_asset_thumbnail: (tools, body) => tools.getAssetThumbnail(body.assetId, body.size),
  insert_asset: (tools, body) => tools.insertAsset(body.assetId, body.parentPath, body.position, body.instance_id),
  generate_model: (tools, body) => tools.generateModel(body, body.instance_id),
  preview_asset: (tools, body) => tools.previewAsset(
    body.assetId,
    body.includeProperties,
    body.maxDepth,
    body.instance_id,
    body.includeAudio,
    body.maxAudioPreviews,
  ),
  upload_asset: (tools, body) => tools.uploadAsset(body.filePath, body.assetType, body.displayName, body.description, body.userId, body.groupId),
  capture_screenshot: (tools, body) => tools.captureScreenshot(body.instance_id, body.format, body.quality),
  simulate_mouse_input: (tools, body) => tools.simulateMouseInput(body.action, body.x, body.y, body.button, body.scrollDirection, body.target, body.instance_id),
  simulate_keyboard_input: (tools, body) => tools.simulateKeyboardInput(body.keyCode, body.action, body.duration, body.text, body.target, body.instance_id),
  get_memory_breakdown: (tools, body) => tools.getMemoryBreakdown(body.target, body.tags, body.instance_id),
  get_scene_analysis: (tools, body) => tools.getSceneAnalysis(body.mode, body.target, body.topN, body.raw, body.instance_id),
  export_rbxm: (tools, body) => tools.exportRbxm(body.instance_paths, body.output_path, body.target, body.instance_id),
  import_rbxm: (tools, body) => tools.importRbxm(body.source, body.parent_path, body.target, body.instance_id),
  find_and_replace_in_scripts: (tools, body) => tools.findAndReplaceInScripts(body.pattern, body.replacement, {
    caseSensitive: body.caseSensitive,
    usePattern: body.usePattern,
    path: body.path,
    classFilter: body.classFilter,
    dryRun: body.dryRun,
    maxReplacements: body.maxReplacements,
  }, body.instance_id),
};

export function createHttpServer(tools: RobloxStudioTools, bridge: BridgeService, allowedTools?: Set<string>, serverConfig?: StreamableHttpConfig, security?: HttpSecurityOptions): RobloxStudioHttpApp {
  // Express cannot know about the lifecycle controls attached below.
  const app = express() as unknown as RobloxStudioHttpApp;
  const studioLifecycleCallable = !allowedTools || allowedTools.has('manage_instance');
  const studioLifecycleCapabilities = studioLifecycleCallable
    ? tools.getStudioLifecycleCapabilities()
    : undefined;
  let mcpServerActive = false;
  let lastMCPActivity = 0;
  let mcpServerStartTime = 0;
  const proxyInstances = new Set<string>();
  const rejectedVersionPeers = new Set<string>();
  const eventTransport = new SseStudioTransport(bridge);
  const eventStreamHandles = new Set<EventStreamHandle>();

  const setMCPServerActive = (active: boolean) => {
    mcpServerActive = active;
    if (active) {
      mcpServerStartTime = Date.now();
      lastMCPActivity = Date.now();
    } else {
      mcpServerStartTime = 0;
      lastMCPActivity = 0;
    }
    eventTransport.refreshStatus();
  };

  const trackMCPActivity = () => {
    if (mcpServerActive) {
      const wasConnected = (Date.now() - lastMCPActivity) < 30000;
      lastMCPActivity = Date.now();
      if (!wasConnected) eventTransport.refreshStatus();
    }
  };

  const isMCPServerActive = () => {
    if (!mcpServerActive) return false;
    return (Date.now() - lastMCPActivity) < 30000;
  };

  const eventStatus = (transportPeerId: string): StudioStatusEvent => {
    const peer = bridge.getPeerById(transportPeerId);
    const knownPeer = peer?.transportPeerId === transportPeerId;
    return {
      kind: 'status',
      knownPeer,
      mcpConnected: isMCPServerActive(),
      serverVersion: serverConfig?.version,
      pluginVersion: peer?.pluginVersion,
      pluginVariant: peer?.pluginVariant,
    };
  };


  const isPluginConnected = () => {
    return bridge.getPeers().length > 0;
  };

  // -- Origin policy --
  // The Studio plugin is a native HTTP client and never sends an Origin
  // header. Any request that DOES carry one comes from a browser context; we
  // reject it unless the origin is explicitly allowlisted. This replaces the
  // previous blanket `cors()` (allow-all), which let any web page drive the
  // API via the victim's browser.
  const allowedOrigins = new Set(security?.allowedOrigins ?? []);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') {
      next();
      return;
    }
    if (!allowedOrigins.has(origin)) {
      res.status(403).json({
        error: 'forbidden_origin',
        message: `Cross-origin requests are not allowed from ${origin}. ` +
          'Set ROBLOX_STUDIO_ALLOWED_ORIGINS to allowlist specific origins.',
      });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MCP-Auth, Mcp-Protocol-Version, Mcp-Method, Mcp-Name');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // -- Shared-secret auth --
  // Tool-invoking endpoints require the token; plugin-facing endpoints
  // (/ready, /events, /response, /disconnect) and passive status endpoints
  // stay open because the Studio plugin cannot read local files. These routes
  // only register or receive downstream work; they cannot invoke tools.
  const authToken = security?.authToken;
  const authRequired = (path: string) =>
    path === '/mcp' || path.startsWith('/mcp/') ||
    path === '/proxy' || path === '/topology' || path === '/unregister-instance-id' ||
    path === '/create-multiplayer-group' || path === '/remove-multiplayer-group';
  app.use((req, res, next) => {
    if (!authToken || !authRequired(req.path)) {
      next();
      return;
    }
    const headerToken = req.headers['x-mcp-auth'];
    const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined;
    const provided = typeof headerToken === 'string' && headerToken !== '' ? headerToken : bearer;
    if (provided !== undefined && tokensMatch(provided, authToken)) {
      next();
      return;
    }
    res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid auth token. Send it as "X-MCP-Auth: <token>" or "Authorization: Bearer <token>". ' +
        (security?.authTokenHint ?? 'The token is in ~/.robloxstudio-mcp/auth-token (or ROBLOX_STUDIO_AUTH_TOKEN).'),
    });
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));


  app.get('/health', (req, res) => {
    const peers = bridge.getPublicPeers().map(toPassivePeer);
    const instances = bridge.getPublicInstances().map(toPassiveInstance);
    const multiplayerGroups = bridge.getPublicMultiplayerGroups();
    res.json({
      status: 'ok',
      service: 'robloxstudio-mcp',
      serverName: serverConfig?.name ?? 'robloxstudio-mcp',
      version: serverConfig?.version,
      serverVersion: serverConfig?.version,
      capabilities: studioLifecycleCallable ? {
        studioLifecycle: {
          protocolVersion: 3,
          endpoint: '/mcp/manage_instance',
          hostPlatform: studioLifecycleCapabilities?.hostPlatform,
          windowsInteropAvailable: studioLifecycleCapabilities?.windowsInteropAvailable,
          processIdentity: studioLifecycleCapabilities?.processIdentity,
        },
      } : {},
      pluginConnected: peers.length > 0,
      instanceCount: instances.length,
      peerCount: peers.length,
      instances,
      peers,
      multiplayerGroups,
      mcpServerActive: isMCPServerActive(),
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0,
      pendingRequests: bridge.getPendingRequestCount(),
      proxyInstanceCount: proxyInstances.size,
      activeEventStreams: eventTransport.activeStreamCount,
      streamableHttp: !!serverConfig,
    });
  });


  app.post('/ready', (req, res) => {
    const {
      peerId,
      transportPeerId,
      instanceId,
      multiplayerGroupId,
      role,
      placeId,
      placeName,
      placeKey,
      dataModelName,
      isRunning,
      pluginVersion,
      pluginVariant,
      timestamp,
    } = req.body;
    const requestContext = {
      peerId: typeof peerId === 'string' ? peerId : undefined,
      transportPeerId: typeof transportPeerId === 'string' ? transportPeerId : undefined,
      instanceId: typeof instanceId === 'string' ? instanceId : undefined,
      multiplayerGroupId: typeof multiplayerGroupId === 'string' ? multiplayerGroupId : undefined,
      role: typeof role === 'string' ? role : undefined,
      placeId: typeof placeId === 'number' ? placeId : undefined,
      placeName: typeof placeName === 'string' ? placeName : undefined,
      placeKey: typeof placeKey === 'string' ? placeKey : undefined,
      dataModelName: typeof dataModelName === 'string' ? dataModelName : undefined,
      isRunning: typeof isRunning === 'boolean' ? isRunning : undefined,
      pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : undefined,
      pluginVariant: typeof pluginVariant === 'string' ? pluginVariant : undefined,
      timestamp: typeof timestamp === 'number' ? timestamp : undefined,
    };

    const missingFields = [
      typeof peerId !== 'string' || peerId === '' ? 'peerId' : undefined,
      typeof transportPeerId !== 'string' || transportPeerId === '' ? 'transportPeerId' : undefined,
      typeof instanceId !== 'string' || instanceId === '' ? 'instanceId' : undefined,
      typeof role !== 'string' || role === '' ? 'role' : undefined,
      typeof placeId !== 'number' || !Number.isFinite(placeId) ? 'placeId' : undefined,
      typeof placeName !== 'string' ? 'placeName' : undefined,
      typeof dataModelName !== 'string' ? 'dataModelName' : undefined,
      typeof isRunning !== 'boolean' ? 'isRunning' : undefined,
      typeof pluginVersion !== 'string' || pluginVersion === '' ? 'pluginVersion' : undefined,
      typeof pluginVariant !== 'string' || pluginVariant === '' ? 'pluginVariant' : undefined,
      typeof timestamp !== 'number' || !Number.isFinite(timestamp) ? 'timestamp' : undefined,
    ].filter((field): field is string => !!field);
    if (missingFields.length > 0) {
      res.status(400).json({
        success: false,
        error: 'missing_ready_fields',
        message: `/ready missing required field(s): ${missingFields.join(', ')}`,
        missingFields,
        request: requestContext,
      });
      return;
    }
    if (multiplayerGroupId !== undefined && (typeof multiplayerGroupId !== 'string' || multiplayerGroupId === '')) {
      res.status(400).json({
        success: false,
        error: 'invalid_multiplayer_group_id',
        message: 'multiplayerGroupId must be a non-empty string when provided.',
        request: requestContext,
      });
      return;
    }

    const serverVersion = serverConfig?.version;
    if (!serverVersion) {
      res.status(503).json({
        success: false,
        error: 'server_version_unavailable',
        message: 'The MCP server cannot accept Studio connections without a configured version.',
        request: requestContext,
      });
      return;
    }
    if (pluginVersion !== serverVersion) {
      if (!rejectedVersionPeers.has(peerId)) {
        if (rejectedVersionPeers.size >= 256) rejectedVersionPeers.clear();
        rejectedVersionPeers.add(peerId);
        console.error(
          `[plugin-version-rejected] Studio plugin v${pluginVersion} (${pluginVariant}) ` +
          `does not match MCP server v${serverVersion} for ${instanceId}/${role}`,
        );
      }
      res.status(426).json({
        success: false,
        error: 'plugin_version_mismatch',
        message: `Studio plugin v${pluginVersion} does not match MCP server v${serverVersion}.`,
        pluginVersion,
        serverVersion,
        request: requestContext,
      });
      return;
    }

    const isClientRole = role === 'client' || /^client-[1-9]\d*$/.test(role);
    const isProxiedPeer = transportPeerId !== peerId;
    if (
      (isProxiedPeer && !isClientRole) ||
      (!isProxiedPeer && isClientRole) ||
      (!isClientRole && role !== 'edit' && role !== 'server')
    ) {
      res.status(400).json({
        success: false,
        error: 'invalid_peer_topology',
        message: 'Transport Peers must use the edit or server role; client Peers must use a distinct server transport Peer.',
        request: requestContext,
      });
      return;
    }

    if (isProxiedPeer) {
      const transportOwner = bridge.getPeerById(transportPeerId);
      const sameInstance = transportOwner?.instanceId === instanceId;
      const sameMultiplayerGroup = typeof multiplayerGroupId === 'string'
        && transportOwner?.multiplayerGroupId === multiplayerGroupId;
      if (
        !transportOwner ||
        transportOwner.peerId !== transportPeerId ||
        transportOwner.transportPeerId !== transportPeerId ||
        transportOwner.role !== 'server' ||
        (!sameInstance && !sameMultiplayerGroup)
      ) {
        res.status(409).json({
          success: false,
          error: 'transport_peer_unavailable',
          message: 'A client Peer requires a registered server transport Peer in the same Instance or explicit MultiplayerGroup.',
          request: requestContext,
        });
        return;
      }
    }

    let result: RegisterPeerResult;
    try {
      result = bridge.registerPeer({
        peerId,
        transportPeerId,
        instanceId,
        multiplayerGroupId,
        role,
        placeId,
        placeName,
        placeKey: typeof placeKey === 'string' ? placeKey : undefined,
        dataModelName,
        isRunning,
        pluginVersion,
        pluginVariant,
        serverVersion,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: 'ready_registration_exception',
        message: err instanceof Error ? err.message : String(err),
        request: requestContext,
      });
      return;
    }

    if (!result.ok) {
      res.status(409).json({
        success: false,
        error: result.error.code,
        message: result.error.message,
        request: requestContext,
        existing: result.error.existing,
      });
      return;
    }
    eventTransport.refreshStatus(transportPeerId);

    res.json({
      success: true,
      assignedRole: result.assignedRole,
      peerId: result.peerId,
      instanceId: result.instanceId,
      multiplayerGroupId: result.multiplayerGroupId,
      serverVersion,
    });
  });


  app.post('/disconnect', (req, res) => {
    const { peerId } = req.body;

    if (typeof peerId === 'string' && peerId !== '') {
      bridge.unregisterPeer(peerId);
    }
    res.json({ success: true });
  });

  app.post('/unregister-instance-id', async (req, res) => {
    const { instanceId } = req.body;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      res.status(400).json({ error: 'instanceId is required' });
      return;
    }

    const removed = await bridge.unregisterInstanceIdEverywhere(instanceId);
    res.json({ success: true, removed });
  });
  app.post('/create-multiplayer-group', async (req, res) => {
    const { groupId, controllerInstanceId } = req.body;
    if (
      typeof groupId !== 'string' ||
      groupId.length === 0 ||
      typeof controllerInstanceId !== 'string' ||
      controllerInstanceId.length === 0
    ) {
      res.status(400).json({ error: 'groupId and controllerInstanceId are required' });
      return;
    }
    const group = await bridge.createMultiplayerGroupEverywhere(groupId, controllerInstanceId);
    res.json({ success: true, group });
  });
  app.post('/remove-multiplayer-group', async (req, res) => {
    const { groupId } = req.body;
    if (typeof groupId !== 'string' || groupId.length === 0) {
      res.status(400).json({ error: 'groupId is required' });
      return;
    }
    const removed = await bridge.removeMultiplayerGroupEverywhere(groupId);
    res.json({ success: true, removed });
  });



  app.get('/status', (req, res) => {
    const peers = bridge.getPublicPeers().map(toPassivePeer);
    const instances = bridge.getPublicInstances().map(toPassiveInstance);
    const multiplayerGroups = bridge.getPublicMultiplayerGroups();
    res.json({
      pluginConnected: peers.length > 0,
      instanceCount: instances.length,
      peerCount: peers.length,
      instances,
      peers,
      multiplayerGroups,
      serverVersion: serverConfig?.version,
      mcpServerActive: isMCPServerActive(),
      lastMCPActivity,
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0,
    });
  });


  app.get('/topology', (req, res) => {
    res.json({
      ...bridge.getTopologySnapshot(),
      serverVersion: serverConfig?.version,
    });
  });

  app.get('/events', (req, res) => {
    const peerId = typeof req.query.peerId === 'string'
      ? req.query.peerId
      : undefined;
    if (!peerId) {
      res.status(400).json({
        error: 'missing_peer_id',
        message: 'peerId is required',
      });
      return;
    }

    const peer = bridge.getPeerById(peerId);
    if (!peer) {
      res.status(404).json({
        error: 'unknown_peer',
        knownPeer: false,
      });
      return;
    }
    if (peer.transportPeerId !== peerId) {
      res.status(409).json({
        error: 'peer_has_no_event_stream',
        transportPeerId: peer.transportPeerId,
      });
      return;
    }
    if (!eventTransport.canOpen(peerId)) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        error: 'event_stream_capacity_reached',
        capacity: MAX_ACTIVE_EVENT_STREAMS,
      });
      return;
    }

    bridge.updatePeerActivity(peerId);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const handle = eventTransport.open(
      peerId,
      res,
      () => eventStatus(peerId),
    );
    if (!handle) {
      res.end();
      return;
    }
    eventStreamHandles.add(handle);
    res.once('close', () => eventStreamHandles.delete(handle));
  });




  app.post('/response', (req, res) => {
    const { requestId, response, error } = req.body;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      res.status(400).json({
        success: false,
        error: 'invalid_request_id',
      });
      return;
    }

    const disposition = error !== undefined
      ? bridge.rejectRequest(requestId, error)
      : bridge.resolveRequest(requestId, response);
    if (disposition === 'unknown') {
      res.status(404).json({ success: false, disposition });
      return;
    }

    res.json({ success: true, disposition });
  });


  app.post('/proxy', async (req, res) => {
    const { endpoint, data, targetPeerId, proxyInstanceId, timeoutMs } = req.body;

    if (!endpoint || !targetPeerId) {
      res.status(400).json({ error: 'endpoint and targetPeerId are required' });
      return;
    }

    if (
      timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    ) {
      res.status(400).json({ error: 'timeoutMs must be an integer between 1 and 300000' });
      return;
    }

    if (proxyInstanceId) {
      proxyInstances.add(proxyInstanceId);
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const response = await bridge.sendRequest(
        endpoint,
        data,
        targetPeerId,
        timeoutMs,
        controller.signal,
      );
      res.json({ response });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Proxy request failed',
        });
      }
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });


  // One v2 protocol boundary serves modern 2026-07-28 requests and the
  // stateless 2025 compatibility path from the same tool factory.
  const mcpHandler = serverConfig
    ? createToolHttpHandler({
        config: serverConfig,
        getTools: () => tools,
        allowedTools,
        invoke: async (currentTools, name, args, context) => {
          const handler = TOOL_HANDLERS[name];
          if (!handler) throw new Error(`Unknown tool: ${name}`);
          return handler(currentTools, args, context);
        },
      })
    : undefined;
  const nodeMcpHandler = mcpHandler ? toNodeHandler(mcpHandler) : undefined;

  if (nodeMcpHandler) {
    app.all('/mcp', async (req, res) => {
      trackMCPActivity();
      await nodeMcpHandler(req, res, req.body);
    });
  }

  app.use('/mcp/*', (req, res, next) => {
    trackMCPActivity();
    next();
  });

  // Register /mcp/* routes dynamically based on allowedTools
  for (const [toolName, handler] of Object.entries(TOOL_HANDLERS)) {
    if (allowedTools && !allowedTools.has(toolName)) continue;

    app.post(`/mcp/${toolName}`, async (req, res) => {
      try {
        const result = normalizeToolResult(await handler(tools, req.body), 'modern');
        if (result.structuredContent && result.content.length === 0) {
          res.json(result.structuredContent);
        } else {
          res.json(result);
        }
      } catch (error) {
        const status = error instanceof StudioLaunchPreDispatchError
          ? error.statusCode
          : error instanceof RoutingFailure ? 400 : 500;
        res.status(status).json(publicToolErrorBody(toolName, error));
      }
    });
  }


  app.isPluginConnected = isPluginConnected;
  app.setMCPServerActive = setMCPServerActive;
  app.isMCPServerActive = isMCPServerActive;
  app.trackMCPActivity = trackMCPActivity;
  app.closeMcpHandler = () => mcpHandler?.close();
  app.cleanup = async () => {
    for (const handle of eventStreamHandles) handle.close();
    eventStreamHandles.clear();
    eventTransport.close();
    await mcpHandler?.close();
  };

  return app;
}

/**
 * Attempt to bind an Express app to a port, using an explicit http.Server
 * so that EADDRINUSE errors are properly caught.
 */
export async function listenWithRetry(
  app: express.Express,
  host: string,
  startPort: number,
  maxAttempts: number = 5
): Promise<{ server: http.Server; port: number }> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      const server = await bindPort(app, host, port);
      return { server, port };
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EADDRINUSE'
      ) {
        console.error(`Port ${port} in use, trying next...`);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`All ports ${startPort}-${startPort + maxAttempts - 1} are in use. Stop some MCP server instances and retry.`);
}

function bindPort(app: express.Express, host: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}

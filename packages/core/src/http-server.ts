import express from 'express';
import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService, RoutingFailure, toPublic } from './bridge-service.js';
import type { RegisterInstanceResult } from './bridge-service.js';
import type { ToolDefinition } from './tools/definitions.js';
import { registerResourceHandlers } from './mcp-compat.js';
import { tokensMatch } from './auth.js';
import { StudioLaunchPreDispatchError } from './studio-instance-manager.js';

export interface HttpSecurityOptions {
  /** When set, tool-invoking endpoints require this token. */
  authToken?: string;
  /** Where the token came from — used to build a helpful 401 message. */
  authTokenHint?: string;
  /** Origins allowed to make cross-origin (browser) requests. Default: none. */
  allowedOrigins?: string[];
}

interface StreamableHttpConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export type ToolHandler = (tools: RobloxStudioTools, body: any) => Promise<any>;

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
  get_file_tree: (tools, body) => tools.getFileTree(body.path, body.instance_id),
  search_files: (tools, body) => tools.searchFiles(body.query, body.searchType, body.instance_id),
  get_place_info: (tools, body) => tools.getPlaceInfo(body.instance_id),
  get_services: (tools, body) => tools.getServices(body.serviceName, body.instance_id),
  search_objects: (tools, body) => tools.searchObjects(body.query, body.searchType, body.propertyName, body.instance_id),
  get_instance_properties: (tools, body) => tools.getInstanceProperties(body.instancePath, body.excludeSource, body.instance_id),
  get_instance_children: (tools, body) => tools.getInstanceChildren(body.instancePath, body.instance_id),
  search_by_property: (tools, body) => tools.searchByProperty(body.propertyName, body.propertyValue, body.instance_id),
  get_class_info: (tools, body) => tools.getClassInfo(body.className, body.instance_id),
  get_project_structure: (tools, body) => tools.getProjectStructure(body.path, body.maxDepth, body.scriptsOnly, body.instance_id),
  set_property: (tools, body) => tools.setProperty(body.instancePath, body.propertyName, body.propertyValue, body.instance_id),
  set_properties: (tools, body) => tools.setProperties(body.instancePath, body.properties, body.instance_id),
  mass_set_property: (tools, body) => tools.massSetProperty(body.paths, body.propertyName, body.propertyValue, body.instance_id),
  mass_get_property: (tools, body) => tools.massGetProperty(body.paths, body.propertyName, body.instance_id),
  create_object: (tools, body) => tools.createObject(body.className, body.parent, body.name, body.properties, body.instance_id),
  mass_create_objects: (tools, body) => tools.massCreateObjects(body.objects, body.instance_id),
  delete_object: (tools, body) => tools.deleteObject(body.instancePath, body.instance_id),
  smart_duplicate: (tools, body) => tools.smartDuplicate(body.instancePath, body.count, body.options, body.instance_id),
  mass_duplicate: (tools, body) => tools.massDuplicate(body.duplications, body.instance_id),
  grep_scripts: (tools, body) => tools.grepScripts(body.pattern, {
    caseSensitive: body.caseSensitive,
    usePattern: body.usePattern,
    contextLines: body.contextLines,
    maxResults: body.maxResults,
    maxResultsPerScript: body.maxResultsPerScript,
    filesOnly: body.filesOnly,
    path: body.path,
    classFilter: body.classFilter,
  }, body.instance_id),
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
  set_attribute: (tools, body) => tools.setAttribute(body.instancePath, body.attributeName, body.attributeValue, body.valueType, body.instance_id),
  get_attributes: (tools, body) => tools.getAttributes(body.instancePath, body.instance_id),
  delete_attribute: (tools, body) => tools.deleteAttribute(body.instancePath, body.attributeName, body.instance_id),
  get_tags: (tools, body) => tools.getTags(body.instancePath, body.instance_id),
  add_tag: (tools, body) => tools.addTag(body.instancePath, body.tagName, body.instance_id),
  remove_tag: (tools, body) => tools.removeTag(body.instancePath, body.tagName, body.instance_id),
  get_tagged: (tools, body) => tools.getTagged(body.tagName, body.instance_id),
  get_selection: (tools, body) => tools.getSelection(body.instance_id),
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
  start_playtest: (tools, body) => tools.startPlaytest(body.mode, body.numPlayers, body.instance_id),
  stop_playtest: (tools, body) => tools.stopPlaytest(body.instance_id),
  multiplayer_playtest: (tools, body) => tools.multiplayerPlaytest(body.action, body.numPlayers, body.target, body.testArgs, body.value, body.timeout, body.instance_id),
  multiplayer_test_start: (tools, body) => tools.multiplayerTestStart(body.numPlayers, body.testArgs, body.timeout, body.instance_id),
  multiplayer_test_state: (tools, body) => tools.multiplayerTestState(body.instance_id),
  multiplayer_test_add_players: (tools, body) => tools.multiplayerTestAddPlayers(body.numPlayers, body.timeout, body.instance_id),
  multiplayer_test_leave_client: (tools, body) => tools.multiplayerTestLeaveClient(body.target, body.timeout, body.instance_id),
  multiplayer_test_end: (tools, body) => tools.multiplayerTestEnd(body.value, body.timeout, body.instance_id),
  get_runtime_logs: (tools, body) => tools.getRuntimeLogs(body.target, body.since, body.tail, body.filter, body.instance_id),
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
  export_build: (tools, body) => tools.exportBuild(body.instancePath, body.outputId, body.style, body.instance_id),
  create_build: (tools, body) => tools.createBuild(body.id, body.style, body.palette, body.parts, body.bounds),
  generate_build: (tools, body) => tools.generateBuild(body.id, body.style, body.palette, body.code, body.seed),
  import_build: (tools, body) => tools.importBuild(body.buildData, body.targetPath, body.position, body.instance_id),
  list_library: (tools, body) => tools.listLibrary(body.style),
  search_materials: (tools, body) => tools.searchMaterials(body.query, body.maxResults, body.instance_id),
  get_build: (tools, body) => tools.getBuild(body.id),
  import_scene: (tools, body) => tools.importScene(body.sceneData, body.targetPath, body.instance_id),
  undo: (tools, body) => tools.undo(body.instance_id),
  redo: (tools, body) => tools.redo(body.instance_id),
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
  clone_object: (tools, body) => tools.cloneObject(body.instancePath, body.targetParentPath, body.instance_id),
  get_descendants: (tools, body) => tools.getDescendants(body.instancePath, body.maxDepth, body.classFilter, body.instance_id),
  compare_instances: (tools, body) => tools.compareInstances(body.instancePathA, body.instancePathB, body.instance_id),
  bulk_set_attributes: (tools, body) => tools.bulkSetAttributes(body.instancePath, body.attributes, body.instance_id),
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

export function createHttpServer(tools: RobloxStudioTools, bridge: BridgeService, allowedTools?: Set<string>, serverConfig?: StreamableHttpConfig, security?: HttpSecurityOptions) {
  const app = express();
  const studioLifecycleCallable = !allowedTools || allowedTools.has('manage_instance');
  const studioLifecycleCapabilities = studioLifecycleCallable
    ? tools.getStudioLifecycleCapabilities()
    : undefined;
  let mcpServerActive = false;
  let lastMCPActivity = 0;
  let mcpServerStartTime = 0;
  const proxyInstances = new Set<string>();
  const warnedVersionMismatches = new Set<string>();

  const setMCPServerActive = (active: boolean) => {
    mcpServerActive = active;
    if (active) {
      mcpServerStartTime = Date.now();
      lastMCPActivity = Date.now();
    } else {
      mcpServerStartTime = 0;
      lastMCPActivity = 0;
    }
  };

  const trackMCPActivity = () => {
    if (mcpServerActive) {
      lastMCPActivity = Date.now();
    }
  };

  const isMCPServerActive = () => {
    if (!mcpServerActive) return false;
    return (Date.now() - lastMCPActivity) < 30000;
  };

  const isPluginConnected = () => {
    return bridge.getInstances().length > 0;
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MCP-Auth, Mcp-Protocol-Version');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // -- Shared-secret auth --
  // Tool-invoking endpoints require the token; plugin-facing endpoints
  // (/ready, /poll, /response, /disconnect) and passive status endpoints
  // stay open because the Studio plugin can't read local files. Those routes
  // only register/poll — they cannot invoke tools.
  const authToken = security?.authToken;
  const authRequired = (path: string) =>
    path === '/mcp' || path.startsWith('/mcp/') ||
    path === '/proxy' || path === '/instances' || path === '/unregister-instance-id';
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
    const instances = bridge.getInstances();
    const publicInstances = instances.map(toPublic);
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
      pluginConnected: instances.length > 0,
      instanceCount: instances.length,
      instances: publicInstances,
      versionMismatch: publicInstances.some((inst) => inst.versionMismatch),
      mcpServerActive: isMCPServerActive(),
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0,
      pendingRequests: bridge.getPendingRequestCount(),
      proxyInstanceCount: proxyInstances.size,
      streamableHttp: !!serverConfig,
    });
  });


  app.post('/ready', (req, res) => {
    const {
      pluginSessionId,
      instanceId,
      role,
      placeId,
      placeName,
      dataModelName,
      isRunning,
      pluginVersion,
      pluginVariant,
    } = req.body;
    const requestContext = {
      instanceId: typeof instanceId === 'string' ? instanceId : undefined,
      role: typeof role === 'string' ? role : undefined,
      placeId: typeof placeId === 'number' ? placeId : undefined,
      placeName: typeof placeName === 'string' ? placeName : undefined,
      dataModelName: typeof dataModelName === 'string' ? dataModelName : undefined,
      isRunning: typeof isRunning === 'boolean' ? isRunning : undefined,
      pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : undefined,
      pluginVariant: typeof pluginVariant === 'string' ? pluginVariant : undefined,
    };

    if (!pluginSessionId || !instanceId || !role) {
      const missingFields = [
        !pluginSessionId ? 'pluginSessionId' : undefined,
        !instanceId ? 'instanceId' : undefined,
        !role ? 'role' : undefined,
      ].filter((field): field is string => !!field);
      res.status(400).json({
        success: false,
        error: 'missing_ready_fields',
        message: `/ready missing required field(s): ${missingFields.join(', ')}`,
        missingFields,
        request: requestContext,
      });
      return;
    }

    let result: RegisterInstanceResult;
    try {
      result = bridge.registerInstance({
        pluginSessionId,
        instanceId,
        role,
        placeId: typeof placeId === 'number' ? placeId : 0,
        placeName: typeof placeName === 'string' ? placeName : '',
        dataModelName: typeof dataModelName === 'string' ? dataModelName : '',
        isRunning: !!isRunning,
        pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : '',
        pluginVariant: typeof pluginVariant === 'string' ? pluginVariant : 'unknown',
        serverVersion: serverConfig?.version ?? '',
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
    const registered = bridge.getInstanceBySessionId(pluginSessionId);
    if (registered?.versionMismatch && !warnedVersionMismatches.has(pluginSessionId)) {
      warnedVersionMismatches.add(pluginSessionId);
      console.error(
        `[version-mismatch] Studio plugin v${registered.pluginVersion} (${registered.pluginVariant}) ` +
        `does not match MCP server v${registered.serverVersion} for ${registered.instanceId}/${registered.role}`,
      );
    }

    res.json({
      success: true,
      assignedRole: result.assignedRole,
      instanceId: result.instanceId,
      serverVersion: serverConfig?.version,
      versionMismatch: registered?.versionMismatch ?? false,
    });
  });


  app.post('/disconnect', (req, res) => {
    const { pluginSessionId } = req.body;

    if (pluginSessionId) {
      bridge.unregisterInstance(pluginSessionId);
    }
    res.json({ success: true });
  });

  app.post('/unregister-instance-id', (req, res) => {
    const { instanceId } = req.body;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      res.status(400).json({ error: 'instanceId is required' });
      return;
    }

    const removed = bridge.unregisterInstanceId(instanceId);
    res.json({ success: true, removed });
  });


  app.get('/status', (req, res) => {
    const instances = bridge.getInstances();
    const publicInstances = instances.map(toPublic);
    res.json({
      pluginConnected: instances.length > 0,
      instanceCount: instances.length,
      instances: publicInstances,
      serverVersion: serverConfig?.version,
      versionMismatch: publicInstances.some((inst) => inst.versionMismatch),
      mcpServerActive: isMCPServerActive(),
      lastMCPActivity,
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0
    });
  });


  app.get('/instances', (req, res) => {
    // Includes the internal pluginSessionId so proxy-mode subprocesses can
    // reproduce the full PluginInstance shape (they need the session id for
    // local bookkeeping; not exposed via MCP tools).
    const instances = bridge.getInstances();
    res.json({
      instances,
      serverVersion: serverConfig?.version,
      versionMismatch: instances.some((inst) => inst.versionMismatch),
    });
  });


  app.get('/poll', (req, res) => {
    const pluginSessionId = req.query.pluginSessionId as string | undefined;

    if (pluginSessionId) {
      bridge.updateInstanceActivity(pluginSessionId);
    }

    let callerInstanceId: string | undefined;
    let callerRole: string | undefined;
    let knownInstance = false;
    let callerPluginVersion: string | undefined;
    let callerPluginVariant: string | undefined;
    let versionMismatch = false;
    if (pluginSessionId) {
      const inst = bridge.getInstanceBySessionId(pluginSessionId);
      if (inst) {
        callerInstanceId = inst.instanceId;
        callerRole = inst.role;
        callerPluginVersion = inst.pluginVersion;
        callerPluginVariant = inst.pluginVariant;
        versionMismatch = inst.versionMismatch;
        knownInstance = true;
      }
    }

    if (!isMCPServerActive()) {
      res.status(503).json({
        error: 'MCP server not connected',
        pluginConnected: true,
        mcpConnected: false,
        knownInstance,
        serverVersion: serverConfig?.version,
        pluginVersion: callerPluginVersion,
        pluginVariant: callerPluginVariant,
        versionMismatch,
        request: null
      });
      return;
    }

    // knownInstance=false signals to the plugin that the MCP server has
    // restarted (its in-memory instances map is empty) and the plugin
    // should re-issue /ready. Without this, polls succeed (HTTP 200) but
    // the server treats the plugin as anonymous and routes nothing to it.
    const pendingRequest = knownInstance && callerInstanceId && callerRole
      ? bridge.getPendingRequest(callerInstanceId, callerRole)
      : null;

    if (pendingRequest) {
      res.json({
        request: pendingRequest.request,
        requestId: pendingRequest.requestId,
        mcpConnected: true,
        pluginConnected: true,
        knownInstance,
        serverVersion: serverConfig?.version,
        pluginVersion: callerPluginVersion,
        pluginVariant: callerPluginVariant,
        versionMismatch,
        proxyInstanceCount: proxyInstances.size
      });
    } else {
      res.json({
        request: null,
        mcpConnected: true,
        pluginConnected: true,
        knownInstance,
        serverVersion: serverConfig?.version,
        pluginVersion: callerPluginVersion,
        pluginVariant: callerPluginVariant,
        versionMismatch,
        proxyInstanceCount: proxyInstances.size
      });
    }
  });


  app.post('/response', (req, res) => {
    const { requestId, response, error } = req.body;

    if (error) {
      bridge.rejectRequest(requestId, error);
    } else {
      bridge.resolveRequest(requestId, response);
    }

    res.json({ success: true });
  });


  app.post('/proxy', async (req, res) => {
    const { endpoint, data, targetInstanceId, targetRole, proxyInstanceId } = req.body;

    if (!endpoint || !targetInstanceId || !targetRole) {
      res.status(400).json({ error: 'endpoint, targetInstanceId, and targetRole are required' });
      return;
    }

    if (proxyInstanceId) {
      proxyInstances.add(proxyInstanceId);
    }

    try {
      const response = await bridge.sendRequest(endpoint, data, targetInstanceId, targetRole);
      res.json({ response });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Proxy request failed' });
    }
  });


  // Streamable HTTP MCP transport
  if (serverConfig) {
    const filteredTools = serverConfig.tools.filter(t => !allowedTools || allowedTools.has(t.name));

    app.post('/mcp', async (req, res) => {
      try {
        trackMCPActivity();

        const server = new Server(
          { name: serverConfig.name, version: serverConfig.version },
          { capabilities: { tools: {} } }
        );

        registerResourceHandlers(server);

        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: filteredTools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args } = request.params;

          if (allowedTools && !allowedTools.has(name)) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }
          const handler = TOOL_HANDLERS[name];
          if (!handler) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }

          try {
            return await handler(tools, args || {});
          } catch (error) {
            if (error instanceof StudioLaunchPreDispatchError) {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify(error.toResponseBody()),
                }],
                isError: true,
              };
            }
            if (error instanceof RoutingFailure) {
              // Surface routing errors as structured tool-call results with
              // the full instance list embedded so the LLM can recover by
              // picking an instance_id from data.instances — no need for a
              // separate get_connected_instances round-trip.
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    error: error.routingError.code,
                    message: error.routingError.message,
                    data: error.routingError.data,
                  }),
                }],
                isError: true,
              };
            }
            if (error instanceof McpError) throw error;
            throw new McpError(
              ErrorCode.InternalError,
              `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
          transport.close();
          server.close();
        });
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    app.get('/mcp', (req, res) => {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }));
    });

    app.delete('/mcp', (req, res) => {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }));
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
        const result = await handler(tools, req.body);
        res.json(result);
      } catch (error) {
        if (error instanceof StudioLaunchPreDispatchError) {
          res.status(error.statusCode).json(error.toResponseBody());
          return;
        }
        if (error instanceof RoutingFailure) {
          res.status(400).json({
            error: error.routingError.code,
            message: error.routingError.message,
            data: error.routingError.data,
          });
          return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }


  (app as any).isPluginConnected = isPluginConnected;
  (app as any).setMCPServerActive = setMCPServerActive;
  (app as any).isMCPServerActive = isMCPServerActive;
  (app as any).trackMCPActivity = trackMCPActivity;

  return app;
}

/**
 * Attempt to bind an Express app to a port, using an explicit http.Server
 * so that EADDRINUSE errors are properly caught.
 */
export function listenWithRetry(
  app: express.Express,
  host: string,
  startPort: number,
  maxAttempts: number = 5
): Promise<{ server: http.Server; port: number }> {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      try {
        const server = await bindPort(app, host, port);
        resolve({ server, port });
        return;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${port} in use, trying next...`);
          continue;
        }
        reject(err);
        return;
      }
    }
    reject(new Error(`All ports ${startPort}-${startPort + maxAttempts - 1} are in use. Stop some MCP server instances and retry.`));
  });
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

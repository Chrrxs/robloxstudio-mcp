import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';

type JsonSchema = Record<string, unknown>;

function collectArraySchemasMissingItems(schema: unknown, path: string, out: string[]) {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as JsonSchema;
  if (node.type === 'array' && !('items' in node)) {
    out.push(path);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collectArraySchemasMissingItems(entry, `${path}.${key}[${index}]`, out));
    }
  }
  const properties = node.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      collectArraySchemasMissingItems(value, `${path}.properties.${key}`, out);
    }
  }
  const items = node.items;
  if (Array.isArray(items)) {
    items.forEach((entry, index) => collectArraySchemasMissingItems(entry, `${path}.items[${index}]`, out));
  } else {
    collectArraySchemasMissingItems(items, `${path}.items`, out);
  }
}

describe('Tool schema compatibility', () => {
  test('every array schema declares items', () => {
    const missing: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      collectArraySchemasMissingItems(tool.inputSchema, tool.name, missing);
    }
    expect(missing).toEqual([]);
  });

  // Tools that don't dispatch to Studio (asset uploads, local file ops, build
  // library, etc.) intentionally don't take instance_id. Everything else
  // should expose it in the schema AND thread it through the HTTP handler.
  const STUDIO_AGNOSTIC_TOOLS = new Set([
    'search_assets',
    'get_asset_details',
    'get_asset_thumbnail',
    'upload_asset',
    'list_library',
    'get_build',
    'create_build',
    'generate_build',
    'get_connected_instances',
  ]);

  function toolHandlerBody(toolName: string): string {
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) throw new Error(`No HTTP handler registered for tool ${toolName}`);
    return handler.toString();
  }

  test('every Studio-routing tool exposes instance_id in its schema', () => {
    const offenders: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      if (STUDIO_AGNOSTIC_TOOLS.has(tool.name)) continue;
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      if (!('instance_id' in props)) {
        offenders.push(tool.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every Studio-routing tool threads body.instance_id through the HTTP handler', () => {
    const offenders: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      if (STUDIO_AGNOSTIC_TOOLS.has(tool.name)) continue;
      const body = toolHandlerBody(tool.name);
      if (!body.includes('body.instance_id')) {
        offenders.push(tool.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every Studio-routing tool implementation accepts an instance_id parameter', () => {
    // Reflects on the actual method signatures on RobloxStudioTools. If the
    // tool method's stringified source doesn't mention instance_id at all,
    // it can't be routing it through resolveTarget — which means the handler
    // wiring is a no-op.
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const proto = Object.getPrototypeOf(tools);
    const offenders: string[] = [];
    // Map snake_case tool name to the camelCase method name used in
    // RobloxStudioTools. Most are mechanical; a few are exceptions.
    const methodNameOf: Record<string, string> = {
      get_file_tree: 'getFileTree',
      search_files: 'searchFiles',
      get_place_info: 'getPlaceInfo',
      get_services: 'getServices',
      search_objects: 'searchObjects',
      get_instance_properties: 'getInstanceProperties',
      get_instance_children: 'getInstanceChildren',
      search_by_property: 'searchByProperty',
      get_class_info: 'getClassInfo',
      get_project_structure: 'getProjectStructure',
      set_property: 'setProperty',
      set_properties: 'setProperties',
      mass_set_property: 'massSetProperty',
      mass_get_property: 'massGetProperty',
      create_object: 'createObject',
      mass_create_objects: 'massCreateObjects',
      delete_object: 'deleteObject',
      smart_duplicate: 'smartDuplicate',
      mass_duplicate: 'massDuplicate',
      grep_scripts: 'grepScripts',
      get_script_source: 'getScriptSource',
      set_script_source: 'setScriptSource',
      edit_script_lines: 'editScriptLines',
      insert_script_lines: 'insertScriptLines',
      delete_script_lines: 'deleteScriptLines',
      set_attribute: 'setAttribute',
      get_attributes: 'getAttributes',
      delete_attribute: 'deleteAttribute',
      get_tags: 'getTags',
      add_tag: 'addTag',
      remove_tag: 'removeTag',
      get_tagged: 'getTagged',
      get_selection: 'getSelection',
      execute_luau: 'executeLuau',
      eval_server_runtime: 'evalServerRuntime',
      eval_client_runtime: 'evalClientRuntime',
      set_network_profile: 'setNetworkProfile',
      get_simulation_state: 'getSimulationState',
      reset_simulation_state: 'resetSimulationState',
      get_device_simulator_state: 'getDeviceSimulatorState',
      set_device_simulator: 'setDeviceSimulator',
      capture_device_matrix: 'captureDeviceMatrix',
      start_playtest: 'startPlaytest',
      stop_playtest: 'stopPlaytest',
      get_playtest_output: 'getPlaytestOutput',
      multiplayer_test_start: 'multiplayerTestStart',
      multiplayer_test_state: 'multiplayerTestState',
      multiplayer_test_add_players: 'multiplayerTestAddPlayers',
      multiplayer_test_leave_client: 'multiplayerTestLeaveClient',
      multiplayer_test_end: 'multiplayerTestEnd',
      get_runtime_logs: 'getRuntimeLogs',
      export_build: 'exportBuild',
      import_build: 'importBuild',
      search_materials: 'searchMaterials',
      import_scene: 'importScene',
      undo: 'undo',
      redo: 'redo',
      insert_asset: 'insertAsset',
      preview_asset: 'previewAsset',
      clone_object: 'cloneObject',
      get_descendants: 'getDescendants',
      compare_instances: 'compareInstances',
      get_output_log: 'getOutputLog',
      bulk_set_attributes: 'bulkSetAttributes',
      capture_screenshot: 'captureScreenshot',
      simulate_mouse_input: 'simulateMouseInput',
      simulate_keyboard_input: 'simulateKeyboardInput',
      character_navigation: 'characterNavigation',
      get_memory_breakdown: 'getMemoryBreakdown',
      get_scene_analysis: 'getSceneAnalysis',
      debug_control: 'debugControl',
      debug_inspect: 'debugInspect',
      export_rbxm: 'exportRbxm',
      import_rbxm: 'importRbxm',
      find_and_replace_in_scripts: 'findAndReplaceInScripts',
    };
    for (const tool of TOOL_DEFINITIONS) {
      if (STUDIO_AGNOSTIC_TOOLS.has(tool.name)) continue;
      const methodName = methodNameOf[tool.name];
      if (!methodName) {
        offenders.push(`${tool.name} (no method-name mapping; add to test)`);
        continue;
      }
      const fn = (proto as Record<string, unknown>)[methodName];
      if (typeof fn !== 'function') {
        offenders.push(`${tool.name} (no method named ${methodName})`);
        continue;
      }
      if (!fn.toString().includes('instance_id')) {
        offenders.push(`${tool.name} (${methodName} signature missing instance_id)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('get_scene_analysis schema exposes mode, target, topN, raw, and instance_id', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'get_scene_analysis');
    expect(tool).toBeTruthy();
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['instance_id', 'mode', 'raw', 'target', 'topN'].sort());
    expect((props.mode as { enum?: string[] }).enum).toEqual([
      'all',
      'instance_composition',
      'script_memory',
      'unparented_instances',
      'triangle_composition',
      'animation_memory',
      'audio_memory',
    ]);
  });

  test('device simulator schemas expose target routing and matrix entries', () => {
    const getTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_device_simulator_state');
    const setTool = TOOL_DEFINITIONS.find((t) => t.name === 'set_device_simulator');
    const matrixTool = TOOL_DEFINITIONS.find((t) => t.name === 'capture_device_matrix');
    expect(getTool).toBeTruthy();
    expect(setTool).toBeTruthy();
    expect(matrixTool).toBeTruthy();

    const getProps = (getTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(getProps).sort()).toEqual(['deviceId', 'includeDeviceList', 'instance_id', 'target'].sort());

    const setProps = (setTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(setProps).sort()).toEqual([
      'deviceId',
      'instance_id',
      'orientation',
      'pixelDensity',
      'resolution',
      'scalingMode',
      'stopSimulation',
      'target',
    ].sort());

    const matrixSchema = matrixTool!.inputSchema as {
      properties?: Record<string, { items?: unknown; maxItems?: number }>;
      required?: string[];
    };
    expect(matrixSchema.required).toEqual(['entries']);
    expect(matrixSchema.properties?.entries.items).toBeTruthy();
    expect(matrixSchema.properties?.entries.maxItems).toBe(6);
  });

  test('simulation state schemas expose inspect and reset controls', () => {
    const getTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_simulation_state');
    const resetTool = TOOL_DEFINITIONS.find((t) => t.name === 'reset_simulation_state');
    expect(getTool).toBeTruthy();
    expect(resetTool).toBeTruthy();

    const getProps = (getTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(getProps).sort()).toEqual(['include', 'instance_id', 'target'].sort());
    expect((getProps.include as { enum?: string[] }).enum).toEqual(['network', 'deviceSimulator', 'both']);

    const resetProps = (resetTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(resetProps).sort()).toEqual(['deviceSimulator', 'instance_id', 'network', 'target'].sort());
  });

  test('set_network_profile schema caps packet loss at Roblox engine limit', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'set_network_profile');
    expect(tool).toBeTruthy();
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const overrides = props.overrides as { properties?: Record<string, { minimum?: number; maximum?: number }> };
    expect(overrides.properties?.InboundNetworkMinDelayMs.minimum).toBe(0);
    expect(overrides.properties?.OutboundNetworkMinDelayMs.minimum).toBe(0);
    expect(overrides.properties?.InboundNetworkJitterMs.minimum).toBe(0);
    expect(overrides.properties?.OutboundNetworkJitterMs.minimum).toBe(0);
    expect(overrides.properties?.InboundNetworkLossPercent.minimum).toBe(0);
    expect(overrides.properties?.InboundNetworkLossPercent.maximum).toBe(0.5);
    expect(overrides.properties?.OutboundNetworkLossPercent.minimum).toBe(0);
    expect(overrides.properties?.OutboundNetworkLossPercent.maximum).toBe(0.5);
  });
});

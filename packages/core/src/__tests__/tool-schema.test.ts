import { getReadOnlyTools, TOOL_DEFINITIONS } from '../tools/definitions.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';
import { TOOL_GUIDE_MARKDOWN } from '../mcp-compat.js';

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

  test('playtest lifecycle exposes canonical tools and removes deprecated aliases', () => {
    const activeNames = new Set(TOOL_DEFINITIONS.map(tool => tool.name));

    expect(activeNames.has('solo_playtest')).toBe(true);
    expect(activeNames.has('multiplayer_playtest')).toBe(true);

    const soloProps = (TOOL_DEFINITIONS.find(tool => tool.name === 'solo_playtest')!.inputSchema as { properties?: Record<string, any>; required?: string[] }).properties ?? {};
    expect((soloProps.action as { enum?: string[] }).enum).toEqual(['start', 'stop', 'status']);
    expect((TOOL_DEFINITIONS.find(tool => tool.name === 'solo_playtest')!.inputSchema as { required?: string[] }).required).toEqual(['action']);

    const multiplayerProps = (TOOL_DEFINITIONS.find(tool => tool.name === 'multiplayer_playtest')!.inputSchema as { properties?: Record<string, any>; required?: string[] }).properties ?? {};
    expect((multiplayerProps.action as { enum?: string[] }).enum).toEqual(['start', 'status', 'add_players', 'leave_client', 'end']);
    expect(Object.keys(multiplayerProps).sort()).toEqual(['action', 'instance_id', 'numPlayers', 'target', 'testArgs', 'timeout', 'value']);
    expect((TOOL_DEFINITIONS.find(tool => tool.name === 'multiplayer_playtest')!.inputSchema as { required?: string[] }).required).toEqual(['action']);

    for (const name of [
      'start_playtest',
      'stop_playtest',
      'multiplayer_test_start',
      'multiplayer_test_state',
      'multiplayer_test_add_players',
      'multiplayer_test_leave_client',
      'multiplayer_test_end',
    ]) {
      expect(activeNames.has(name)).toBe(false);
      expect(TOOL_HANDLERS[name]).toBeUndefined();
    }
  });

  test('selection exposes one get/set/view lifecycle', () => {
    const tool = TOOL_DEFINITIONS.find(candidate => candidate.name === 'selection');
    expect(tool).toBeDefined();
    expect(tool!.category).toBe('read');
    expect(getReadOnlyTools()).toContain(tool);
    expect(tool!.description).toBe('Use to get, set, or frame selection.');

    const schema = tool!.inputSchema as {
      properties?: Record<string, {
        description?: string;
        enum?: string[];
        default?: unknown;
        items?: { minLength?: number };
        minLength?: number;
        exclusiveMinimum?: number;
        minimum?: number;
        maximum?: number;
      }>;
      required?: string[];
    };
    const props = schema.properties ?? {};
    expect(schema.required).toEqual(['action']);
    expect(props.action.enum).toEqual(['get', 'set', 'view']);
    expect(props.mode).toMatchObject({ enum: ['set', 'add', 'remove'], default: 'set' });
    expect(props.action.description).toBe('View frames the target.');
    expect(props.paths).toMatchObject({
      description: 'Set needs paths; empty clears in set mode.',
      items: { minLength: 1 },
    });
    expect(props.mode.description).toBe('How set applies paths.');
    expect(props.path).toMatchObject({
      description: 'View needs a BasePart or Model path.',
      minLength: 1,
    });
    expect(props.from.description).toBe('View azimuth: 0 +X, 90 +Z.');
    expect(props.padding).toMatchObject({
      description: 'View distance scale.',
      default: 1,
      exclusiveMinimum: 0,
      maximum: 10,
    });
    expect(props.angleY).toMatchObject({
      description: 'View elevation in degrees.',
      minimum: -89,
      maximum: 89,
    });
    expect(props.instance_id.description).toBe('Connected place ID if multiple are open.');
    expect(Object.keys(props).sort()).toEqual([
      'action',
      'angleY',
      'from',
      'instance_id',
      'mode',
      'padding',
      'path',
      'paths',
    ]);

    for (const removed of ['get_selection', 'set_selection', 'focus_viewport']) {
      expect(TOOL_DEFINITIONS.some(candidate => candidate.name === removed)).toBe(false);
      expect(TOOL_HANDLERS[removed]).toBeUndefined();
    }
    expect(TOOL_HANDLERS.selection).toBeDefined();
    expect(TOOL_GUIDE_MARKDOWN).toContain('## Selection and viewport');
    expect(TOOL_GUIDE_MARKDOWN).toContain('An empty paths array in set mode clears it');
  });

  test('grep_scripts exposes one explicit pattern-mode switch', () => {
    const grep = TOOL_DEFINITIONS.find(tool => tool.name === 'grep_scripts')!;
    const props = (grep.inputSchema as { properties?: Record<string, any> }).properties ?? {};

    expect(props.usePattern).toMatchObject({ type: 'boolean' });
    expect(props.isRegex).toBeUndefined();
    expect(props.caseSensitive.description).toContain('patterns are always case-sensitive');
  });

  test('get_script_source exposes only line_range for range selection', () => {
    const tool = TOOL_DEFINITIONS.find(tool => tool.name === 'get_script_source');
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};

    expect(Object.keys(props).sort()).toEqual(['instancePath', 'instance_id', 'line_range']);
    expect(props).not.toHaveProperty('startLine');
    expect(props).not.toHaveProperty('endLine');
    expect(props).not.toHaveProperty('lineRange');
  });

  test('get_roblox_skills exposes list/get without Studio routing', () => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === 'get_roblox_skills');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(schema.required).toEqual(['action']);
    expect(schema.properties?.action.enum).toEqual(['list', 'get']);
    expect(schema.properties).not.toHaveProperty('instance_id');
    expect(TOOL_HANDLERS.get_roblox_skills).toBeDefined();
  });

  test('script line tools expose line_range instead of startLine/endLine', () => {
    for (const name of ['edit_script_lines', 'delete_script_lines']) {
      const tool = TOOL_DEFINITIONS.find(tool => tool.name === name);
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const props = schema.properties ?? {};

      expect(props).toHaveProperty('line_range');
      expect(props).not.toHaveProperty('startLine');
      expect(props).not.toHaveProperty('endLine');
      expect(props).not.toHaveProperty('lineRange');
    }

    const deleteRequired = (TOOL_DEFINITIONS.find(tool => tool.name === 'delete_script_lines')!.inputSchema as { required?: string[] }).required ?? [];
    expect(deleteRequired).toEqual(['instancePath', 'line_range']);
  });

  // Tools that don't dispatch to Studio (asset uploads, local file ops, etc.)
  // intentionally don't take instance_id. Everything else should expose it
  // in the schema AND thread it through the HTTP handler.
  const STUDIO_AGNOSTIC_TOOLS = new Set([
    'search_assets',
    'get_asset_details',
    'get_asset_thumbnail',
    'upload_asset',
    'get_connected_instances',
    'manage_instance',
    'get_roblox_docs',
    'get_roblox_skills',
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
      get_place_info: 'getPlaceInfo',
      search_objects: 'searchObjects',
      get_instance_properties: 'getInstanceProperties',
      get_project_structure: 'getProjectStructure',
      set_properties: 'setProperties',
      grep_scripts: 'grepScripts',
      get_script_source: 'getScriptSource',
      set_script_source: 'setScriptSource',
      edit_script_lines: 'editScriptLines',
      insert_script_lines: 'insertScriptLines',
      delete_script_lines: 'deleteScriptLines',
      get_attributes: 'getAttributes',
      selection: 'selection',
      execute_luau: 'executeLuau',
      eval_server_runtime: 'evalServerRuntime',
      eval_client_runtime: 'evalClientRuntime',
      set_network_profile: 'setNetworkProfile',
      get_simulation_state: 'getSimulationState',
      reset_simulation_state: 'resetSimulationState',
      get_device_simulator_state: 'getDeviceSimulatorState',
      set_device_simulator: 'setDeviceSimulator',
      capture_device_matrix: 'captureDeviceMatrix',
      manage_instance: 'manageInstance',
      solo_playtest: 'soloPlaytest',
      multiplayer_playtest: 'multiplayerPlaytest',
      get_runtime_logs: 'getRuntimeLogs',
      capture_script_profiler: 'captureScriptProfiler',
      capture_micro_profiler: 'captureMicroProfiler',
      breakpoints: 'breakpoints',
      insert_asset: 'insertAsset',
      generate_model: 'generateModel',
      preview_asset: 'previewAsset',
      capture_screenshot: 'captureScreenshot',
      simulate_mouse_input: 'simulateMouseInput',
      simulate_keyboard_input: 'simulateKeyboardInput',
      get_memory_breakdown: 'getMemoryBreakdown',
      get_scene_analysis: 'getSceneAnalysis',
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

  test('manage_instance exposes launch authorization, lifecycle actions, and place version discovery in one schema', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'manage_instance');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, any>; required?: string[] };
    const props = schema.properties ?? {};
    expect((props.action as { enum?: string[] }).enum).toEqual([
      'launch',
      'authorize',
      'complete',
      'close',
      'status',
      'list_place_versions',
    ]);
    expect((props.source as { enum?: string[] }).enum).toEqual([
      'baseplate',
      'local_file',
      'published_place',
      'place_revision',
    ]);
    expect(Object.keys(props).sort()).toEqual([
      'action',
      'instance_id',
      'launch_id',
      'local_place_file',
      'max_page_size',
      'page_token',
      'place_id',
      'place_version',
      'process_environment',
      'require_process_identity',
      'source',
      'studio_executable',
      'studio_working_directory',
      'timeout_ms',
      'wait_for_connection',
    ].sort());
    expect(props.studio_executable).toMatchObject({ type: 'string' });
    expect(props.studio_working_directory).toMatchObject({ type: 'string' });
    expect(props.process_environment).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        set: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
    expect(props.universe_id).toBeUndefined();
    expect(schema.required).toEqual(['action']);
    expect((props.place_version as { description?: string }).description).toContain('place_revision');
    expect(TOOL_GUIDE_MARKDOWN).toContain('manage_instance can launch, inspect, and close Studio or list published place revisions');
    expect(TOOL_GUIDE_MARKDOWN).toContain('must be authorized and completed explicitly');
  });

  test('breakpoints schema exposes lifecycle actions and log fields', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'breakpoints');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const props = schema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      'action',
      'clear_all',
      'condition',
      'continue_execution',
      'enabled',
      'instance_id',
      'line',
      'log_message',
      'script_path',
      'target',
    ].sort());
    expect((props.action as { enum?: string[] }).enum).toEqual(['set', 'remove', 'clear', 'list']);
    expect(schema.required).toEqual(['action']);
    expect((props.action as { description?: string }).description).toContain('clear targets MCP entries');
    expect((props.clear_all as { description?: string }).description).toContain('user-created breakpoints');
    expect((props.continue_execution as { description?: string }).description).toContain('resumer');
    expect(TOOL_GUIDE_MARKDOWN).toContain('OnStopped resume handler');
    expect(TOOL_GUIDE_MARKDOWN).toContain('clear removes only MCP-created breakpoints');
  });

  test('capture_script_profiler schema exposes focused optimization primitive', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'capture_script_profiler');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    const props = schema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      'duration_ms',
      'filter',
      'frequency',
      'include_native',
      'include_plugin',
      'instance_id',
      'max_functions',
      'min_total_us',
      'output_path',
      'target',
    ].sort());
    expect(tool!.category).toBe('read');
    expect(tool!.description).toMatch(/^Use /);
    expect(TOOL_GUIDE_MARKDOWN).toContain('capture_script_profiler ranks Luau functions by CPU time');
    expect((props.target as { description?: string }).description).toContain('server');
    expect((props.target as { description?: string }).description).toContain('client-N');
    expect((props.target as { pattern?: string }).pattern).toBe('^(server|client-[0-9]+)$');
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).default).toBe(1000);
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(100);
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(15000);
    expect((props.frequency as { default?: number; minimum?: number; maximum?: number }).default).toBe(1000);
    expect((props.frequency as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(1);
    expect((props.frequency as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(10000);
    expect((props.max_functions as { default?: number; minimum?: number; maximum?: number }).default).toBe(20);
    expect((props.max_functions as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(1);
    expect((props.max_functions as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(100);
    expect((props.min_total_us as { default?: number; minimum?: number }).default).toBe(0);
    expect((props.min_total_us as { default?: number; minimum?: number }).minimum).toBe(0);
    expect((props.min_total_us as { description?: string }).description).toContain('microseconds');
    expect((props.output_path as { description?: string }).description).toContain('Raw JSON file');
  });

  test('capture_micro_profiler schema exposes focused engine profiler primitive', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'capture_micro_profiler');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    const props = schema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      'baseline',
      'baseline_label',
      'baseline_path',
      'current_label',
      'duration_ms',
      'filter',
      'focus',
      'frame_window',
      'include_comparison_index',
      'include_gpu',
      'include_idle',
      'instance_id',
      'max_comparison_rows',
      'max_events',
      'max_groups',
      'max_related_timers',
      'max_timers',
      'max_timers_per_group',
      'min_total_us',
      'output_path',
      'summary_output_path',
      'target',
    ].sort());
    expect(tool!.category).toBe('read');
    expect(tool!.description).toMatch(/^Use /);
    expect(TOOL_GUIDE_MARKDOWN).toContain('capture_micro_profiler attributes frame time');
    expect(TOOL_GUIDE_MARKDOWN).toContain('do not sum them as disjoint totals');
    expect(TOOL_GUIDE_MARKDOWN).toContain('baseline_path or baseline');
    expect((props.target as { pattern?: string }).pattern).toBe('^(server|client-[0-9]+)$');
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).default).toBe(1000);
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(100);
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(5000);
    expect((props.focus as { enum?: string[]; default?: string }).enum).toEqual(['all', 'script', 'physics', 'render', 'network', 'jobs']);
    expect((props.focus as { enum?: string[]; default?: string }).default).toBe('all');
    expect((props.max_timers as { default?: number; minimum?: number; maximum?: number }).default).toBe(20);
    expect((props.max_timers as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(1);
    expect((props.max_timers as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(100);
    expect((props.max_groups as { default?: number; minimum?: number; maximum?: number }).default).toBe(20);
    expect((props.max_groups as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(1);
    expect((props.max_groups as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(100);
    expect((props.max_timers_per_group as { default?: number; minimum?: number; maximum?: number }).default).toBe(5);
    expect((props.max_timers_per_group as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(0);
    expect((props.max_timers_per_group as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(20);
    expect((props.max_related_timers as { default?: number; minimum?: number; maximum?: number }).default).toBe(3);
    expect((props.max_related_timers as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(0);
    expect((props.max_related_timers as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(10);
    expect((props.max_events as { default?: number; minimum?: number; maximum?: number }).default).toBe(250000);
    expect((props.max_events as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(10000);
    expect((props.max_events as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(1000000);
    expect((props.output_path as { description?: string }).description).toContain('Raw snapshot file');
    expect((props.summary_output_path as { description?: string }).description).toContain('comparison index');
    expect((props.baseline_path as { description?: string }).description).toContain('baseline');
  });

  test('generate_model schema exposes a brief model generation primitive', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'generate_model');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, any> };
    const props = schema.properties ?? {};
    expect(tool!.category).toBe('write');
    expect(Object.keys(props).sort()).toEqual([
      'generate_textures',
      'image_asset_id',
      'image_base64',
      'image_mime_type',
      'image_path',
      'instance_id',
      'max_triangles',
      'name',
      'prompt',
      'schema',
      'schema_groups',
      'size',
      'timeout_ms',
    ].sort());
    expect(tool!.description).toMatch(/^Use /);
    expect(TOOL_GUIDE_MARKDOWN).toContain('generate_model stages generated content under ServerStorage');
    expect((props.image_mime_type as { enum?: string[] }).enum).toEqual(['image/png']);
    expect(props.image_base64).toMatchObject({ maxLength: 44_739_244 });
    expect((props.schema as { enum?: string[]; default?: string }).enum).toEqual(['Body1', 'Car5']);
    expect((props.schema as { enum?: string[]; default?: string }).default).toBe('Body1');
    expect((props.schema_groups as { items?: unknown }).items).toBeTruthy();
    expect((props.max_triangles as { minimum?: number }).minimum).toBe(1);
    expect((props.timeout_ms as { minimum?: number; maximum?: number; default?: number }).minimum).toBe(1);
    expect((props.timeout_ms as { minimum?: number; maximum?: number; default?: number }).maximum).toBe(300000);
    expect((props.timeout_ms as { minimum?: number; maximum?: number; default?: number }).default).toBe(120000);
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
    expect(TOOL_GUIDE_MARKDOWN).toContain('Inspect current settings with get_simulation_state before changing them');
    expect(TOOL_GUIDE_MARKDOWN).toContain('reset_simulation_state after a scenario');
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

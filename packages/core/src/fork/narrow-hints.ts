// Which arguments shrink a tool's output, named in the truncation line.
const HINTS: Record<string, string> = {
  search_objects: 'maxResults, path or className',
  get_instance_properties: 'excludeSource or a deeper instancePath',
  get_project_structure: 'maxDepth, path or scriptsOnly',
  get_script_source: 'line_range',
  grep_scripts: 'maxResults, maxResultsPerScript, filesOnly or path',
  find_and_replace_in_scripts: 'path, classFilter or maxReplacements',
  get_runtime_logs: 'tail, filter or cursor',
  execute_luau: 'code that returns less',
  eval_server_runtime: 'code that returns less',
  eval_client_runtime: 'code that returns less',
  get_simulation_state: 'include',
  get_device_simulator_state: 'includeDeviceList=false or deviceId',
  capture_script_profiler: 'max_functions, min_total_us or filter',
  capture_micro_profiler: 'max_timers, max_groups, focus or filter',
  search_assets: 'maxResults or query',
  preview_asset: 'maxDepth or includeProperties=false',
  manage_instance: 'max_page_size',
  manage_monetization: 'id',
  get_memory_breakdown: 'tags',
  get_scene_analysis: 'topN or mode',
  get_roblox_docs: 'section',
  get_roblox_skills: 'name',
  selection: 'paths',
  get_attributes: 'a deeper instancePath',
  query_tree: 'limit, fields, class or path',
  logs_since: 'min_level, pattern or cursor',
};

export function narrowHint(tool: string): string {
  return HINTS[tool] ?? 'narrower arguments';
}

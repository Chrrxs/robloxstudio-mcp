#!/usr/bin/env node

import { createConnection } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BASE_PORT,
  McpClient,
  DIST,
  REPO_ROOT,
  assert,
  assertContains,
  instancePeers,
  selectEditInstance,
} from './lib/mcp-client.mjs';
import { windowsPortIsAvailable } from './lib/test-port.mjs';
import {
  closeStudioProcess,
  assertStudioDirectoryIsolation,
  assertStudioTestProfile,
  createIsolatedStudioDirectory,
} from '../scripts/studio-lifecycle.mjs';

const SERVER_ENV = {
  ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: '600000',
};

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitPortClosed(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return;
    await delay(250);
  }
  throw new Error(`Port ${port} remained open after server shutdown`);
}


async function waitForEditInstance(client, expectedVersion, instanceId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const edit = selectEditInstance(connected, instanceId);
      if (edit) {
        assert(
          /^instance:[0-9a-z]{3}-[0-9a-z]{3}$/u.test(edit.id),
          `connected Instance uses a compact typed ID (${edit.id})`,
        );
        assert(
          !Array.isArray(edit.peers) &&
            edit.peers !== null &&
            typeof edit.peers === 'object' &&
            /^peer:[0-9a-z]{3}-[0-9a-z]{3}$/u.test(edit.peers.edit),
          `connected peers map roles to compact typed IDs (${JSON.stringify(edit.peers)})`,
        );
        const statusResponse = await fetch(`http://127.0.0.1:${BASE_PORT}/status`);
        const status = await statusResponse.json();
        const peer = instancePeers(selectEditInstance(status, instanceId))
          .find((candidate) => candidate.role === 'edit');
        if (!peer) {
          last = { connected, status };
          await delay(1000);
          continue;
        }
        assert(peer.pluginVariant === 'main', 'regular tooling loaded the main plugin');
        assert(peer.pluginVersion === expectedVersion, `Studio plugin version is v${expectedVersion}`);
        assert(peer.serverVersion === expectedVersion, `MCP server version is v${expectedVersion}`);
        return { ...edit, instanceId: edit.id };
      }
      last = connected;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(1000);
  }
  throw new Error(`No edit instance ${instanceId} connected within ${timeoutMs}ms. Last: ${JSON.stringify(last)}`);
}

async function launchManagedPlace(client, workingDirectory) {
  assertStudioTestProfile();
  assertStudioDirectoryIsolation();
  const launched = await client.callTool('manage_instance', {
    action: 'launch',
    source: 'baseplate',
    require_process_identity: true,
    studio_working_directory: workingDirectory,
    timeout_ms: 120000,
  });
  assert(!!launched.launch_id, `manage_instance returned launch ownership (${JSON.stringify(launched)})`);
  assert(
    Number.isSafeInteger(launched.pid) &&
      launched.pid > 0 &&
      typeof launched.process_started_at_file_time === 'string',
    `manage_instance returned exact Studio process identity (${JSON.stringify(launched)})`,
  );

  try {
    const authorized = await client.callTool('manage_instance', {
      action: 'authorize',
      launch_id: launched.launch_id,
    });
    assert(authorized.process_authorized === true, `manage_instance authorized launch ${launched.launch_id}`);
    const completed = await client.callTool('manage_instance', {
      action: 'complete',
      launch_id: launched.launch_id,
    });
    assert(
      completed.process_ownership_released === true,
      `manage_instance released launch ${launched.launch_id}`,
    );

    const deadline = Date.now() + 120000;
    let status;
    while (Date.now() < deadline) {
      status = await client.callTool('manage_instance', {
        action: 'status',
        launch_id: launched.launch_id,
      });
      if (
        status.connected === true &&
        typeof status.instance_id === 'string' &&
        status.instance_id &&
        Array.isArray(status.roles) &&
        status.roles.includes('edit')
      ) {
        return { ...launched, instance_id: status.instance_id };
      }
      if (status.state === 'failed' || status.state === 'exited') {
        throw new Error(
          `Managed Studio launch ${launched.launch_id} entered ${status.state}: ` +
          `${status.failure_reason ?? 'Studio did not connect'}`,
        );
      }
      await delay(250);
    }
    throw new Error(
      `Managed Studio launch ${launched.launch_id} did not connect within 120000ms: ${JSON.stringify(status)}`,
    );
  } catch (error) {
    try {
      await closeStudioProcess({
        processId: launched.pid,
        startedAtFileTime: launched.process_started_at_file_time,
      });
    } catch (identityError) {
      throw new AggregateError(
        [error, identityError],
        `Studio launch ${launched.launch_id} failed and exact cleanup also failed`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function closeManagedInstance(client, launch) {
  if (!launch) return;
  const closed = await client.callTool('manage_instance', {
    action: 'close',
    launch_id: launch.launch_id,
  });
  assert(!closed.error, `manage_instance closed Studio launch ${launch.launch_id}`);
  assert(
    closed.close_status === 'closed' || closed.close_status === 'already_closed',
    `manage_instance confirmed Studio launch ${launch.launch_id} stopped`,
  );
}

function assertNoError(value, message) {
  assert(!value?.error, `${message}${value?.error ? ` (${value.error})` : ''}`);
}

async function runEditModeToolSmoke(client, instanceId) {
  console.log('\n=== edit-mode regular tooling smoke ===');

  const listed = await client.rpc('tools/list', {});
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  for (const tool of [
    'get_place_info',
    'get_project_structure',
    'set_properties',
    'get_instance_properties',
    'set_script_source',
    'get_script_source',
    'edit_script_lines',
    'insert_script_lines',
    'delete_script_lines',
    'find_and_replace_in_scripts',
    'get_attributes',
    'selection',
    'execute_luau',
  ]) {
    assert(names.has(tool), `tools/list exposes ${tool}`);
  }
  for (const removed of [
    'get_services',
    'create_object',
    'set_property',
    'set_attribute',
    'add_tag',
    'delete_object',
    'get_selection',
    'set_selection',
    'focus_viewport',
  ]) {
    assert(!names.has(removed), `tools/list omits removed ${removed}`);
  }

  const place = await client.callTool('get_place_info', { instance_id: instanceId });
  assertNoError(place, 'get_place_info succeeds');
  assert(place.workspace?.className === 'Workspace', 'get_place_info returns workspace metadata');

  const tree = await client.callTool('get_project_structure', { path: 'game.Workspace', maxDepth: 2, instance_id: instanceId });
  assertNoError(tree, 'get_project_structure succeeds');

  const folderPath = 'game.Workspace.__RSMCP_ToolingSmoke';
  const partPath = `${folderPath}.SmokePart`;
  const scriptPath = `${folderPath}.SmokeScript`;
  const nestedScriptPath = `${scriptPath}.NestedModule`;
  const setup = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `
local old = workspace:FindFirstChild("__RSMCP_ToolingSmoke")
if old then old:Destroy() end
local folder = Instance.new("Folder")
folder.Name = "__RSMCP_ToolingSmoke"
folder.Parent = workspace
local part = Instance.new("Part")
part.Name = "SmokePart"
part.Anchored = true
part.Size = Vector3.new(4, 1, 2)
part.Position = Vector3.new(0, 5, 0)
part:SetAttribute("SmokeAttr", "ok")
game:GetService("CollectionService"):AddTag(part, "RSMCPToolingSmoke")
part.Parent = folder
local script = Instance.new("Script")
script.Name = "SmokeScript"
script.Enabled = false
script.Parent = folder
local nested = Instance.new("ModuleScript")
nested.Name = "NestedModule"
nested.Source = 'return "NESTED_OLD"'
nested.Parent = script
return true
`,
  });
  assert(setup.success === true && String(setup.returnValue) === 'true', 'execute_luau creates smoke fixtures');

  const assertExactScriptSource = async (expectedLines, message) => {
    const source = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    const expected = expectedLines.map((line, index) => `${index + 1}: ${line}`).join('\n');
    assert(
      source.source === expected,
      `${message} (${JSON.stringify({ expected, actual: source.source })})`,
    );
  };

  try {
    const fullTree = await client.callTool('get_project_structure', {
      path: folderPath,
      maxDepth: 5,
      instance_id: instanceId,
    });
    assertNoError(fullTree, 'get_project_structure returns smoke fixture');
    assert(Array.isArray(fullTree.children), 'get_project_structure preserves populated children');
    const partNode = fullTree.children.find((child) => child.name === 'SmokePart');
    const scriptNode = fullTree.children.find((child) => child.name === 'SmokeScript');
    const nestedNode = scriptNode?.children?.find((child) => child.name === 'NestedModule');
    assert(partNode && !Object.hasOwn(partNode, 'children'), 'get_project_structure omits children from a leaf');
    assert(Array.isArray(scriptNode?.children), 'get_project_structure preserves a branch children array');
    assert(
      nestedNode && !Object.hasOwn(nestedNode, 'children'),
      'get_project_structure omits children from a nested leaf',
    );

    const truncatedTree = await client.callTool('get_project_structure', {
      path: folderPath,
      maxDepth: 0,
      instance_id: instanceId,
    });
    const truncatedPart = truncatedTree.children?.find((child) => child.name === 'SmokePart');
    assert(
      truncatedPart?.hasMore === true &&
        truncatedPart.childCount === 0 &&
        !Object.hasOwn(truncatedPart, 'children'),
      'get_project_structure preserves max-depth markers when children are omitted',
    );

    const setProp = await client.callTool('set_properties', {
      instancePath: partPath,
      properties: { Transparency: 0.25 },
      instance_id: instanceId,
    });
    assert(setProp.summary?.failed === 0, 'set_properties updates smoke part');

    const props = await client.callTool('get_instance_properties', {
      instancePath: partPath,
      instance_id: instanceId,
    });
    assertNoError(props, 'get_instance_properties succeeds');
    assert(props.properties?.Name === 'SmokePart', 'get_instance_properties returns updated object');

    const attrs = await client.callTool('get_attributes', {
      instancePath: partPath,
      instance_id: instanceId,
    });
    assert(attrs.attributes?.SmokeAttr?.value === 'ok', 'get_attributes returns smoke attribute');

    const emptyAttrs = await client.callTool('get_attributes', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assert(
      emptyAttrs.count === 0 && !Object.hasOwn(emptyAttrs, 'attributes'),
      'get_attributes omits an empty attributes collection while preserving count',
    );

    const tag = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: 'return game:GetService("CollectionService"):HasTag(workspace.__RSMCP_ToolingSmoke.SmokePart, "RSMCPToolingSmoke")',
    });
    assert(tag.success === true && String(tag.returnValue) === 'true', 'execute_luau handles project-specific tag work');

    const setSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: 'local value = 41\nreturn value + 1\n',
      instance_id: instanceId,
    });
    assert(setSource.success === true, 'set_script_source updates smoke script');

    const source = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      line_range: '1-2',
      instance_id: instanceId,
    });
    assertContains(source.source, 'return value + 1', 'get_script_source returns edited source');

    const escapeHeavyLines = [
      String.raw`local newline = "\n"`,
      String.raw`local tab = "\t"`,
      String.raw`local carriage = "\r"`,
      String.raw`local quote = "say \"hi\""`,
      String.raw`local windowsPath = "C:\\Users\\dev\\file.lua"`,
      'return newline .. tab .. carriage .. quote .. windowsPath',
    ];
    const escapedSetSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: escapeHeavyLines.join('\n'),
      instance_id: instanceId,
    });
    assert(escapedSetSource.success === true, 'set_script_source accepts escape-heavy source');
    await assertExactScriptSource(
      escapeHeavyLines,
      'set_script_source preserves already-decoded source text exactly',
    );

    const quotedReplacement = String.raw`local quote = "say \"bye\""`;
    const escapedEdit = await client.callTool('edit_script_lines', {
      instancePath: scriptPath,
      old_string: escapeHeavyLines[3],
      new_string: quotedReplacement,
      line_range: '4',
      instance_id: instanceId,
    });
    assert(escapedEdit.success === true, 'edit_script_lines accepts escape-heavy source text');
    escapeHeavyLines[3] = quotedReplacement;
    await assertExactScriptSource(
      escapeHeavyLines,
      'edit_script_lines preserves already-decoded search and replacement text exactly',
    );

    const insertedEscapeLines = [
      String.raw`local pattern = "\\n\\t"`,
      String.raw`local json = "{\"key\":\"value\\n\"}"`,
    ];
    const escapedInsert = await client.callTool('insert_script_lines', {
      instancePath: scriptPath,
      afterLine: 5,
      newContent: insertedEscapeLines.join('\n'),
      instance_id: instanceId,
    });
    assert(escapedInsert.success === true, 'insert_script_lines accepts escape-heavy source text');
    escapeHeavyLines.splice(5, 0, ...insertedEscapeLines);
    await assertExactScriptSource(
      escapeHeavyLines,
      'insert_script_lines preserves already-decoded source text exactly',
    );

    const pathPattern = String.raw`C:\\Users\\dev\\file.lua`;
    const pathReplacement = String.raw`D:\\Build\\out.lua`;
    const escapedFindAndReplace = await client.callTool('find_and_replace_in_scripts', {
      pattern: pathPattern,
      replacement: pathReplacement,
      caseSensitive: true,
      path: scriptPath,
      classFilter: 'Script',
      instance_id: instanceId,
    });
    assert(
      escapedFindAndReplace.success === true
        && escapedFindAndReplace.totalReplacements === 1
        && escapedFindAndReplace.scriptsModified === 1,
      `find_and_replace_in_scripts accepts exact escape-heavy text (${JSON.stringify(escapedFindAndReplace)})`,
    );
    escapeHeavyLines[4] = escapeHeavyLines[4].replace(pathPattern, pathReplacement);
    await assertExactScriptSource(
      escapeHeavyLines,
      'find_and_replace_in_scripts preserves already-decoded pattern and replacement text exactly',
    );

    const openedDraft = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local script = workspace.__RSMCP_ToolingSmoke.SmokeScript
local editor = game:GetService("ScriptEditorService")
local opened, openError = editor:OpenScriptDocumentAsync(script)
if not opened then error(openError) end
local document = editor:FindScriptDocument(script)
if not document then error("ScriptDocument did not open") end
local lineCount = document:GetLineCount()
local lastLine = document:GetLine(lineCount)
local edited, editError = document:EditTextAsync("", 1, 1, lineCount, #lastLine + 1)
if not edited then error(editError) end
return document:GetText()
`,
    });
    assert(openedDraft.success === true, 'execute_luau opens and empties a live ScriptDocument');
    assert(String(openedDraft.returnValue) === '', 'open ScriptDocument exposes its empty live draft');

    const draftSource = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      line_range: '1',
      instance_id: instanceId,
    });
    assert(draftSource.source === '1: ',
      `get_script_source preserves an empty live editor draft (${JSON.stringify(draftSource)})`);

    const populatedDraft = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: 'local beforeClear = true\nreturn beforeClear\n',
      instance_id: instanceId,
    });
    assert(populatedDraft.success === true && populatedDraft.method === 'UpdateSourceAsync',
      `set_script_source populates the empty live editor draft editor-safely (${JSON.stringify(populatedDraft)})`);

    const populatedRead = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assertContains(populatedRead.source, 'return beforeClear',
      'get_script_source confirms the live editor draft is non-empty before clearing');

    const clearedSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: '',
      instance_id: instanceId,
    });
    assert(clearedSource.success === true && clearedSource.method === 'UpdateSourceAsync',
      `set_script_source clears a non-empty live editor draft editor-safely (${JSON.stringify(clearedSource)})`);

    const clearedRead = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assert(clearedRead.source === '1: ',
      `set_script_source cleared the non-empty live draft exactly (${JSON.stringify(clearedRead)})`);

    const restoredDraft = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: 'local value = 40\nreturn value + 1\n',
      instance_id: instanceId,
    });
    assert(restoredDraft.success === true, 'set_script_source restores an empty live editor draft');

    const editedLines = await client.callTool('edit_script_lines', {
      instancePath: scriptPath,
      old_string: 'local value = 40',
      new_string: 'local value = 41',
      line_range: '1',
      instance_id: instanceId,
    });
    assert(editedLines.success === true, 'edit_script_lines verifies its open-document write');

    const insertedLines = await client.callTool('insert_script_lines', {
      instancePath: scriptPath,
      afterLine: 1,
      newContent: 'local bonus = 1',
      instance_id: instanceId,
    });
    assert(insertedLines.success === true, 'insert_script_lines verifies its open-document write');

    const editedReturn = await client.callTool('edit_script_lines', {
      instancePath: scriptPath,
      old_string: 'return value + 1',
      new_string: 'return value + bonus',
      line_range: '3',
      instance_id: instanceId,
    });
    assert(editedReturn.success === true, 'edit_script_lines updates inserted line positions');

    const deletedLines = await client.callTool('delete_script_lines', {
      instancePath: scriptPath,
      line_range: '2',
      instance_id: instanceId,
    });
    assert(deletedLines.success === true, 'delete_script_lines verifies its open-document write');

    const replacedDraft = await client.callTool('find_and_replace_in_scripts', {
      pattern: 'bonus',
      replacement: '1',
      path: scriptPath,
      classFilter: 'Script',
      instance_id: instanceId,
    });
    assert(replacedDraft.success === true && replacedDraft.scriptsModified === 1 && replacedDraft.scriptsFailed === 0,
      `find_and_replace_in_scripts verifies its open-document write (${JSON.stringify(replacedDraft)})`);

    const replacedNested = await client.callTool('find_and_replace_in_scripts', {
      pattern: 'NESTED_OLD',
      replacement: 'NESTED_NEW',
      path: scriptPath,
      classFilter: 'ModuleScript',
      instance_id: instanceId,
    });
    assert(replacedNested.success === true && replacedNested.scriptsModified === 1,
      `find_and_replace_in_scripts traverses children of a filtered parent script (${JSON.stringify(replacedNested)})`);

    const finalSource = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      instance_id: instanceId,
    });
    assertContains(finalSource.source, 'return value + 1', 'line mutation sequence lands in the live draft');

    const nestedSource = await client.callTool('get_script_source', {
      instancePath: nestedScriptPath,
      instance_id: instanceId,
    });
    assertContains(nestedSource.source, 'NESTED_NEW', 'nested script replacement lands');

    const exec = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: 'return workspace:FindFirstChild("__RSMCP_ToolingSmoke") ~= nil',
    });
    assert(exec.success === true, 'execute_luau edit target succeeds');
    assert(String(exec.returnValue) === 'true', 'execute_luau can read edited Workspace state');

    const viewed = await client.callTool('selection', {
      action: 'view',
      path: partPath,
      padding: 1.1,
      instance_id: instanceId,
    });
    assert(viewed.success === true && viewed.cameraPosition, 'selection view frames the smoke part');

    const selected = await client.callTool('selection', {
      action: 'set',
      paths: [partPath],
      instance_id: instanceId,
    });
    assert(selected.success === true && selected.selected === 1, 'selection set selects the smoke part');

    const selection = await client.callTool('selection', {
      action: 'get',
      instance_id: instanceId,
    });
    assertNoError(selection, 'selection get succeeds');
    assert(
      selection.selection?.some((entry) => entry.path === partPath),
      'selection get returns the smoke part',
    );

    const cleared = await client.callTool('selection', {
      action: 'set',
      paths: [],
      instance_id: instanceId,
    });
    assert(cleared.success === true && cleared.selected === 0, 'selection set clears with empty paths');
  } finally {
    const deleted = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `local folder = workspace:FindFirstChild("__RSMCP_ToolingSmoke")
if folder then
  local script = folder:FindFirstChild("SmokeScript")
  if script then
    local document = game:GetService("ScriptEditorService"):FindScriptDocument(script)
    if document then document:CloseAsync() end
  end
  folder:Destroy()
end
return true`,
    });
    assert(deleted.success === true, 'execute_luau cleans up smoke folder');
  }
}

const PREVIEW_FOLDER = '__RSMCP_UiPreviewSmoke';

function previewStorySource(mode) {
  const mountThrow = mode === 'mount_throw' ? 'error("RSMCP_MOUNT_THROW")' : '';
  const cleanupThrow = mode === 'cleanup_throw' ? 'error("RSMCP_CLEANUP_THROW")' : '';
  return `local folder = script.Parent
return function(target)
  folder:SetAttribute("${mode}_mounts", (folder:GetAttribute("${mode}_mounts") or 0) + 1)
  local panel = Instance.new("Frame")
  panel.Name = "RSMCPPreviewPanel"
  panel.AnchorPoint = Vector2.new(0.5, 0.5)
  panel.Position = UDim2.fromScale(0.5, 0.5)
  panel.Size = UDim2.fromOffset(320, 160)
  panel.BackgroundColor3 = Color3.fromRGB(255, 0, 200)
  panel.BorderSizePixel = 0
  local button = Instance.new("TextButton")
  button.Name = "Bump"
  button.Size = UDim2.new(1, 0, 0, 80)
  button.Position = UDim2.fromOffset(0, 80)
  button.BackgroundTransparency = 1
  button.Text = "RSMCP PREVIEW"
  button.TextColor3 = Color3.new(1, 1, 1)
  button.TextScaled = true
  button.Parent = panel
  button.Activated:Connect(function()
    folder:SetAttribute("${mode}_clicks", (folder:GetAttribute("${mode}_clicks") or 0) + 1)
  end)
  local input = Instance.new("TextBox")
  input.Name = "Input"
  input.Size = UDim2.new(1, 0, 0, 80)
  input.Text = ""
  input.Parent = panel
  input.FocusLost:Connect(function(submitted)
    folder:SetAttribute("${mode}_typed", input.Text)
    folder:SetAttribute("${mode}_submitted", submitted)
  end)
  panel.Parent = target
  ${mountThrow}
  return function()
    folder:SetAttribute("${mode}_cleanups", (folder:GetAttribute("${mode}_cleanups") or 0) + 1)
    panel:Destroy()
    ${cleanupThrow}
  end
end`;
}

async function previewState(client, instanceId) {
  const state = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `local HttpService = game:GetService("HttpService")
local StarterGui = game:GetService("StarterGui")
local leftovers = {}
for _, child in StarterGui:GetChildren() do
  if string.sub(child.Name, 1, 15) == "__MCPUiPreview_" then table.insert(leftovers, child.Name) end
end
local folder = workspace:FindFirstChild("${PREVIEW_FOLDER}")
return HttpService:JSONEncode({ leftovers = leftovers, devGui = StarterGui.ShowDevelopmentGui, attrs = folder and folder:GetAttributes() or {} })`,
  });
  assert(state.success === true, 'execute_luau reads preview state');
  return JSON.parse(String(state.returnValue));
}

function assertPreviewClean(state, devGui, label) {
  assert(state.leftovers.length === 0, `${label}: no StarterGui __MCPUiPreview_* leftovers (${state.leftovers.join(',')})`);
  assert(state.devGui === devGui, `${label}: StarterGui.ShowDevelopmentGui restored to ${devGui}`);
}

async function callPreview(client, instanceId, args) {
  const res = await client.rpc('tools/call', {
    name: 'preview_ui',
    arguments: { settle_seconds: 0.5, format: 'png', instance_id: instanceId, ...args },
  }, 120_000);
  let body = res.structuredContent;
  const text = String(res?.content?.find((item) => item.type === 'text')?.text ?? JSON.stringify(body ?? ''));
  if (body === undefined) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  return { res, text, body, image: (res.content ?? []).find((item) => item.type === 'image') };
}

async function runUiPreviewSmoke(client, instanceId) {
  console.log('\n=== preview_ui isolated smoke ===');
  const modes = ['ok', 'mount_throw', 'cleanup_throw'];
  // Requires a sibling module so editing a dependency (not only the story) is covered by hot reload.
  const controlledSource = `local folder = script.Parent
local PREFIX = require(script.Parent.Prefix)
local SUFFIX = ""
return {
  controls = { Title = "Before", Tag = "" },
  render = function(props)
    folder:SetAttribute("controlled_renders", (folder:GetAttribute("controlled_renders") or 0) + 1)
    local label = Instance.new("TextLabel")
    label.Name = "ControlledLabel"
    label.Size = UDim2.fromOffset(400, 100)
    -- Mirrors the rendered text into an attribute so tests can watch it without calling preview_ui.
    local function show(values)
      label.Text = PREFIX .. values.Title .. SUFFIX .. values.Tag
      folder:SetAttribute("controlled_text", label.Text)
    end
    show(props.controls)
    folder:SetAttribute("controlled_first", label.Text)
    label.Parent = props.target
    local unsubscribe = props.subscribe(show)
    return function()
      folder:SetAttribute("controlled_cleanups", (folder:GetAttribute("controlled_cleanups") or 0) + 1)
      unsubscribe()
      label:Destroy()
      if folder:GetAttribute("controlled_cleanup_error") then error("RSMCP_RELOAD_CLEANUP_BOOM") end
    end
  end,
}`;
  const sources = { ...Object.fromEntries(modes.map((m) => [m, previewStorySource(m)])), controlled: controlledSource };
  const setup = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: `local old = workspace:FindFirstChild("${PREVIEW_FOLDER}")
if old then old:Destroy() end
local folder = Instance.new("Folder")
folder.Name = "${PREVIEW_FOLDER}"
local sources = game:GetService("HttpService"):JSONDecode(${JSON.stringify(JSON.stringify(sources))})
for name, source in sources do
  local module = Instance.new("ModuleScript")
  module.Name = name .. ".story"
  module.Source = source
  module.Parent = folder
end
local prefix = Instance.new("ModuleScript")
prefix.Name = "Prefix"
prefix.Source = 'return ""'
prefix.Parent = folder
local gui = Instance.new("ScreenGui")
gui.Name = "NativeHud"
gui.Enabled = false
local label = Instance.new("TextLabel")
label.Name = "Title"
label.Size = UDim2.fromOffset(200, 50)
label.Text = "RSMCP NATIVE"
label.Parent = gui
gui.Parent = folder
folder.Parent = workspace
return true`,
  });
  assert(setup.success === true && String(setup.returnValue) === 'true', 'execute_luau creates preview fixtures');
  const story = (mode) => `game.Workspace.${PREVIEW_FOLDER}["${mode}.story"]`;
  const { devGui: originalDevGui } = await previewState(client, instanceId);

  try {
    // Exercise ownership/restoration even when the caller normally shows GUI.
    const devGui = false;
    await client.callTool('execute_luau', {
      target: 'edit', instance_id: instanceId,
      code: 'game:GetService("StarterGui").ShowDevelopmentGui = false',
    });

    const mounted = await callPreview(client, instanceId, { action: 'mount', target: story('ok') });
    assert(mounted.res.isError !== true, `mount succeeds (${mounted.text})`);
    assert(mounted.body?.kind === 'story' && mounted.body?.storyType === 'Functional', 'mount reports a Functional story');
    assert(mounted.image?.mimeType === 'image/png', 'mount returns a PNG image');
    if (process.env.RSMCP_PREVIEW_SAVE_PNG === '1') {
      const outDir = path.join(REPO_ROOT, '.local', 'ui-preview-smoke');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'ok-story.png'), Buffer.from(mounted.image.data, 'base64'));
      console.log(`Saved preview PNG for inspection: ${outDir}`);
    }

    const inspected = await callPreview(client, instanceId, { action: 'inspect' });
    const bump = inspected.body?.nodes?.find((node) => node.path === 'RSMCPPreviewPanel/Bump');
    assert(bump?.button === true && bump?.visible === true, `inspect lists the story button (${inspected.text.slice(0, 300)})`);

    const clicked = await callPreview(client, instanceId, { action: 'click', element: 'RSMCPPreviewPanel/Bump' });
    assert(clicked.res.isError !== true, `click succeeds (${clicked.text})`);
    assert((await previewState(client, instanceId)).attrs.ok_clicks === 1, 'click activates the story button once');

    const typed = await callPreview(client, instanceId, {
      action: 'type', element: 'RSMCPPreviewPanel/Input', text: 'preview typed text', submit: true,
    });
    assert(typed.res.isError !== true && typed.image?.mimeType === 'image/png', `type returns a screenshot (${typed.text})`);
    const typedState = await previewState(client, instanceId);
    assert(typedState.attrs.ok_typed === 'preview typed text' && typedState.attrs.ok_submitted === true,
      'type focuses the TextBox, enters text, and submits with Return');
    const screenshot = await callPreview(client, instanceId, { action: 'screenshot' });
    assert(screenshot.image?.mimeType === 'image/png', 'screenshot captures the mounted UI');

    const unmounted = await callPreview(client, instanceId, { action: 'unmount' });
    assert(unmounted.res.isError !== true, `unmount succeeds (${unmounted.text})`);
    let state = await previewState(client, instanceId);
    assert(state.attrs.ok_mounts === 1 && state.attrs.ok_cleanups === 1, 'story mounted and cleaned up once');
    assertPreviewClean(state, devGui, 'after unmount');

    const again = await callPreview(client, instanceId, { action: 'unmount' });
    assert(again.res.isError === true && /nothing to unmount/.test(again.text), 'second unmount reports nothing mounted');

    const throwing = await callPreview(client, instanceId, { action: 'mount', target: story('mount_throw') });
    assert(throwing.res.isError === true && throwing.text.includes('RSMCP_MOUNT_THROW'), 'mount reports a story error');
    assertPreviewClean(await previewState(client, instanceId), devGui, 'after mount failure');

    const cleanupMount = await callPreview(client, instanceId, { action: 'mount', target: story('cleanup_throw') });
    assert(cleanupMount.res.isError !== true, `cleanup_throw mounts (${cleanupMount.text})`);
    const cleanupFailure = await callPreview(client, instanceId, { action: 'unmount' });
    assert(cleanupFailure.res.isError === true && cleanupFailure.text.includes('RSMCP_CLEANUP_THROW'), 'unmount reports a cleanup error');
    state = await previewState(client, instanceId);
    assert(state.attrs.cleanup_throw_cleanups === 1, 'cleanup ran exactly once');
    assertPreviewClean(state, devGui, 'after cleanup failure');

    const native = await callPreview(client, instanceId, { action: 'mount', target: `game.Workspace.${PREVIEW_FOLDER}.NativeHud` });
    assert(native.res.isError !== true && native.body?.kind === 'screengui', `native ScreenGui mounts (${native.text})`);
    assert(native.body?.notes?.some((note) => note.includes('do not hot-reload')), 'native previews say they do not hot-reload');
    const nativeTree = await callPreview(client, instanceId, { action: 'inspect' });
    assert(nativeTree.body?.nodes?.some((node) => node.path === 'Title' && node.text === 'RSMCP NATIVE'), 'inspect lists the cloned label');
    await callPreview(client, instanceId, { action: 'unmount' });
    assertPreviewClean(await previewState(client, instanceId), devGui, 'after native unmount');

    const controlled = await callPreview(client, instanceId, {
      action: 'mount', target: story('controlled'), controls: { Title: 'Initial' },
    });
    assert(controlled.body?.controls?.some((control) => control.name === 'Title' && control.value === 'Initial'),
      `mount applies initial controls (${controlled.text})`);
    const replaced = await callPreview(client, instanceId, {
      action: 'mount', target: story('controlled'), controls: { Title: 'Replacement' },
    });
    assert(replaced.body?.replaced === story('controlled'), 'mount replaces an existing preview');
    assert((await previewState(client, instanceId)).devGui === true,
      'replacement keeps development GUI enabled without a false/true toggle');
    const changed = await callPreview(client, instanceId, { action: 'set_controls', controls: { Title: 'After' } });
    assert(changed.image?.mimeType === 'image/png', 'set_controls returns a screenshot');
    const changedTree = await callPreview(client, instanceId, { action: 'inspect' });
    assert(changedTree.body?.nodes?.some((node) => node.path === 'ControlledLabel' && node.text === 'After'),
      'set_controls updates the mounted story, not just its metadata');
    const unknown = await callPreview(client, instanceId, { action: 'set_controls', controls: { Missing: 'value' } });
    assert(unknown.res.isError === true && unknown.text.includes('Unknown control'), 'unknown controls are rejected');
    assert(controlled.body?.notes?.some((note) => note.includes('Hot reloading is on')), 'story mounts report hot reloading');

    // Hot reload: editing a required module or the story reloads it in place, without a remount, and
    // re-applies the agent's controls. A syntax error is reported, then recovers on the next edit.
    const setSource = async (name, source) => {
      const edited = await client.callTool('execute_luau', {
        target: 'edit',
        instance_id: instanceId,
        code: `workspace["${PREVIEW_FOLDER}"][${JSON.stringify(name)}].Source = ${JSON.stringify(source)}
return true`,
      });
      assert(edited.success === true, `execute_luau edits ${name}`);
    };
    const labels = async () => {
      const tree = await callPreview(client, instanceId, { action: 'inspect' });
      return (tree.body?.nodes ?? []).filter((node) => node.path === 'ControlledLabel').map((node) => node.text);
    };
    await setSource('Prefix', 'return "v2:"');
    const dependencyReload = await callPreview(client, instanceId, { action: 'screenshot' });
    assert(dependencyReload.body?.reload?.reloads >= 1 && dependencyReload.body.reload.status === 'ready'
      && dependencyReload.body.replaced === undefined, `editing a required module hot-reloads the story (${dependencyReload.text})`);
    assert(dependencyReload.body.reload.controlsReapplied?.includes('Title'), 'agent-set controls are re-applied after a reload');
    assert(dependencyReload.image?.mimeType === 'image/png', 'the post-reload screenshot is returned');
    let texts = await labels();
    assert(texts.length === 1 && texts[0] === 'v2:After', `dependency edit shows without remount and keeps controls (${texts})`);
    // Also changes the default of Tag, which the agent never set: reloads start from current defaults.
    const fixedStory = controlledSource.replace('local SUFFIX = ""', 'local SUFFIX = "!"').replace('Tag = ""', 'Tag = "+"');
    await setSource('controlled.story', fixedStory);
    texts = await labels();
    assert(texts.length === 1 && texts[0] === 'v2:After!+', `story edit hot-reloads, keeps set controls, and takes new defaults (${texts})`);
    await setSource('controlled.story', 'return {');
    const broken = await callPreview(client, instanceId, { action: 'screenshot' });
    assert(broken.res.isError !== true && broken.body?.reload?.status === 'failed' && typeof broken.body.reload.error === 'string',
      `a failed reload is reported in the next result (${broken.text})`);
    const blocked = await callPreview(client, instanceId, { action: 'click', x: 10, y: 10 });
    assert(blocked.res.isError === true && blocked.text.includes('failed to hot-reload'), 'interactions fail while the reload is broken');
    await setSource('controlled.story', fixedStory);
    const recovered = await callPreview(client, instanceId, { action: 'screenshot' });
    assert(recovered.body?.reload?.status === 'ready', `fixing the source recovers the preview (${recovered.text})`);
    texts = await labels();
    assert(texts.length === 1 && texts[0] === 'v2:After!+', `recovered story keeps the agent's controls (${texts})`);
    const reloadState = await previewState(client, instanceId);
    assert(reloadState.attrs.controlled_renders - reloadState.attrs.controlled_cleanups === 1,
      `every reload cleaned up the previous load (${reloadState.attrs.controlled_renders} renders, ${reloadState.attrs.controlled_cleanups} cleanups)`);

    // Runs Luau in the edit DataModel that watches the rendered text, so these steps prove behaviour without
    // any preview_ui call in between.
    const watch = async (code, label) => {
      const watched = await client.callTool('execute_luau', {
        target: 'edit',
        instance_id: instanceId,
        code: `local HttpService = game:GetService("HttpService")
local f = workspace["${PREVIEW_FOLDER}"]
local events = {}
local conn = f:GetAttributeChangedSignal("controlled_text"):Connect(function()
  table.insert(events, f:GetAttribute("controlled_text"))
end)
${code}
conn:Disconnect()
return HttpService:JSONEncode({ events = events, first = f:GetAttribute("controlled_first"), final = f:GetAttribute("controlled_text") })`,
      });
      assert(watched.success === true, `execute_luau ${label}`);
      return JSON.parse(String(watched.returnValue));
    };
    const waitFor = (text) => `local t0 = os.clock()
while os.clock() - t0 < 10 and f:GetAttribute("controlled_text") ~= "${text}" do task.wait() end
task.wait(0.3)`;

    // The monitor re-applies the agent's controls after a reload by itself: the new load first renders the
    // story default, then the override, with no preview_ui action in between.
    const background = await watch(`f.Prefix.Source = 'return "v3:"'
${waitFor('v3:After!+')}`, 'watches a background re-apply');
    assert(background.first === 'v3:Before!+' && background.final === 'v3:After!+',
      `controls are re-applied in the background after a reload (first render ${background.first}; ${background.events.join(' -> ')})`);

    // A second reload that lands while the first one's controls are being re-applied still ends with the
    // overrides applied to the latest load and exactly one live story.
    const race = await watch(`local triggered
local trigger = f:GetAttributeChangedSignal("controlled_text"):Connect(function()
  local text = f:GetAttribute("controlled_text")
  if not triggered and string.sub(text, 1, 3) == "r1:" then
    triggered = text
    f.Prefix.Source = 'return "r2:"'
  end
end)
f.Prefix.Source = 'return "r1:"'
${waitFor('r2:After!+')}
trigger:Disconnect()
table.insert(events, "second reload triggered at " .. tostring(triggered))`, 'races two reloads');
    assert(race.final === 'r2:After!+', `back-to-back reloads end with the overrides applied (${race.events.join(' -> ')})`);
    const raced = await callPreview(client, instanceId, { action: 'screenshot' });
    assert(raced.body?.reload?.status === 'ready' && raced.body.reload.reloads >= 2, `the next action reports both reloads (${raced.text})`);
    texts = await labels();
    const raceState = await previewState(client, instanceId);
    assert(texts.length === 1 && texts[0] === 'r2:After!+'
      && raceState.attrs.controlled_renders - raceState.attrs.controlled_cleanups === 1, `racing reloads leak nothing (${texts})`);

    // Reload report fields: two reloads between actions, a cleanup error from the replaced load, and an override
    // whose control was removed by the edit.
    await watch(`f:SetAttribute("controlled_cleanup_error", true)
f.Prefix.Source = 'return "v4:"'
${waitFor('v4:After!+')}
f:SetAttribute("controlled_cleanup_error", nil)`, 'reloads with a failing cleanup');
    const renamed = fixedStory.replace('Title = "Before"', 'Heading = "Before"').replaceAll('values.Title', 'values.Heading');
    await watch(`workspace["${PREVIEW_FOLDER}"]["controlled.story"].Source = ${JSON.stringify(renamed)}
${waitFor('v4:Before!+')}`, 'renames a set control');
    const report = await callPreview(client, instanceId, { action: 'screenshot' });
    const reloadReport = report.body?.reload ?? {};
    assert(reloadReport.reloads === 2, `the report counts every reload since the last action (${report.text})`);
    assert(reloadReport.controlsDropped?.some((dropped) => dropped.name === 'Title'), 'a removed control is reported as dropped');
    assert(reloadReport.storyErrors?.some((err) => err.includes('RSMCP_RELOAD_CLEANUP_BOOM')), 'late story errors are reported');

    // A reload that stays loading longer than the action wait: results say so, interactions are refused, and the
    // preview recovers once the slow require finishes.
    await setSource('Prefix', 'task.wait(35) return "slow:"');
    const pending = await callPreview(client, instanceId, { action: 'screenshot' });
    assert(pending.body?.reload?.status === 'loading' && String(pending.body.reload.note).includes('still reloading'),
      `a long reload is reported as still loading (${pending.text})`);
    const refused = await callPreview(client, instanceId, { action: 'click', x: 10, y: 10 });
    assert(refused.res.isError === true && refused.text.includes('still hot-reloading'), `interactions are refused while loading (${refused.text})`);
    const slow = await watch(waitFor('slow:Before!+').replace('< 10', '< 30'), 'waits for the slow reload');
    assert(slow.final === 'slow:Before!+', `the slow reload finishes (${slow.final})`);
    const settled = await callPreview(client, instanceId, { action: 'screenshot' });
    assert(settled.body?.reload?.status === 'ready' && settled.body.reload.reloads === undefined,
      `the next action reports that the slow reload settled, without counting it twice (${settled.text})`);

    // Only this test's own managed/reused instance is touched. Starting Run
    // must dispose the edit preview before a different DataModel is rendered.
    const started = await client.callTool('solo_playtest', { action: 'start', mode: 'run', instance_id: instanceId });
    try {
      assert(started.success === true, 'Run starts with a preview mounted');
    } finally {
      const stopped = await client.callTool('solo_playtest', { action: 'stop', instance_id: instanceId });
      assert(stopped.success === true, 'Run stops after checking preview disposal');
    }
    const afterRun = await previewState(client, instanceId);
    assertPreviewClean(afterRun, devGui, 'after playtest auto-unmount');
    assert(afterRun.attrs.controlled_renders === afterRun.attrs.controlled_cleanups, 'auto-unmount cleans up the hot-reloaded story');
    const expired = await callPreview(client, instanceId, { action: 'inspect' });
    assert(expired.res.isError === true && expired.text.includes('No UI preview is mounted'), 'playtest start disposes preview state');
  } finally {
    await callPreview(client, instanceId, { action: 'unmount' }).catch(() => undefined);
    const deleted = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `local folder = workspace:FindFirstChild("${PREVIEW_FOLDER}")
if folder then folder:Destroy() end
game:GetService("StarterGui").ShowDevelopmentGui = ${originalDevGui ? 'true' : 'false'}
return true`,
    });
    assert(deleted.success === true, 'execute_luau cleans up preview fixtures');
  }
}


async function main() {
  const existingInstanceId = process.env.MCP_INSTANCE_ID?.trim();
  if (existingInstanceId) {
    const managedInstanceRegistryDirectory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-tooling-registry-'));
    const client = new McpClient('regular-tooling-existing', {
      env: {
        ...SERVER_ENV,
        ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: managedInstanceRegistryDirectory,
      },
    });
    try {
      await client.start();
      await client.initialize();
      await runEditModeToolSmoke(client, existingInstanceId);
      await runUiPreviewSmoke(client, existingInstanceId);
    } finally {
      try {
        await client.stop();
      } finally {
        rmSync(managedInstanceRegistryDirectory, { recursive: true, force: true });
      }
    }
    return;
  }

  assertStudioTestProfile();
  assertStudioDirectoryIsolation();

  if (await isPortOpen(BASE_PORT)) {
    throw new Error(`Port ${BASE_PORT} is already occupied. Stop existing MCP servers before running this smoke test.`);
  }
  if (!windowsPortIsAvailable(BASE_PORT)) {
    throw new Error(
      `A Windows process is listening on port ${BASE_PORT}. ` +
      'Studio would connect to it instead of the test server.',
    );
  }

  const worker = await createIsolatedStudioDirectory({ prefix: 'tooling-smoke' });
  const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  let client;
  let launch;
  let bodyError;

  try {
    client = new McpClient('regular-tooling-primary', {
      command: 'node',
      args: [DIST, '--auto-install-plugin'],
      env: {
        ...SERVER_ENV,
        ...worker.environment,
        MCP_PLUGINS_DIR: worker.pluginsDirectory,
        RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
        ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR: worker.managedInstanceRegistryDirectory,
      },
      startupTimeoutMs: 60000,
    });
    await client.start();
    await client.initialize();

    launch = await launchManagedPlace(client, worker.workingDirectory);
    const edit = await waitForEditInstance(client, version, launch.instance_id);
    await runEditModeToolSmoke(client, edit.instanceId);
    await runUiPreviewSmoke(client, edit.instanceId);
  } catch (error) {
    bodyError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (client && launch) {
      try {
        await closeManagedInstance(client, launch);
      } catch (error) {
        cleanupErrors.push(error);
        try {
          await closeStudioProcess({
            processId: launch.pid,
            startedAtFileTime: launch.process_started_at_file_time,
          });
        } catch (identityError) {
          cleanupErrors.push(identityError);
        }
      }
    }
    if (client) {
      try {
        await client.stop();
        await waitPortClosed(BASE_PORT);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await worker.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
      console.warn(`Retaining Studio worker after unconfirmed job drain: ${worker.workingDirectory}`);
    }
    if (cleanupErrors.length > 0) {
      if (bodyError) {
        throw new AggregateError(
          [bodyError, ...cleanupErrors],
          `Studio tooling smoke failed and cleanup also failed: ${cleanupErrors.map(String).join('; ')}`,
          { cause: bodyError },
        );
      }
      throw new AggregateError(cleanupErrors, 'Studio tooling smoke cleanup failed');
    }
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n❌ regular Studio tooling smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

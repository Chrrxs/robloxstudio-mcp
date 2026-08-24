#!/usr/bin/env node

import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BASE_PORT, McpClient, DIST, REPO_ROOT, assert, assertContains } from './lib/mcp-client.mjs';
import { windowsPortIsAvailable } from './lib/test-port.mjs';
import {
  closeStudioProcess,
  configureStudioDirectoryIsolation,
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
      const instances = connected.instances ?? [];
      const edit = instances.find((inst) => inst.id === instanceId && inst.roles?.includes('edit'));
      if (edit) {
        const statusResponse = await fetch(`http://127.0.0.1:${BASE_PORT}/status`);
        const status = await statusResponse.json();
        const peer = status.instances?.find((inst) => inst.role === 'edit' && inst.instanceId === instanceId);
        if (!peer) {
          last = { connected, status };
          await delay(1000);
          continue;
        }
        assert(peer.pluginVariant === 'main', 'regular tooling loaded the main plugin');
        assert(peer.pluginVersion === expectedVersion, `Studio plugin version is v${expectedVersion}`);
        assert(peer.serverVersion === expectedVersion, `MCP server version is v${expectedVersion}`);
        assert(peer.versionMismatch === false, 'regular tooling has no version mismatch');
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
  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
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


async function main() {
  const existingInstanceId = process.env.MCP_INSTANCE_ID?.trim();
  if (existingInstanceId) {
    const client = new McpClient('regular-tooling-existing', { env: SERVER_ENV });
    try {
      await client.start();
      await client.initialize();
      await runEditModeToolSmoke(client, existingInstanceId);
    } finally {
      await client.stop();
    }
    return;
  }

  if (await isPortOpen(BASE_PORT)) {
    throw new Error(`Port ${BASE_PORT} is already occupied. Stop existing MCP servers before running this smoke test.`);
  }
  if (!windowsPortIsAvailable(BASE_PORT)) {
    throw new Error(
      `A Windows process is listening on port ${BASE_PORT}. ` +
      'Studio would connect to it instead of the test server.',
    );
  }

  await configureStudioDirectoryIsolation({ requireStudioClosed: false });
  const worker = createIsolatedStudioDirectory({ prefix: 'tooling-smoke' });
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
        MCP_PLUGINS_DIR: worker.pluginsDirectory,
        RSMCP_STUDIO_WORKING_DIRECTORY: worker.workingDirectory,
      },
      startupTimeoutMs: 60000,
    });
    await client.start();
    await client.initialize();

    launch = await launchManagedPlace(client, worker.workingDirectory);
    const edit = await waitForEditInstance(client, version, launch.instance_id);
    await runEditModeToolSmoke(client, edit.instanceId);
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
      await configureStudioDirectoryIsolation({ requireStudioClosed: false });
    } catch (error) {
      cleanupErrors.push(error);
    }
    await delay(1000);
    try {
      worker.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
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

#!/usr/bin/env node
// Regression coverage for canonical DataModel paths. The plugin should emit
// bracket-quoted paths for unsafe names, accept those paths everywhere, and
// still accept legacy paths such as "..dir" for names that begin with a dot.

import {
  McpClient,
  runTest,
  assert,
  assertContains,
  selectEditInstance,
  waitForEditPeer,
} from './lib/mcp-client.mjs';

const LUAU_KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export',
  'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or',
  'repeat', 'return', 'then', 'true', 'type', 'until', 'while',
]);

function quoteSegment(segment) {
  return `"${segment
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"')}"`;
}

function canonicalSegment(segment) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && !LUAU_KEYWORDS.has(segment)
    ? `.${segment}`
    : `[${quoteSegment(segment)}]`;
}

function childPath(parentPath, childName) {
  return `${parentPath}${canonicalSegment(childName)}`;
}

function assertNoError(value, label) {
  assert(!value?.error, `${label}${value?.error ? ` (${value.error})` : ''}`);
}

function containsPath(value, targetPath) {
  if (value === targetPath) return true;
  if (Array.isArray(value)) return value.some((item) => containsPath(item, targetPath));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsPath(item, targetPath));
  }
  return false;
}

await runTest('canonical instance paths resolve across tools', async ({ track }) => {
  const client = track(new McpClient('path-resolution'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client);

  const instances = await client.callTool('get_connected_instances', {});
  const edit = selectEditInstance(instances);
  const instanceId = edit?.id ?? edit?.instanceId;
  assert(
    typeof instanceId === 'string' && instanceId.length > 0,
    process.env.MCP_INSTANCE_ID
      ? `requested edit instance ${process.env.MCP_INSTANCE_ID} is connected`
      : 'edit instance is connected',
  );

  let originalServerScriptServiceName;
  const renameService = await client.callTool('execute_luau', {
    target: 'edit',
    instance_id: instanceId,
    code: 'local svc = game:GetService("ServerScriptService")\nlocal old = svc.Name\nsvc.Name = "__RSMCP_RenamedServerScriptService"\nreturn old',
  });
  if (renameService.success === true && typeof renameService.returnValue === 'string') {
    originalServerScriptServiceName = renameService.returnValue;
    assert(originalServerScriptServiceName !== '__RSMCP_RenamedServerScriptService',
      'renamed ServerScriptService to exercise GetService root resolution');
  } else {
    console.log('  SKIP service rename assertion: ServerScriptService.Name was not writable');
  }

  const rootName = `__RSMCP_PathResolution_${Date.now()}`;
  const rootPath = childPath('game.ServerScriptService', rootName);
  const segments = [
    '.dot',
    'Name With Spaces',
    'A.B.C',
    'quote"child',
    '[bracket]',
    'slash\\child',
    'tab\tchild',
    'line\nchild',
    'end',
  ];
  const dotFolderPath = childPath(rootPath, '.dir');
  const legacyScriptPath = childPath(dotFolderPath, 'ReproScript');
  let fixturesCreated = false;
  let breakpointWasSet = false;

  try {
    const setup = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: `
local service = game:GetService("ServerScriptService")
local rootName = ${JSON.stringify(rootName)}
local old = service:FindFirstChild(rootName)
if old then old:Destroy() end
local root = Instance.new("Folder")
root.Name = rootName
root.Parent = service
local current = root
for _, name in ipairs({ ${segments.map((segment) => JSON.stringify(segment)).join(', ')} }) do
    local folder = Instance.new("Folder")
    folder.Name = name
    folder.Parent = current
    current = folder
end
local script = Instance.new("Script")
script.Name = "Script.With Spaces"
script.Enabled = false
script.Parent = current
for _, name in ipairs({ "[bracket]", "Danger", "[\\\"Danger\\\"]", ".dir" }) do
    local folder = Instance.new("Folder")
    folder.Name = name
    folder.Parent = root
end
local legacyScript = Instance.new("Script")
legacyScript.Name = "ReproScript"
legacyScript.Enabled = false
legacyScript.Parent = root:FindFirstChild(".dir")
return true
`,
    });
    assert(setup.success === true && String(setup.returnValue) === 'true', 'execute_luau creates path-resolution fixtures');
    fixturesCreated = true;

    let currentPath = rootPath;
    for (const segment of segments) {
      const expectedPath = childPath(currentPath, segment);
      const props = await client.callTool('get_instance_properties', {
        instancePath: expectedPath,
        excludeSource: true,
        instance_id: instanceId,
      });
      assertNoError(props, `resolved canonical path for ${JSON.stringify(segment)}`);
      assert(props.properties?.Name === segment, `resolved instance name for ${JSON.stringify(segment)}`);
      currentPath = expectedPath;
    }

    const scriptName = 'Script.With Spaces';
    const scriptPath = childPath(currentPath, scriptName);

    const sourceText = 'local value = 41\nreturn value + 1\n';
    const setSource = await client.callTool('set_script_source', {
      instancePath: scriptPath,
      source: sourceText,
      instance_id: instanceId,
    });
    assert(setSource.success === true, 'set_script_source accepts canonical path');

    const source = await client.callTool('get_script_source', {
      instancePath: scriptPath,
      line_range: '1-2',
      instance_id: instanceId,
    });
    assertContains(source.source, 'return value + 1', 'get_script_source accepts canonical path');

    const project = await client.callTool('get_project_structure', {
      path: rootPath,
      maxDepth: 20,
      scriptsOnly: false,
      instance_id: instanceId,
    });
    assertNoError(project, 'get_project_structure accepts canonical path');
    assert(containsPath(project, scriptPath), 'get_project_structure emits canonical descendant path');

    const literalBracketLegacy = await client.callTool('get_instance_properties', {
      instancePath: `${rootPath}.[bracket]`,
      excludeSource: true,
      instance_id: instanceId,
    });
    assertNoError(literalBracketLegacy, 'legacy literal bracket path resolves');
    assert(literalBracketLegacy.properties?.Name === '[bracket]', 'legacy literal bracket path targets literal bracket name');

    const quotedLiteralLegacy = await client.callTool('get_instance_properties', {
      instancePath: `${rootPath}.["Danger"]`,
      excludeSource: true,
      instance_id: instanceId,
    });
    assertNoError(quotedLiteralLegacy, 'legacy quoted literal bracket path resolves');
    assert(quotedLiteralLegacy.properties?.Name === '["Danger"]', 'legacy quoted literal bracket path does not retarget sibling Danger');

    const legacyPath = `${rootPath}..dir.ReproScript`;
    const legacySourceSet = await client.callTool('set_script_source', {
      instancePath: legacyPath,
      source: '-- line one\nprint("legacy path works")\n',
      instance_id: instanceId,
    });
    assert(legacySourceSet.success === true, 'set_script_source accepts legacy ..dir path');

    const legacySource = await client.callTool('get_script_source', {
      instancePath: legacyScriptPath,
      line_range: '1-2',
      instance_id: instanceId,
    });
    assertContains(legacySource.source, 'legacy path works', 'canonical path reads source written through legacy path');

    const breakpoint = await client.callTool('breakpoints', {
      action: 'set',
      target: 'edit',
      script_path: legacyScriptPath,
      line: 2,
      enabled: true,
      continue_execution: true,
      log_message: '"path resolution"',
      instance_id: instanceId,
    });
    if (breakpoint.error === 'script_debugger_unavailable') {
      console.log('  SKIP breakpoint assertion: ScriptDebuggerService beta unavailable');
    } else {
      assert(breakpoint.ok === true, `breakpoints accepts canonical bracket path (${JSON.stringify(breakpoint)})`);
      breakpointWasSet = true;
    }
  } finally {
    if (breakpointWasSet) {
      await client.callTool('breakpoints', {
        action: 'remove',
        target: 'edit',
        script_path: legacyScriptPath,
        line: 2,
        instance_id: instanceId,
      }).catch(() => {});
    }
    if (fixturesCreated) {
      const deleted = await client.callTool('execute_luau', {
        target: 'edit',
        instance_id: instanceId,
        code: `local root = game:GetService("ServerScriptService"):FindFirstChild(${JSON.stringify(rootName)})
if root then root:Destroy() end
return true`,
      });
      assert(deleted.success === true, 'execute_luau cleans up path-resolution root folder');
    }
    if (originalServerScriptServiceName !== undefined) {
      await client.callTool('execute_luau', {
        target: 'edit',
        instance_id: instanceId,
        code: `game:GetService("ServerScriptService").Name = ${JSON.stringify(originalServerScriptServiceName)}`,
      }).catch(() => {});
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

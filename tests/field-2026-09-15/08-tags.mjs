#!/usr/bin/env node
// Field report #8: get_instance_properties exposes CollectionService tags, and search_tags maps a tag to the
// instances carrying it plus the scripts that use it literally; attribute-driven use yields dynamicHint.

import { McpClient, runTest, assert } from '../lib/mcp-client.mjs';

const SETUP = `
local CS = game:GetService("CollectionService")
local SSS = game:GetService("ServerScriptService")
for _, name in ipairs({ "Field8Static", "Field8Dynamic" }) do
	local old = SSS:FindFirstChild(name)
	if old then old:Destroy() end
end
local oldFolder = workspace:FindFirstChild("Field8")
if oldFolder then oldFolder:Destroy() end

local folder = Instance.new("Folder")
folder.Name = "Field8"
local part = Instance.new("Part")
part.Name = "Field8Part"
part.Anchored = true
part.Parent = folder
CS:AddTag(part, "Field8")
local dyn = Instance.new("Part")
dyn.Name = "Field8DynPart"
dyn.Anchored = true
dyn.Parent = folder
CS:AddTag(dyn, "Field8Dyn")
folder.Parent = workspace

local staticScript = Instance.new("Script")
staticScript.Name = "Field8Static"
staticScript.Enabled = false
staticScript.Source = 'local CS = game:GetService("CollectionService")\\nfor _, inst in ipairs(CS:GetTagged("Field8")) do\\n\\tprint(inst:GetFullName())\\nend'
staticScript.Parent = SSS

local dynamicScript = Instance.new("Script")
dynamicScript.Name = "Field8Dynamic"
dynamicScript.Enabled = false
dynamicScript:SetAttribute("Tag", "Field8Dyn")
dynamicScript.Source = 'local CS = game:GetService("CollectionService")\\nlocal tag = script:GetAttribute("Tag")\\nfor _, inst in ipairs(CS:GetTagged(tag)) do\\n\\tprint(inst:GetFullName())\\nend'
dynamicScript.Parent = SSS
return "ready"
`;

const CLEANUP = `
local SSS = game:GetService("ServerScriptService")
for _, name in ipairs({ "Field8Static", "Field8Dynamic" }) do
	local old = SSS:FindFirstChild(name)
	if old then old:Destroy() end
end
local oldFolder = workspace:FindFirstChild("Field8")
if oldFolder then oldFolder:Destroy() end
return "clean"
`;

function dump(label, body) {
  console.log(`  [${label}] ${JSON.stringify(body)}`);
}

await runTest('field #8: tags on get_instance_properties and search_tags', async ({ track }) => {
  const client = track(new McpClient('A'));
  await client.start();
  await client.initialize();
  const instance_id = process.env.MCP_INSTANCE_ID;

  const setup = await client.callTool('execute_luau', { target: 'edit', code: SETUP });
  assert(setup.success === true && String(setup.returnValue) === 'ready', 'edit DM staged tagged parts and two scripts');

  try {
    const grepDynamic = await client.callTool('grep_scripts', { pattern: 'Field8Dyn', instance_id });
    dump('grep_scripts Field8Dyn', { scriptsMatched: grepDynamic.scriptsMatched, scriptsSearched: grepDynamic.scriptsSearched });
    assert(grepDynamic.scriptsMatched === 0, 'symptom: grep_scripts cannot see the attribute-driven tag use');

    const props = await client.callTool('get_instance_properties', { instancePath: 'game.Workspace.Field8.Field8Part', instance_id });
    dump('get_instance_properties', { tags: props.tags, properties: Object.keys(props.properties ?? {}) });
    assert(Array.isArray(props.tags) && props.tags.includes('Field8'), `get_instance_properties lists tags (got ${JSON.stringify(props.tags)})`);

    const found = await client.callTool('search_tags', { tag: 'Field8', instance_id });
    dump('search_tags Field8', found);
    assert(found.tag === 'Field8', 'search_tags echoes the tag');
    assert(Array.isArray(found.instances) && found.instances.length === 1 && found.instances[0].endsWith('Field8.Field8Part'), `instances hold only the tagged part (got ${JSON.stringify(found.instances)})`);
    assert(found.instanceCount === 1 && found.truncated === false, 'instanceCount and truncated report the full list');
    assert(Array.isArray(found.scripts) && found.scripts.length === 1, `one script uses the literal (got ${JSON.stringify(found.scripts)})`);
    assert(found.scripts[0].instancePath.endsWith('ServerScriptService.Field8Static'), 'the literal user is Field8Static');
    assert(found.scripts[0].line === 2 && found.scripts[0].api === 'GetTagged', `line 2 via GetTagged (got line ${found.scripts[0].line}, api ${found.scripts[0].api})`);
    assert(found.dynamicHint === undefined, 'no dynamicHint when a literal user exists');

    const dynamic = await client.callTool('search_tags', { tag: 'Field8Dyn', instance_id });
    dump('search_tags Field8Dyn', dynamic);
    assert(dynamic.instances.length === 1 && dynamic.instances[0].endsWith('Field8.Field8DynPart'), 'the dynamically used tag still resolves its instances');
    assert(dynamic.scripts.length === 0, 'no script uses the dynamic tag literally');
    assert(typeof dynamic.dynamicHint === 'string' && dynamic.dynamicHint.length > 0, `dynamicHint explains the tag may come from Config/data (got ${dynamic.dynamicHint})`);

    const listing = await client.callTool('search_tags', { instance_id });
    dump('search_tags (all)', listing);
    const byTag = Object.fromEntries((listing.tags ?? []).map((entry) => [entry.tag, entry.count]));
    assert(byTag.Field8 === 1 && byTag.Field8Dyn === 1, `listing counts both tags once (got ${JSON.stringify(byTag)})`);

    const missing = await client.callTool('search_tags', { tag: 'Field8Missing', instance_id });
    dump('search_tags missing', missing);
    assert(missing.instances.length === 0 && missing.scripts.length === 0 && typeof missing.dynamicHint === 'string', 'an unused tag returns empty lists and the hint');
  } finally {
    try {
      await client.callTool('execute_luau', { target: 'edit', code: CLEANUP });
    } catch (error) {
      console.warn(`  (cleanup error, ignored): ${error.message}`);
    }
  }
}).then((ok) => process.exit(ok ? 0 : 1));

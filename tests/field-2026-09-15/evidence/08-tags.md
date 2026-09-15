# Field report #8 — CollectionService tag search (`search_tags` + `get_instance_properties.tags`)

Raw output: `raw-08-studio-red.txt` and `raw-08-jest-red.txt` (before, captured while the tests were still named `todo-08` and used `TODO8` identifiers), `raw-08-studio-green.txt`, `raw-06-08-16-jest-green.txt`.

## Symptom / reproduction

Test: `tests/field-2026-09-15/08-tags.mjs` (managed). The edit DataModel gets `workspace.Field8.Field8Part` (tag `Field8`), `Field8DynPart` (tag `Field8Dyn`), `ServerScriptService.Field8Static` (literal `CS:GetTagged("Field8")`) and `Field8Dynamic` (the tag name comes from `script:GetAttribute("Tag")`).

Command: `node tests/run-with-test-port.mjs tests/run-all.mjs --managed --test field-2026-09-15/08-tags.mjs`

Before (2026-09-15 11:28, `instance:p7b-le2`, unpatched plugin):

```
  [grep_scripts TODO8Dyn] {"scriptsMatched":0,"scriptsSearched":2}
  ✓ symptom: grep_scripts cannot see the attribute-driven tag use
  [get_instance_properties] {"properties":["ChildCount","Parent","CFrame","Material","Size","BottomSurface","CanCollide","Position","Anchored","Rotation","Transparency","Name","ClassName","Color","BrickColor","Shape","TopSurface"]}
❌ TODO #8: tags on get_instance_properties and search_tags FAILED: ASSERT FAIL: get_instance_properties lists tags (got undefined)
```

Jest before (`field-08-tags.test.ts`, `studio-script-search.test.ts` additions):

```
  ● TODO #8 search_tags › is a read-only catalog tool with tag, maxResults, and instance_id
    expect(received).toBeDefined()   Received: undefined
  ● TODO #8 search_tags › forwards tag and maxResults to /api/search-tags ...  TypeError: http_server_js_1.TOOL_HANDLERS.search_tags is not a function
  ● TODO #8 tag literal search helpers › tagLiteralPattern ...  TypeError: module.tagLiteralPattern is not a function
```

## Fix

- `studio-plugin/src/modules/handlers/QueryHandlers.ts`: `getInstanceProperties` adds `tags` (pcall `CollectionService:GetTags`; obtained through `game.GetService` because `studio-grep-responsiveness.test.ts` loads this file in Node through esbuild, where an `@rbxts/services` import fails in the `.lua` loader).
- `studio-plugin/src/modules/ScriptSearch.ts`: `tagLiteralPattern(tag)` (a `["']<tag>["']` pattern with Lua magic characters escaped) and `classifyTagUsage(line)` (`GetTagged|HasTag|AddTag|RemoveTag|GetInstanceAddedSignal|GetInstanceRemovedSignal|literal`).
- `studio-plugin/src/modules/handlers/TagHandlers.ts` (new): `/api/search-tags`. With `tag`: `CollectionService:GetTagged` paths (`maxResults`, default 100, max 1000; `instanceCount`, `truncated`) plus a static search through `QueryHandlers.grepScripts` with `usePattern` (`scripts[]: instancePath, className, line, text, api`; `scriptsSearched`, `scriptsTruncated`) and a `dynamicHint` when no script contains the literal. Without `tag`: `GetAllTags` plus counts (`tags[]`, `totalTags`; falls back to a `GetDescendants` scan when `GetAllTags` is unavailable).
- `studio-plugin/src/modules/Communication.ts`: import and the `"/api/search-tags"` route.
- `packages/core/src/tools/definitions.ts`: `search_tags` (category `read`; `tag`, `maxResults`, `instance_id`). `packages/core/src/http-server.ts`: `TOOL_PROXY_ENDPOINTS.search_tags`, `TOOL_HANDLERS.search_tags`. `packages/core/src/tools/index.ts`: `searchTags()` (validation plus `/api/search-tags` with the grep timeout).
- Shared tests: `tool-schema.test.ts` `methodNameOf.search_tags`; `mcp-runtime.test.ts` catalog counts 48 → 49, outputSchema 47 → 48, inspector 25 → 26, and the catalog budget 44,000 → 45,000 / 20,000 → 21,000 (measured on the final branch: 43,401 → 44,328 and 19,983 → 20,910 characters; `docs/token-efficiency.md` updated). README: tool line plus inspector count 24 → 25.

## After

Same command, final branch, 2026-09-15 13:15, `instance:fh4-p65`:

```
  [get_instance_properties] {"tags":["Field8"],"properties":[...]}
  ✓ get_instance_properties lists tags (got ["Field8"])
  [search_tags Field8] {"instances":["game.Workspace.Field8.Field8Part"],"truncated":false,"scripts":[{"line":2,"instancePath":"game.ServerScriptService.Field8Static","className":"Script","text":"for _, inst in ipairs(CS:GetTagged(\"Field8\")) do","api":"GetTagged"}],"scriptsSearched":2,"scriptsTruncated":false,"instanceCount":1,"tag":"Field8"}
  [search_tags Field8Dyn] {"dynamicHint":"No script contains this tag as a string literal. The tag name may come from a Config or data table, an attribute, or a StringValue; search those sources or the code that calls GetTagged with a variable.","instances":["game.Workspace.Field8.Field8DynPart"],"truncated":false,"scripts":[],"scriptsSearched":2,"scriptsTruncated":false,"instanceCount":1,"tag":"Field8Dyn"}
  [search_tags (all)] {"totalTags":6,"tags":[{"count":1,"tag":"Field8"},{"count":1,"tag":"Field8Dyn"},{"count":0,"tag":"TagEditorTagContainer"},{"count":1,"tag":"data-testid=--studio-foundation--stylesheet-wrapper"},{"count":1,"tag":"gui-object-defaults"},{"count":1,"tag":"size-full"}]}
  [search_tags missing] {"dynamicHint":"...","instances":[],"truncated":false,"scripts":[],"scriptsSearched":2,"scriptsTruncated":false,"instanceCount":0,"tag":"Field8Missing"}
✅ field #8: tags on get_instance_properties and search_tags PASSED
Closed managed Studio instance instance:fh4-p65
1/1 passed.
```

Runner exit code 0.

Note: `GetAllTags` also lists Studio's own CoreGui tags (`gui-object-defaults` and so on); the counts come from `GetTagged`, so CoreGui objects are counted too. They are not filtered out (the information is useful and CoreGui access is fine from the plugin).

Jest after: `field-08-tags.test.ts` 4/4, `studio-script-search.test.ts` 16/16 (three new tests).

## Regression

- `npm run typecheck` green.
- `npm run lint`: 8 errors / 40 warnings, all pre-existing on `origin/main`; no new ones.
- `npm test -w packages/core`: 41 suites / 714 tests green.
- `studio-grep-responsiveness.mjs` rerun on the final branch (`grep_scripts` shares `QueryHandlers.grepScripts` with `search_tags`); see the PR description.

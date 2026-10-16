import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { pathNotice } from '../path-notice.js';
import { RobloxStudioTools } from '../tools/index.js';

const ambiguousPaths = [{
  field: 'instancePath', path: 'game.Workspace.Twin.Worker', access: 'read',
  segment: 'Twin', parentPath: 'game.Workspace', matchCount: 2,
}];
const pathWarning = 'Ambiguous path game.Workspace.Twin.Worker; the first match was used.';

// Tool methods that rebuild the plugin response instead of passing it through.
function toolsReturning(response: Record<string, unknown>): RobloxStudioTools {
  const tools = new RobloxStudioTools(new BridgeService());
  const internals = tools as unknown as { _callSingle: () => Promise<Record<string, unknown>> };
  internals._callSingle = async () => response;
  return tools;
}

function body(result: { content: { text?: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? '{}');
}

describe('path notices from the Studio plugin', () => {
  test('pathNotice keeps only well-formed notice fields', () => {
    expect(pathNotice({ ambiguousPaths, pathWarning, other: 1 })).toEqual({ ambiguousPaths, pathWarning });
    expect(pathNotice({ ambiguousPaths: 'bad', pathWarning: 3 })).toEqual({});
    expect(pathNotice(undefined)).toEqual({});
  });

  test('get_script_source keeps the notice on success and on error', async () => {
    const success = body(await toolsReturning({
      instancePath: 'game.Workspace.Twin.Worker', className: 'Script', lineCount: 1, source: 'return 1',
      ambiguousPaths, pathWarning,
    }).getScriptSource('game.Workspace.Twin.Worker'));
    expect(success).toMatchObject({ source: 'return 1', ambiguousPaths, pathWarning });

    const failure = body(await toolsReturning({
      error: 'Instance not found: game.Workspace.Twin.Worker', ambiguousPaths, pathWarning,
    }).getScriptSource('game.Workspace.Twin.Worker'));
    expect(failure).toEqual({ error: 'Instance not found: game.Workspace.Twin.Worker', ambiguousPaths, pathWarning });
  });

  test('export_rbxm keeps the notice alongside the written file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmcp-path-notice-'));
    try {
      const outputPath = path.join(directory, 'out.rbxm');
      const result = body(await toolsReturning({
        base64: Buffer.from('rbxm').toString('base64'), instance_count: 1, ambiguousPaths, pathWarning,
      }).exportRbxm(['game.Workspace.Twin'], outputPath));
      expect(result).toEqual({ bytes_written: 4, instance_count: 1, output_path: outputPath, ambiguousPaths, pathWarning });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

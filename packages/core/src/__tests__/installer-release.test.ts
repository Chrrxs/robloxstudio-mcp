import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test.each([
  ['robloxstudio-mcp', 'MCPPlugin.rbxmx', 'main', false],
  ['robloxstudio-mcp', 'MCPPlugin.rbxmx', 'main', true],
  ['robloxstudio-mcp-inspector', 'MCPInspectorPlugin.rbxmx', 'inspector', false],
] as const)('%s fallback installs %s (%s, dev=%s)', async (packageName, assetName, variant, dev) => {
  const version = dev ? '3.1.5-dev.1' : '3.1.5';
  const urls: string[] = [];
  const installer = jest.fn().mockResolvedValue({ installed: true, destination: '/fixture/plugins' });
  const filename = resolve(__dirname, '../../../', packageName, 'src/install-plugin.ts');
  const source = readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(filename).href));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInNewContext(compiled.outputText, {
    module, exports: module.exports, Buffer, process,
    require: (name: string) => {
      if (name === 'path') return path;
      if (name === 'url') return { fileURLToPath };
      if (name === 'fs') return { existsSync: () => false, readFileSync: () => JSON.stringify({ version }) };
      if (name === '@chrrxs/robloxstudio-mcp-core') return { getPluginsFolder: () => '/fixture/plugins', installPluginAsset: installer };
      if (name === 'https') return {
        get: (url: string, _options: unknown, callback: (response: unknown) => void) => {
          urls.push(url);
          const body = urls.length === 1 ? JSON.stringify({
            tag_name: `v${version}`, assets: [{ name: assetName, browser_download_url: 'https://example.test/plugin' }],
          }) : 'downloaded-plugin';
          const response = Object.assign(Readable.from([Buffer.from(body)]), { statusCode: 200, headers: {} });
          queueMicrotask(() => callback(response));
          return Object.assign(new EventEmitter(), { setTimeout: jest.fn() });
        },
      };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  await (module.exports as { installPlugin(options: object): Promise<void> }).installPlugin({ dev, log: jest.fn(), warn: jest.fn() });
  expect(urls).toEqual([
    `https://api.github.com/repos/chrrxs/robloxstudio-mcp/releases/tags/v${version}`,
    'https://example.test/plugin',
  ]);
  expect(installer).toHaveBeenCalledWith(expect.objectContaining({
    expectedVersion: version, expectedVariant: variant, source: Buffer.from('downloaded-plugin'),
  }));
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as helpers from '../install-plugin-helpers.js';
import type { PluginInstallOptions } from '../plugin-installer.js';

type Options = PluginInstallOptions & { dev?: boolean };
interface Installer {
  installPlugin(options: Options): Promise<void>;
  installBundledPlugin(options: Options): Promise<void>;
}
interface Response {
  body: Buffer | string;
  statusCode?: number;
  headers?: { location?: string };
}

// Exercise the real edition entry points and shared implementation. Only HTTPS
// and the destination directory are substituted; validation and writes are real.
function loadModule(filename: string, moduleUrl: string, overrides: Record<string, unknown>) {
  const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(moduleUrl));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInNewContext(compiled.outputText, {
    module, exports: module.exports, Buffer, process, console,
    require: (name: string) => overrides[name] ?? require(name),
  });
  return module.exports;
}

describe.each(['main', 'inspector'] as const)('%s installer', (variant) => {
  const packageName = variant === 'main' ? 'robloxstudio-mcp' : 'robloxstudio-mcp-inspector';
  const assetName = variant === 'main' ? 'MCPPlugin.rbxmx' : 'MCPInspectorPlugin.rbxmx';
  const otherAssetName = variant === 'main' ? 'MCPInspectorPlugin.rbxmx' : 'MCPPlugin.rbxmx';
  const version = '9.8.7-dev.1+fixture';
  const asset = (embeddedVersion = version, embeddedVariant: string = variant) => Buffer.from([
    '<roblox version="4"><Item class="Script"><Properties><string name="Source"><![CDATA[',
    `local CURRENT_VERSION = "${embeddedVersion}";`,
    `local PLUGIN_VARIANT = "${embeddedVariant}";`,
    'local BASE_PORT = 58741;',
    'local DEFAULT_MCP_URL = "http://localhost:58741";',
    'local GLOBAL_SETTING_KEY = "MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1";',
    'local SETTING_KEY_PREFIX = "MCP_LAST_SUCCESSFUL_SERVER_URL_";',
    ']]></string></Properties></Item></roblox>',
  ].join('\n'));
  let root: string;
  let packageRoot: string;
  let plugins: string;
  let installer: Installer;
  let responses: Response[];
  let requests: { url: string; userAgent: string }[];
  let options: Options;
  let previousPort: string | undefined;

  const write = (filename: string, contents: string | Buffer) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    return filename;
  };
  const bundled = () => path.join(packageRoot, 'studio-plugin', assetName);
  const installed = () => path.join(plugins, assetName);
  const release = () => JSON.stringify({
    tag_name: `v${version}`, assets: [{ name: assetName, browser_download_url: 'https://example.test/plugin' }],
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'installer space-ü-'));
    packageRoot = path.join(root, 'packages', packageName);
    plugins = path.join(root, 'plugins');
    write(path.join(packageRoot, 'package.json'), JSON.stringify({ version }));
    previousPort = process.env.ROBLOX_STUDIO_PORT;
    delete process.env.ROBLOX_STUDIO_PORT;
    responses = [];
    requests = [];
    options = { log: jest.fn(), warn: jest.fn() };
    const corePath = path.resolve(__dirname, '../plugin-installer.ts');
    const core = loadModule(corePath, pathToFileURL(corePath).href, {
      './install-plugin-helpers.js': { ...helpers, getPluginsFolder: () => plugins },
      https: {
        get: (url: string, config: { headers: { 'User-Agent': string } }, callback: (response: unknown) => void) => {
          requests.push({ url, userAgent: config.headers['User-Agent'] });
          const response = responses.shift();
          if (!response) throw new Error(`Unexpected network request: ${url}`);
          const stream = Object.assign(Readable.from([Buffer.from(response.body)]), {
            statusCode: response.statusCode ?? 200, headers: response.headers ?? {},
          });
          queueMicrotask(() => callback(stream));
          return Object.assign(new EventEmitter(), { setTimeout: jest.fn() });
        },
      },
    });
    const wrapper = path.resolve(__dirname, '../../../', packageName, 'src/install-plugin.ts');
    installer = loadModule(wrapper, pathToFileURL(path.join(packageRoot, 'dist/index.js')).href, {
      '@chrrxs/robloxstudio-mcp-core': core,
    }) as Installer;
  });

  afterEach(() => {
    if (previousPort === undefined) delete process.env.ROBLOX_STUDIO_PORT;
    else process.env.ROBLOX_STUDIO_PORT = previousPort;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each(['installPlugin', 'installBundledPlugin'] as const)('%s prefers the package artifact over the checkout artifact', async (method) => {
    write(bundled(), asset());
    write(path.join(root, 'studio-plugin', assetName), asset('wrong-version'));
    await installer[method](options);
    expect(fs.readFileSync(installed())).toEqual(asset());
    expect(requests).toEqual([]);
  });

  test('discovers the checkout artifact relative to the edition module', async () => {
    write(path.join(root, 'studio-plugin', assetName), asset());
    await installer.installBundledPlugin(options);
    expect(fs.readFileSync(installed())).toEqual(asset());
  });

  test.each(['installPlugin', 'installBundledPlugin'] as const)('%s honors explicit paths without falling back', async (method) => {
    write(bundled(), asset('wrong-version'));
    const sourcePath = write(path.join(root, 'custom asset.rbxmx'), asset());
    await installer[method]({ ...options, sourcePath });
    expect(fs.readFileSync(installed())).toEqual(asset());
    await expect(installer[method]({ ...options, sourcePath: sourcePath + '.missing' })).rejects.toThrow('not found');
    expect(requests).toEqual([]);
  });

  test('bundled-only installation never downloads a missing artifact', async () => {
    await expect(installer.installBundledPlugin(options)).rejects.toThrow(
      variant === 'main' ? 'npm run build:plugin in' : 'npm run build:plugin:inspector in',
    );
    expect(requests).toEqual([]);
    expect(fs.existsSync(plugins)).toBe(false);
  });

  test.each([false, true])('downloads only the caller package version (dev=%s)', async (dev) => {
    responses.push({ body: release() }, { body: asset() });
    await installer.installPlugin({ ...options, dev });
    expect(requests).toEqual([
      { url: `https://api.github.com/repos/chrrxs/robloxstudio-mcp/releases/tags/v${encodeURIComponent(version)}`, userAgent: packageName },
      { url: 'https://example.test/plugin', userAgent: packageName },
    ]);
    expect(fs.readFileSync(installed())).toEqual(asset());
    expect(options.log).toHaveBeenCalledWith(dev && variant === 'main' ? 'Fetching matching dev release...' : 'Fetching matching release...');
  });

  test.each(['version', 'variant'] as const)('rejects downloaded %s mismatches before changing either installed edition', async (mismatch) => {
    write(installed(), 'existing edition');
    const other = write(path.join(plugins, otherAssetName), 'other edition');
    responses.push({ body: release() }, { body: mismatch === 'version' ? asset('0.0.0') : asset(version, 'wrong') });
    await expect(installer.installPlugin(options)).rejects.toThrow(`embeds ${mismatch}`);
    expect(fs.readFileSync(installed(), 'utf8')).toBe('existing edition');
    expect(fs.readFileSync(other, 'utf8')).toBe('other edition');
    expect(fs.readdirSync(plugins).sort()).toEqual([assetName, otherAssetName].sort());
  });

  test('preserves variant replacement and port configuration on repeated installation', async () => {
    process.env.ROBLOX_STUDIO_PORT = '59901';
    write(bundled(), asset());
    const other = write(path.join(plugins, otherAssetName), 'other edition');
    await installer.installPlugin({ ...options, replaceVariant: false });
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.readFileSync(installed(), 'utf8')).toContain('http://localhost:59901');
    expect(fs.readFileSync(bundled())).toEqual(asset());
    await installer.installPlugin(options);
    expect(fs.existsSync(other)).toBe(false);
    expect(options.log).toHaveBeenCalledWith(`${assetName} already installed.`);
  });

  test('follows an asset redirect', async () => {
    responses.push({ body: release() }, { body: '', statusCode: 302, headers: { location: 'https://example.test/redirected' } }, { body: asset() });
    await installer.installPlugin(options);
    expect(requests[2].url).toBe('https://example.test/redirected');
    expect(fs.readFileSync(installed())).toEqual(asset());
  });

  test.each([
    ['release error', [{ body: '', statusCode: 404 }], 'GitHub API returned HTTP 404'],
    ['missing asset', [{ body: JSON.stringify({ tag_name: 'fixture', assets: [] }) }], 'not found in release fixture'],
    ['download error', [{ body: 'RELEASE' }, { body: '', statusCode: 503 }], 'Download failed: HTTP 503'],
    ['missing redirect location', [{ body: 'RELEASE' }, { body: '', statusCode: 302 }], 'Redirect with no location'],
  ] as [string, Response[], string][])('reports %s without creating a plugin directory', async (_label, replies, error) => {
    responses.push(...replies.map(reply => ({ ...reply, body: reply.body === 'RELEASE' ? release() : reply.body })));
    await expect(installer.installPlugin(options)).rejects.toThrow(error);
    expect(fs.existsSync(plugins)).toBe(false);
  });
});

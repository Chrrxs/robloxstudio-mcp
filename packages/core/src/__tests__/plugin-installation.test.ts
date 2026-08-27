import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configurePluginAssetForPort,
  installPluginAsset,
  repairStaleStudioPluginDirectorySetting,
} from '../install-plugin-helpers.js';

describe('Studio plugin installation', () => {
  const source = Buffer.from([
    'const BASE_PORT = 58741;',
    'const DEFAULT_MCP_URL = "http://localhost:58741";',
    'const GLOBAL_SETTING_KEY = "MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1";',
    'const SETTING_KEY_PREFIX = "MCP_LAST_SUCCESSFUL_SERVER_URL_";',
    'const UNRELATED_ID = 58741;',
  ].join('\n'));
  const expectedPluginVersion = '1.2.3';
  const installLockName = '.robloxstudio-mcp-plugin-install.lock';

  const pluginAsset = ({
    version = expectedPluginVersion,
    variant = 'main',
    includeDefaultConnection = true,
  }: {
    version?: string;
    variant?: string;
    includeDefaultConnection?: boolean;
  } = {}): Buffer => Buffer.from([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<roblox version="4">',
    '<Item class="Script"><Properties><string name="Source"><![CDATA[',
    `local CURRENT_VERSION = "${version}";`,
    `local PLUGIN_VARIANT = "${variant}";`,
    ...(includeDefaultConnection
      ? [
          'local BASE_PORT = 58741;',
          'local DEFAULT_MCP_URL = "http://localhost:58741";',
          'local GLOBAL_SETTING_KEY = "MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1";',
          'local SETTING_KEY_PREFIX = "MCP_LAST_SUCCESSFUL_SERVER_URL_";',
        ]
      : []),
    ']]></string></Properties></Item>',
    '</roblox>',
  ].join('\n'));

  const tempDirectories: string[] = [];
  const createPluginsFolder = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-plugin-install-'));
    tempDirectories.push(directory);
    return directory;
  };

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('leaves the release artifact byte-for-byte unchanged on the default port', () => {
    const previousPort = process.env.ROBLOX_STUDIO_PORT;
    delete process.env.ROBLOX_STUDIO_PORT;
    try {
      expect(configurePluginAssetForPort(source)).toBe(source);
    } finally {
      if (previousPort === undefined) delete process.env.ROBLOX_STUDIO_PORT;
      else process.env.ROBLOX_STUDIO_PORT = previousPort;
    }
    expect(configurePluginAssetForPort(source, '58741')).toBe(source);
  });

  test('embeds a custom server port and isolates its remembered URL setting', () => {
    const configured = configurePluginAssetForPort(source, '43123').toString('utf8');

    expect(configured).toContain('const BASE_PORT = 43123;');
    expect(configured).toContain('http://localhost:43123');
    expect(configured).toContain('MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1_PORT_43123');
    expect(configured).toContain('MCP_LAST_SUCCESSFUL_SERVER_URL_PORT_43123_');
    expect(configured).toContain('const UNRELATED_ID = 58741;');
  });

  test.each(['0', '65536', 'not-a-port'])('rejects invalid custom port %s', (port) => {
    expect(() => configurePluginAssetForPort(source, port)).toThrow(/ROBLOX_STUDIO_PORT/);
  });

  test('fails rather than silently installing an artifact without the expected defaults', () => {
    expect(() => configurePluginAssetForPort(Buffer.from('unrelated plugin'), '43123'))
      .toThrow(/default port/i);
  });

  test('preserves both installed variants when configuration fails', () => {
    const pluginsFolder = createPluginsFolder();
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    const conflict = path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx');
    fs.writeFileSync(target, 'working-main');
    fs.writeFileSync(conflict, 'working-inspector');

    expect(() => installPluginAsset({
      pluginsFolder,
      assetName: 'MCPPlugin.rbxmx',
      otherAssetName: 'MCPInspectorPlugin.rbxmx',
      source: pluginAsset({ includeDefaultConnection: false }),
      expectedVersion: expectedPluginVersion,
      expectedVariant: 'main',
      rawPort: '43123',
    })).toThrow(/default port/i);

    expect(fs.readFileSync(target, 'utf8')).toBe('working-main');
    expect(fs.readFileSync(conflict, 'utf8')).toBe('working-inspector');
  });

  test.each([
    ['non-XML content', Buffer.from('not a plugin'), /Roblox XML/i],
    [
      'malformed XML',
      Buffer.from(pluginAsset().toString('utf8').replace('</Properties>', '</Broken>')),
      /XML/i,
    ],
    ['the wrong version', pluginAsset({ version: '9.9.9' }), /version 9\.9\.9.*1\.2\.3/i],
    ['the wrong variant', pluginAsset({ variant: 'inspector' }), /variant inspector.*main/i],
  ])('rejects %s before changing installed files', (_name, artifact, expectedError) => {
    const pluginsFolder = createPluginsFolder();
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    const conflict = path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx');
    fs.writeFileSync(target, 'working-main');
    fs.writeFileSync(conflict, 'working-inspector');

    expect(() => installPluginAsset({
      pluginsFolder,
      assetName: 'MCPPlugin.rbxmx',
      otherAssetName: 'MCPInspectorPlugin.rbxmx',
      source: artifact as Buffer,
      expectedVersion: expectedPluginVersion,
      expectedVariant: 'main',
      rawPort: '',
    })).toThrow(expectedError as RegExp);

    expect(fs.readFileSync(target, 'utf8')).toBe('working-main');
    expect(fs.readFileSync(conflict, 'utf8')).toBe('working-inspector');
  });

  test('does not mutate plugins while another installer holds the directory lock', () => {
    const pluginsFolder = createPluginsFolder();
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    const conflict = path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx');
    const lock = path.join(pluginsFolder, installLockName);
    fs.writeFileSync(target, 'working-main');
    fs.writeFileSync(conflict, 'working-inspector');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), '{"pid":1234}\n');

    expect(() => installPluginAsset({
      pluginsFolder,
      assetName: 'MCPPlugin.rbxmx',
      otherAssetName: 'MCPInspectorPlugin.rbxmx',
      source: pluginAsset(),
      expectedVersion: expectedPluginVersion,
      expectedVariant: 'main',
      rawPort: '',
    })).toThrow(/already in progress/i);

    expect(fs.readFileSync(target, 'utf8')).toBe('working-main');
    expect(fs.readFileSync(conflict, 'utf8')).toBe('working-inspector');
  });

  test('requires manual recovery instead of racing to reclaim an old lock', () => {
    const pluginsFolder = createPluginsFolder();
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    const conflict = path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx');
    const lock = path.join(pluginsFolder, installLockName);
    fs.writeFileSync(target, 'working-main');
    fs.writeFileSync(conflict, 'working-inspector');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), '{"pid":1234}\n');
    const oldTime = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, oldTime, oldTime);

    expect(() => installPluginAsset({
      pluginsFolder,
      assetName: 'MCPPlugin.rbxmx',
      otherAssetName: 'MCPInspectorPlugin.rbxmx',
      source: pluginAsset(),
      expectedVersion: expectedPluginVersion,
      expectedVariant: 'main',
      rawPort: '',
    })).toThrow(/remove that lock directory and retry/i);

    expect(fs.readFileSync(target, 'utf8')).toBe('working-main');
    expect(fs.readFileSync(conflict, 'utf8')).toBe('working-inspector');
    expect(fs.existsSync(lock)).toBe(true);
  });

  test('commits the configured target before removing the conflicting variant', () => {
    const pluginsFolder = createPluginsFolder();
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    const conflict = path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx');
    fs.writeFileSync(target, 'old-main');
    fs.writeFileSync(conflict, 'working-inspector');

    const result = installPluginAsset({
      pluginsFolder,
      assetName: 'MCPPlugin.rbxmx',
      otherAssetName: 'MCPInspectorPlugin.rbxmx',
      source: pluginAsset(),
      expectedVersion: expectedPluginVersion,
      expectedVariant: 'main',
      rawPort: '43123',
    });

    expect(result).toEqual({ destination: target, installed: true });
    expect(fs.readFileSync(target, 'utf8')).toContain('http://localhost:43123');
    expect(fs.existsSync(conflict)).toBe(false);
    expect(fs.readdirSync(pluginsFolder)).toEqual(['MCPPlugin.rbxmx']);
  });

  test('preserves the conflicting variant and cleans staging files when commit fails', () => {
    const pluginsFolder = createPluginsFolder();
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    const conflict = path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged');
    fs.writeFileSync(conflict, 'working-inspector');

    expect(() => installPluginAsset({
      pluginsFolder,
      assetName: 'MCPPlugin.rbxmx',
      otherAssetName: 'MCPInspectorPlugin.rbxmx',
      source: pluginAsset(),
      expectedVersion: expectedPluginVersion,
      expectedVariant: 'main',
      rawPort: '',
    })).toThrow();

    expect(fs.readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(fs.readFileSync(conflict, 'utf8')).toBe('working-inspector');
    expect(fs.readdirSync(pluginsFolder).sort()).toEqual([
      'MCPInspectorPlugin.rbxmx',
      'MCPPlugin.rbxmx',
    ]);
  });

  test('repairs the stale relative plugin directory left by the release gate', () => {
    const directory = createPluginsFolder();
    const settingsPath = path.join(directory, 'GlobalSettings_13.xml');
    fs.writeFileSync(settingsPath, [
      '<Settings>',
      '  <Content name="Studio">',
      '    <QDir name="PluginsDir">RsmcpIsolatedPlugins</QDir>',
      '    <string name="Untouched">preserve me</string>',
      '  </Content>',
      '</Settings>',
    ].join('\n'));

    expect(repairStaleStudioPluginDirectorySetting({
      settingsPath,
      studioPluginsDirectory: 'C:/Users/Test/AppData/Local/Roblox/Plugins',
    })).toBe(true);
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain(
      '<QDir name="PluginsDir">C:/Users/Test/AppData/Local/Roblox/Plugins</QDir>',
    );
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain(
      '<string name="Untouched">preserve me</string>',
    );
    expect(repairStaleStudioPluginDirectorySetting({
      settingsPath,
      studioPluginsDirectory: 'C:/Users/Test/AppData/Local/Roblox/Plugins',
    })).toBe(false);
  });

  test('preserves an intentional custom Studio plugin directory', () => {
    const directory = createPluginsFolder();
    const settingsPath = path.join(directory, 'GlobalSettings_13.xml');
    fs.writeFileSync(
      settingsPath,
      '<Settings><QDir name="PluginsDir">D:/Custom/Plugins</QDir></Settings>',
    );

    expect(repairStaleStudioPluginDirectorySetting({
      settingsPath,
      studioPluginsDirectory: 'C:/Users/Test/AppData/Local/Roblox/Plugins',
    })).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain('D:/Custom/Plugins');
  });

});

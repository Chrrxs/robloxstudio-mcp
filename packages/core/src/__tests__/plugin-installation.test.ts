import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
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
  const otherPid = process.pid === 1234 ? 1235 : 1234;

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

  const installMainPlugin = (pluginsFolder: string) => installPluginAsset({
    pluginsFolder,
    assetName: 'MCPPlugin.rbxmx',
    otherAssetName: 'MCPInspectorPlugin.rbxmx',
    source: pluginAsset(),
    expectedVersion: expectedPluginVersion,
    expectedVariant: 'main',
    rawPort: '',
    log: () => {},
  });

  const createInstallLock = (pluginsFolder: string, pid: number) => {
    const lock = path.join(pluginsFolder, installLockName);
    const owner = { pid, token: randomUUID(), createdAt: Date.now() };
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
    return { lock, owner };
  };

  afterEach(() => {
    jest.restoreAllMocks();
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
    const owner = { pid: process.pid, token: randomUUID(), createdAt: 0 };
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
    fs.utimesSync(lock, new Date(0), new Date(0));

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
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))).toEqual(owner);
  });

  test.each([
    ['missing metadata', undefined],
    ['malformed JSON', '{'],
    ['null metadata', 'null'],
    ['incomplete metadata', '{"pid":1234}'],
    ['invalid PID', JSON.stringify({ pid: -1, token: randomUUID(), createdAt: 0 })],
    ['invalid token', JSON.stringify({ pid: 1234, token: '../other', createdAt: 0 })],
    ['invalid creation time', JSON.stringify({ pid: 1234, token: randomUUID(), createdAt: 'old' })],
  ])('preserves locks with %s for manual recovery', (_name, metadata) => {
    const pluginsFolder = createPluginsFolder();
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    const conflict = path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx');
    const lock = path.join(pluginsFolder, installLockName);
    fs.writeFileSync(target, 'working-main');
    fs.writeFileSync(conflict, 'working-inspector');
    fs.mkdirSync(lock);
    if (metadata !== undefined) fs.writeFileSync(path.join(lock, 'owner.json'), metadata);
    fs.utimesSync(lock, new Date(0), new Date(0));

    expect(() => installMainPlugin(pluginsFolder)).toThrow(/remove that lock directory and retry/i);

    expect(fs.readFileSync(target, 'utf8')).toBe('working-main');
    expect(fs.readFileSync(conflict, 'utf8')).toBe('working-inspector');
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readdirSync(lock)).toEqual(metadata === undefined ? [] : ['owner.json']);
  });

  test('recovers a dead owner and releases the replacement lock after installing', () => {
    const pluginsFolder = createPluginsFolder();
    createInstallLock(pluginsFolder, otherPid);
    fs.writeFileSync(path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx'), 'old-inspector');
    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    expect(installMainPlugin(pluginsFolder).installed).toBe(true);
    expect(fs.readFileSync(path.join(pluginsFolder, 'MCPPlugin.rbxmx'))).toEqual(pluginAsset());
    expect(fs.readdirSync(pluginsFolder)).toEqual(['MCPPlugin.rbxmx']);
    expect(installMainPlugin(pluginsFolder).installed).toBe(false);
    expect(fs.readdirSync(pluginsFolder)).toEqual(['MCPPlugin.rbxmx']);
  });

  test.each(['EPERM', 'EACCES', 'UNKNOWN'])('preserves a lock when owner probing fails with %s', (code) => {
    const pluginsFolder = createPluginsFolder();
    const { lock, owner } = createInstallLock(pluginsFolder, otherPid);
    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Cannot inspect process'), { code });
    });

    expect(() => installMainPlugin(pluginsFolder)).toThrow(/cannot confirm.*owner.*exited/i);
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))).toEqual(owner);
    expect(fs.readdirSync(pluginsFolder)).toEqual([installLockName]);
    expect(fs.readdirSync(lock)).toEqual(['owner.json']);
  });

  test('preserves an owner that is still running in another process', () => {
    const pluginsFolder = createPluginsFolder();
    const { lock, owner } = createInstallLock(pluginsFolder, otherPid);
    jest.spyOn(process, 'kill').mockReturnValue(true);

    expect(() => installMainPlugin(pluginsFolder)).toThrow(/already in progress/i);
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))).toEqual(owner);
    expect(fs.readdirSync(pluginsFolder)).toEqual([installLockName]);
  });

  test('leaves an interrupted recovery claim intact for manual recovery', () => {
    const pluginsFolder = createPluginsFolder();
    const { lock, owner } = createInstallLock(pluginsFolder, otherPid);
    const claim = `recovery-${owner.token}`;
    fs.mkdirSync(path.join(lock, claim));
    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    expect(() => installMainPlugin(pluginsFolder)).toThrow(/remove that lock directory and retry/i);
    expect(fs.readdirSync(lock).sort()).toEqual(['owner.json', claim]);
    expect(fs.readdirSync(pluginsFolder)).toEqual([installLockName]);
  });

  test('serializes competing recovery attempts before moving an abandoned lock', () => {
    const pluginsFolder = createPluginsFolder();
    createInstallLock(pluginsFolder, otherPid);
    let probes = 0;
    let competingError: unknown;
    jest.spyOn(process, 'kill').mockImplementation(() => {
      probes += 1;
      if (probes === 2) {
        try {
          installMainPlugin(pluginsFolder);
        } catch (error) {
          competingError = error;
        }
        expect(fs.existsSync(path.join(pluginsFolder, 'MCPPlugin.rbxmx'))).toBe(false);
      }
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    expect(installMainPlugin(pluginsFolder).installed).toBe(true);
    expect(competingError).toEqual(expect.objectContaining({
      message: expect.stringMatching(/recovery.*in progress/i),
    }));
    expect(fs.readdirSync(pluginsFolder)).toEqual(['MCPPlugin.rbxmx']);
  });

  test('does not reclaim a replacement live lock after observing the previous dead owner', () => {
    const pluginsFolder = createPluginsFolder();
    const { lock } = createInstallLock(pluginsFolder, otherPid);
    const replacement = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
    jest.spyOn(process, 'kill').mockImplementation(() => {
      // Another reclaimer wins before this contender acquires its recovery claim.
      fs.rmSync(lock, { recursive: true });
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(replacement));
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    expect(() => installMainPlugin(pluginsFolder)).toThrow(/lock owner changed/i);
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))).toEqual(replacement);
    expect(fs.readdirSync(lock)).toEqual(['owner.json']);
    expect(fs.readdirSync(pluginsFolder)).toEqual([installLockName]);
  });

  test('cleans a recovered lock and staging file when the plugin commit fails', () => {
    const pluginsFolder = createPluginsFolder();
    createInstallLock(pluginsFolder, otherPid);
    const target = path.join(pluginsFolder, 'MCPPlugin.rbxmx');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged');
    jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    expect(() => installMainPlugin(pluginsFolder)).toThrow();
    expect(fs.readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(fs.readdirSync(pluginsFolder)).toEqual(['MCPPlugin.rbxmx']);
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

  test('does not release a lock whose ownership changed during installation', () => {
    const pluginsFolder = createPluginsFolder();
    const lock = path.join(pluginsFolder, installLockName);
    const replacement = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
    fs.writeFileSync(path.join(pluginsFolder, 'MCPInspectorPlugin.rbxmx'), 'old-inspector');

    installPluginAsset({
      pluginsFolder,
      assetName: 'MCPPlugin.rbxmx',
      otherAssetName: 'MCPInspectorPlugin.rbxmx',
      source: pluginAsset(),
      expectedVersion: expectedPluginVersion,
      expectedVariant: 'main',
      rawPort: '',
      log: () => fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(replacement)),
    });

    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))).toEqual(replacement);
    expect(fs.readFileSync(path.join(pluginsFolder, 'MCPPlugin.rbxmx'))).toEqual(pluginAsset());
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

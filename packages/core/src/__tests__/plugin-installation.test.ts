import { configurePluginAssetForPort } from '../install-plugin-helpers.js';

describe('Studio plugin installation', () => {
  const source = Buffer.from([
    'const BASE_PORT = 58741;',
    'const DEFAULT_MCP_URL = "http://localhost:58741";',
    'const GLOBAL_SETTING_KEY = "MCP_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1";',
    'const SETTING_KEY_PREFIX = "MCP_LAST_SUCCESSFUL_SERVER_URL_";',
    'const LEGACY_SETTING_KEY_PREFIX = "MCP_SERVER_URL_";',
    'const UNRELATED_ID = 58741;',
  ].join('\n'));

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
    expect(configured).toContain('MCP_SERVER_URL_PORT_43123_');
    expect(configured).toContain('const UNRELATED_ID = 58741;');
  });

  test.each(['0', '65536', 'not-a-port'])('rejects invalid custom port %s', (port) => {
    expect(() => configurePluginAssetForPort(source, port)).toThrow(/ROBLOX_STUDIO_PORT/);
  });

  test('fails rather than silently installing an artifact without the expected defaults', () => {
    expect(() => configurePluginAssetForPort(Buffer.from('unrelated plugin'), '43123'))
      .toThrow(/default port/i);
  });
});

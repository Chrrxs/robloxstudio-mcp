import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PREPARED_VARIANTS = [
  { workspace: 'robloxstudio-mcp', asset: 'MCPPlugin.rbxmx', variant: 'main' },
  { workspace: 'robloxstudio-mcp-inspector', asset: 'MCPInspectorPlugin.rbxmx', variant: 'inspector' },
];

export function assertFunctionalArtifactSource(source) {
  if (source !== 'local') {
    throw new Error('--with-functional requires current local-pack artifacts; RSMCP_E2E_ARTIFACT_SOURCE must be "local".');
  }
}

export function validatePreparedArtifacts(root) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !version) throw new Error('Prepared workspace has no release version.');
  for (const { workspace, asset, variant } of PREPARED_VARIANTS) {
    const packageDir = join(root, 'packages', workspace);
    // The bundled CLI obtains its server version from this package.json at runtime.
    const packageVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
    if (packageVersion !== version) throw new Error(`Prepared ${workspace} version ${packageVersion} does not match ${version}.`);
    const serverPath = join(packageDir, 'dist', 'index.js');
    if (!existsSync(serverPath) || readFileSync(serverPath, 'utf8').trim().length === 0) {
      throw new Error(`Prepared server output is missing or empty: ${serverPath}`);
    }
    const assetPath = join(root, 'studio-plugin', asset);
    const source = readFileSync(assetPath, 'utf8');
    for (const [name, expected] of [['CURRENT_VERSION', version], ['PLUGIN_VARIANT', variant]]) {
      const values = [...source.matchAll(new RegExp(`\\blocal\\s+${name}\\s*=\\s*"([^"]+)"\\s*;?`, 'g'))];
      if (values.length !== 1 || values[0][1] !== expected) {
        throw new Error(`Prepared ${asset} must embed ${name} = ${JSON.stringify(expected)} exactly once.`);
      }
    }
  }
}

// The caller owns the already-validated matching Studio session and its MCP
// primary. Supplying the exact instance means run-all never launches or closes it.
export async function runFunctionalInMatchingSession({ artifact, instanceId, client, env, execute }) {
  if (artifact.source !== 'local-pack' || artifact.variant !== 'main') {
    throw new Error('Functional reuse requires the current local-pack main matching session.');
  }
  if (typeof instanceId !== 'string' || !instanceId.trim()) {
    throw new Error('Functional reuse requires an exact existing Studio instance ID.');
  }
  await execute(process.execPath, ['tests/run-all.mjs'], {
    cwd: client.cwd,
    env: {
      ...env,
      ...client.env,
      MCP_INSTANCE_ID: instanceId,
      // The installer already owns the primary on this port; every nested
      // subprocess must attach rather than try to establish another primary.
      RSMCP_AUTO_ASSIGNED_PORT: '0',
      ROBLOX_STUDIO_REQUIRE_PRIMARY: '0',
    },
    // Full functional coverage includes paced Studio launches and long playtests.
    timeoutMs: 30 * 60 * 1000,
    forwardOutput: true,
  });
}

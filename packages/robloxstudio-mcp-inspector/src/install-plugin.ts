import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { get } from 'https';
import { IncomingMessage } from 'http';
import {
  getPluginsFolder,
  installPluginAsset,
} from '@chrrxs/robloxstudio-mcp-core';

const REPO = 'chrrxs/robloxstudio-mcp';
const ASSET_NAME = 'MCPInspectorPlugin.rbxmx';
const OTHER_VARIANT = 'MCPPlugin.rbxmx';
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

interface InstallOptions {
  sourcePath?: string;
  replaceVariant?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function httpsGet(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'robloxstudio-mcp-inspector' } }, resolve);
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
  });
}

async function download(url: string, redirects = 0): Promise<Buffer> {
  const res = await httpsGet(url);

  if (res.statusCode === 301 || res.statusCode === 302) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
    const location = res.headers.location;
    if (!location) throw new Error('Redirect with no location header');
    for await (const _chunk of res) {
      // Drain the response before following the redirect.
    }
    return download(location, redirects + 1);
  }

  if (res.statusCode !== 200) {
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of res) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_ASSET_BYTES) {
      res.destroy();
      throw new Error(
        `${ASSET_NAME} download exceeds the ${MAX_ASSET_BYTES}-byte limit.`,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await httpsGet(url);
  if (res.statusCode !== 200) {
    throw new Error(`GitHub API returned HTTP ${res.statusCode}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function bundledAssetPath(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDir, '..', 'studio-plugin', ASSET_NAME),
    join(currentDir, '..', '..', '..', 'studio-plugin', ASSET_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolvePluginAssetPath(sourcePath: string | undefined): string | null {
  if (sourcePath === undefined) return bundledAssetPath();
  return existsSync(sourcePath) ? sourcePath : null;
}

function packageVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8')) as { version?: string };
  if (!pkg.version) {
    throw new Error('Package version not found');
  }
  return pkg.version;
}

export async function installBundledPlugin(options: InstallOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const replaceVariant = options.replaceVariant ?? true;
  const sourcePath = resolvePluginAssetPath(options.sourcePath);
  if (!sourcePath) {
    throw new Error(
      `Bundled ${ASSET_NAME} not found. Run npm run build:plugin:inspector in this worktree first.`,
    );
  }

  const result = await installPluginAsset({
    pluginsFolder: getPluginsFolder(),
    assetName: ASSET_NAME,
    otherAssetName: OTHER_VARIANT,
    source: readFileSync(sourcePath),
    expectedVersion: packageVersion(),
    expectedVariant: 'inspector',
    replaceVariant,
    log,
    warn,
  });
  if (result.installed) {
    log(`Installed ${ASSET_NAME} to ${result.destination}`);
  }
}

export async function installPlugin(options: InstallOptions = {}): Promise<void> {
  const replaceVariant = options.replaceVariant ?? true;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const bundled = resolvePluginAssetPath(options.sourcePath);
  if (options.sourcePath !== undefined && !bundled) {
    throw new Error(`Plugin asset not found at explicit path ${options.sourcePath}.`);
  }

  if (bundled) {
    const result = await installPluginAsset({
      pluginsFolder: getPluginsFolder(),
      assetName: ASSET_NAME,
      otherAssetName: OTHER_VARIANT,
      source: readFileSync(bundled),
      expectedVersion: packageVersion(),
      expectedVariant: 'inspector',
      replaceVariant,
      log,
      warn,
    });
    if (result.installed) {
      log(`Installed bundled ${ASSET_NAME} to ${result.destination}`);
    } else {
      log(`${ASSET_NAME} already installed.`);
    }
    return;
  }

  log('Fetching latest release...');
  const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };

  const asset = release.assets?.find((a) => a.name === ASSET_NAME);
  if (!asset) {
    throw new Error(`${ASSET_NAME} not found in release ${release.tag_name}`);
  }

  log(`Downloading ${ASSET_NAME} from ${release.tag_name}...`);
  const downloaded = await download(asset.browser_download_url);
  const result = await installPluginAsset({
    pluginsFolder: getPluginsFolder(),
    assetName: ASSET_NAME,
    otherAssetName: OTHER_VARIANT,
    source: downloaded,
    expectedVersion: release.tag_name.replace(/^v/, ''),
    expectedVariant: 'inspector',
    replaceVariant,
    log,
    warn,
  });
  if (result.installed) {
    log(`Installed to ${result.destination}`);
  } else {
    log(`${ASSET_NAME} already installed.`);
  }
}

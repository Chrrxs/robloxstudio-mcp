import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { get } from 'https';
import { IncomingMessage } from 'http';
import {
  configurePluginAssetForPort,
  getPluginsFolder,
  handleVariantConflict,
} from '@chrrxs/robloxstudio-mcp-core';

const REPO = 'chrrxs/robloxstudio-mcp';
const ASSET_NAME = 'MCPPlugin.rbxmx';
const OTHER_VARIANT = 'MCPInspectorPlugin.rbxmx';
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

interface InstallOptions {
  dev?: boolean;
  sourcePath?: string;
  replaceVariant?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function httpsGet(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'robloxstudio-mcp' } }, resolve);
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
  });
}

async function download(url: string, dest: string, redirects = 0): Promise<void> {
  const res = await httpsGet(url);

  if (res.statusCode === 301 || res.statusCode === 302) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
    const location = res.headers.location;
    if (!location) throw new Error('Redirect with no location header');
    return download(location, dest, redirects + 1);
  }

  if (res.statusCode !== 200) {
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }

  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const cleanup = (err: Error) => {
      file.close(() => {
        try { unlinkSync(dest); } catch { /* already gone */ }
        reject(err);
      });
    };
    res.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
    file.on('error', cleanup);
    res.on('error', cleanup);
  });
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

async function findDevRelease(): Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }> {
  const releases = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=20`) as {
    tag_name: string;
    prerelease: boolean;
    assets: { name: string; browser_download_url: string }[];
  }[];
  const prerelease = releases.find(
    (r) => r.prerelease && r.assets.some((a) => a.name === ASSET_NAME),
  );
  if (!prerelease) {
    throw new Error(`No prerelease found with ${ASSET_NAME}`);
  }
  return prerelease;
}

function prepareInstall({
  replaceVariant,
  log,
  warn,
}: Required<Pick<InstallOptions, 'replaceVariant' | 'log' | 'warn'>>): string {
  const pluginsFolder = getPluginsFolder();

  if (!existsSync(pluginsFolder)) {
    mkdirSync(pluginsFolder, { recursive: true });
  }

  handleVariantConflict({
    pluginsFolder,
    otherAssetName: OTHER_VARIANT,
    replace: replaceVariant,
    log,
    warn,
  });

  return pluginsFolder;
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

function bundledPluginVersion(source: string): string | null {
  const match = readFileSync(source, 'utf8').match(/local CURRENT_VERSION = "([^"]+)"/);
  return match ? match[1] : null;
}

function assertBundledPluginVersion(source: string): void {
  const expected = packageVersion();
  const actual = bundledPluginVersion(source);
  if (actual !== expected) {
    throw new Error(
      `Bundled ${ASSET_NAME} version ${actual ?? 'unknown'} does not match package version ${expected}. ` +
      'Run npm run build:plugin before starting with --auto-install-plugin.',
    );
  }
}

function filesMatch(expected: Buffer, actualPath: string): boolean {
  if (!existsSync(actualPath)) return false;
  const actual = readFileSync(actualPath);
  return expected.length === actual.length && expected.equals(actual);
}

export async function installBundledPlugin(options: InstallOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const replaceVariant = options.replaceVariant ?? true;
  const source = resolvePluginAssetPath(options.sourcePath);
  if (!source) {
    throw new Error(
      `Bundled ${ASSET_NAME} not found. Run npm run build:plugin in this worktree first.`,
    );
  }
  assertBundledPluginVersion(source);

  const pluginsFolder = prepareInstall({ replaceVariant, log, warn });
  const dest = join(pluginsFolder, ASSET_NAME);
  const configured = configurePluginAssetForPort(readFileSync(source));

  if (filesMatch(configured, dest)) return;

  writeFileSync(dest, configured);
  log(`Installed ${ASSET_NAME} to ${dest}`);
}

export async function installPlugin(options: InstallOptions = {}): Promise<void> {
  const dev = options.dev ?? process.argv.includes('--dev');
  const replaceVariant = options.replaceVariant ?? true;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const bundled = resolvePluginAssetPath(options.sourcePath);
  if (options.sourcePath !== undefined && !bundled) {
    throw new Error(`Plugin asset not found at explicit path ${options.sourcePath}.`);
  }
  const pluginsFolder = prepareInstall({ replaceVariant, log, warn });

  if (bundled) {
    assertBundledPluginVersion(bundled);
    const dest = join(pluginsFolder, ASSET_NAME);
    const configured = configurePluginAssetForPort(readFileSync(bundled));
    if (filesMatch(configured, dest)) {
      log(`${ASSET_NAME} already installed.`);
      return;
    }
    writeFileSync(dest, configured);
    log(`Installed bundled ${ASSET_NAME} to ${dest}`);
    return;
  }

  log(dev ? 'Fetching latest dev prerelease...' : 'Fetching latest release...');
  const release = dev
    ? await findDevRelease()
    : await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`) as {
        tag_name: string;
        assets: { name: string; browser_download_url: string }[];
      };

  const asset = release.assets?.find((a) => a.name === ASSET_NAME);
  if (!asset) {
    throw new Error(`${ASSET_NAME} not found in release ${release.tag_name}`);
  }

  const dest = join(pluginsFolder, ASSET_NAME);
  log(`Downloading ${ASSET_NAME} from ${release.tag_name}...`);
  await download(asset.browser_download_url, dest);
  const downloaded = readFileSync(dest);
  const configured = configurePluginAssetForPort(downloaded);
  if (configured !== downloaded) writeFileSync(dest, configured);
  log(`Installed to ${dest}`);
}

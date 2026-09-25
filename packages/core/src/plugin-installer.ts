import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { get } from 'https';
import type { IncomingMessage } from 'http';
import {
  getPluginsFolder,
  installPluginAsset,
} from './install-plugin-helpers.js';
import type { PluginVariant } from './install-plugin-helpers.js';

const REPO = 'chrrxs/robloxstudio-mcp';
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export interface PluginInstallOptions {
  sourcePath?: string;
  replaceVariant?: boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Resolve artifacts and versions relative to the calling edition, including bundled CLIs. */
export function createPluginInstaller(moduleUrl: string, variant: PluginVariant) {
  const currentDir = dirname(fileURLToPath(moduleUrl));
  const ASSET_NAME = variant === 'main' ? 'MCPPlugin.rbxmx' : 'MCPInspectorPlugin.rbxmx';
  const OTHER_VARIANT = variant === 'main' ? 'MCPInspectorPlugin.rbxmx' : 'MCPPlugin.rbxmx';
  const userAgent = variant === 'main' ? 'robloxstudio-mcp' : 'robloxstudio-mcp-inspector';
  const buildCommand = variant === 'main' ? 'build:plugin' : 'build:plugin:inspector';

  function httpsGet(url: string): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = get(url, { headers: { 'User-Agent': userAgent } }, resolve);
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
      for await (const chunk of res) {
        void chunk;
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
    const pkg = JSON.parse(readFileSync(join(currentDir, '..', 'package.json'), 'utf8')) as { version?: string };
    if (!pkg.version) {
      throw new Error('Package version not found');
    }
    return pkg.version;
  }

  function installSource(source: Buffer, options: PluginInstallOptions) {
    return installPluginAsset({
      pluginsFolder: getPluginsFolder(),
      assetName: ASSET_NAME,
      otherAssetName: OTHER_VARIANT,
      source,
      expectedVersion: packageVersion(),
      expectedVariant: variant,
      replaceVariant: options.replaceVariant ?? true,
      log: options.log ?? console.log,
      warn: options.warn ?? console.warn,
    });
  }

  async function installBundledPlugin(options: PluginInstallOptions = {}): Promise<void> {
    const log = options.log ?? console.log;
    const sourcePath = resolvePluginAssetPath(options.sourcePath);
    if (!sourcePath) {
      throw new Error(
        `Bundled ${ASSET_NAME} not found. Run npm run ${buildCommand} in this worktree first.`,
      );
    }

    const result = installSource(readFileSync(sourcePath), options);
    if (result.installed) {
      log(`Installed ${ASSET_NAME} to ${result.destination}`);
    }
  }

  async function installPlugin(options: PluginInstallOptions = {}, dev = false): Promise<void> {
    const log = options.log ?? console.log;
    const bundled = resolvePluginAssetPath(options.sourcePath);
    if (options.sourcePath !== undefined && !bundled) {
      throw new Error(`Plugin asset not found at explicit path ${options.sourcePath}.`);
    }

    if (bundled) {
      const result = installSource(readFileSync(bundled), options);
      if (result.installed) {
        log(`Installed bundled ${ASSET_NAME} to ${result.destination}`);
      } else {
        log(`${ASSET_NAME} already installed.`);
      }
      return;
    }

    log(dev ? 'Fetching matching dev release...' : 'Fetching matching release...');
    const release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/tags/v${encodeURIComponent(packageVersion())}`) as {
      tag_name: string;
      assets: { name: string; browser_download_url: string }[];
    };

    const asset = release.assets?.find((a) => a.name === ASSET_NAME);
    if (!asset) {
      throw new Error(`${ASSET_NAME} not found in release ${release.tag_name}`);
    }

    log(`Downloading ${ASSET_NAME} from ${release.tag_name}...`);
    const downloaded = await download(asset.browser_download_url);
    const result = installSource(downloaded, options);
    if (result.installed) {
      log(`Installed to ${result.destination}`);
    } else {
      log(`${ASSET_NAME} already installed.`);
    }
  }

  return { installBundledPlugin, installPlugin };
}

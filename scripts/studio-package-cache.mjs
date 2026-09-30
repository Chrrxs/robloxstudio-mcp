import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

// The official installer downloads changed packages with BITS, which never
// runs jobs for a secondary-logon owner such as the dedicated test account.
// It skips any package already present in its download cache under the
// package's MD5, so the harness fills that cache over plain HTTPS first.
export const STUDIO_VERSION_URL = 'https://clientsettings.roblox.com/v2/client-version/WindowsStudio64';
export const STUDIO_DEPLOYMENT_BASE = 'https://setup.rbxcdn.com';
const VERSION = /^version-[a-f0-9]{16}$/u;
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.zip$/u;
const MD5 = /^[a-f0-9]{32}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGES = 256;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PACKAGE_TIMEOUT_MS = 10 * 60 * 1000;

export function studioPackageCacheDirectory(localAppData) {
  return path.join(localAppData, 'Roblox', 'Downloads', 'roblox-studio');
}

async function boundedText(response, limit, label) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds ${limit} bytes.`);
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`${label} exceeds ${limit} bytes.`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function fetchChecked(fetchImpl, url, timeoutMs, label) {
  // Never follow a redirect away from the approved Roblox hosts.
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return response;
}

/** The production Studio version the official installer and Studio's updater target. */
export async function resolveStudioTargetVersion({ fetchImpl = fetch } = {}) {
  const response = await fetchChecked(fetchImpl, STUDIO_VERSION_URL, REQUEST_TIMEOUT_MS, 'Studio version lookup');
  let body;
  try { body = JSON.parse(await boundedText(response, 4096, 'Studio version lookup')); }
  catch { throw new Error('Studio version lookup returned invalid JSON.'); }
  if (!body || typeof body !== 'object' || typeof body.clientVersionUpload !== 'string' || !VERSION.test(body.clientVersionUpload)) {
    throw new Error('Studio version lookup returned no valid version GUID.');
  }
  return { version: body.clientVersionUpload, displayVersion: typeof body.version === 'string' ? body.version.slice(0, 64) : undefined };
}

export function parseStudioPackageManifest(text) {
  const lines = text.split(/\r?\n/u);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== 'v0' || (lines.length - 1) % 4 !== 0) throw new Error('Studio package manifest has an unexpected format.');
  const packages = [];
  const names = new Set();
  for (let index = 1; index < lines.length; index += 4) {
    const [name, md5, packed, unpacked] = lines.slice(index, index + 4);
    const size = Number(packed);
    if (!PACKAGE.test(name) || !MD5.test(md5) || !/^\d+$/u.test(packed) || !/^\d+$/u.test(unpacked) ||
        !Number.isSafeInteger(size) || size <= 0 || size > MAX_PACKAGE_BYTES || names.has(name)) {
      throw new Error('Studio package manifest contains an invalid package entry.');
    }
    names.add(name);
    packages.push({ name, md5, size });
  }
  if (!packages.length || packages.length > MAX_PACKAGES) throw new Error('Studio package manifest has an invalid package count.');
  return packages;
}

async function fileMd5(file) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function cached(file, entry) {
  let info;
  try { info = lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!info.isFile()) throw new Error(`Studio package cache entry ${entry.md5} is not a regular file.`);
  return info.size === entry.size && await fileMd5(file) === entry.md5;
}

async function downloadPackage(fetchImpl, url, destination, entry) {
  const temporary = `${destination}.rsmcp-${randomBytes(8).toString('hex')}.tmp`;
  const response = await fetchChecked(fetchImpl, url, PACKAGE_TIMEOUT_MS, `Studio package ${entry.name}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Studio package ${entry.name} returned no body.`);
  const hash = createHash('md5');
  // Open before reading so failure cleanup can never race a pending open.
  let output;
  let size = 0;
  try {
    output = await open(temporary, 'wx', 0o600);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > entry.size) throw new Error(`Studio package ${entry.name} is larger than its manifest size.`);
      hash.update(value);
      await output.write(value);
    }
    await output.close();
    output = undefined;
    if (size !== entry.size || hash.digest('hex') !== entry.md5) {
      throw new Error(`Studio package ${entry.name} failed size or MD5 verification.`);
    }
    // Rename only verified bytes: the installer trusts any file under this name.
    renameSync(temporary, destination);
  } catch (error) {
    await reader.cancel().catch(() => {});
    await output?.close().catch(() => {});
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Ensure every package of `version` is present, verified, in the installer's
 * cache. Returns the number of packages downloaded. Existing entries with the
 * wrong size or hash are replaced.
 */
export async function prefetchStudioPackages({
  localAppData, version, fetchImpl = fetch, log = () => {}, concurrency = 4,
}) {
  if (!VERSION.test(version)) throw new Error('Invalid Studio version GUID.');
  const manifestResponse = await fetchChecked(fetchImpl, `${STUDIO_DEPLOYMENT_BASE}/${version}-rbxPkgManifest.txt`,
    REQUEST_TIMEOUT_MS, 'Studio package manifest');
  const packages = parseStudioPackageManifest(await boundedText(manifestResponse, MAX_MANIFEST_BYTES, 'Studio package manifest'));
  const directory = studioPackageCacheDirectory(localAppData);
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory()) throw new Error('Studio package cache must be an ordinary directory.');
  const missing = [];
  for (const entry of packages) {
    if (!await cached(path.join(directory, entry.md5), entry)) missing.push(entry);
  }
  if (missing.length) {
    const bytes = missing.reduce((total, entry) => total + entry.size, 0);
    log(`Prefetching ${missing.length} of ${packages.length} Studio ${version} packages (${Math.ceil(bytes / 1048576)} MiB) over HTTPS.`);
  }
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
    while (!failed && next < missing.length) {
      const entry = missing[next++];
      try {
        await downloadPackage(fetchImpl, `${STUDIO_DEPLOYMENT_BASE}/${version}-${entry.name}`,
          path.join(directory, entry.md5), entry);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return { packages: packages.length, downloaded: missing.length };
}

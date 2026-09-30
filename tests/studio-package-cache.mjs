#!/usr/bin/env node
// Offline only: a fake fetch serves synthetic packages; nothing is downloaded or installed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  STUDIO_DEPLOYMENT_BASE, STUDIO_VERSION_URL, parseStudioPackageManifest, prefetchStudioPackages,
  resolveStudioTargetVersion, studioPackageCacheDirectory,
} from '../scripts/studio-package-cache.mjs';

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');
const version = 'version-76e1a02649ad4f35';
const packages = {
  'RobloxStudio.zip': Buffer.from('studio executable package'),
  'content-fonts.zip': Buffer.from('fonts'),
  'ssl.zip': Buffer.from('ssl bundle'),
};
const manifest = (entries = packages) => ['v0', ...Object.entries(entries).flatMap(([name, bytes]) =>
  [name, md5(bytes), String(bytes.length), String(bytes.length * 2)])].join('\r\n') + '\r\n';

function fakeFetch(routes) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), redirect: options?.redirect, hasSignal: options?.signal instanceof AbortSignal });
    const route = routes[String(url)];
    if (route === undefined) return new Response('missing', { status: 404 });
    return typeof route === 'function' ? route() : new Response(route);
  };
  return { fetchImpl, requests };
}

// Manifest format: v0 header then name/md5/packed/unpacked quadruples, CRLF or LF.
assert.deepEqual(parseStudioPackageManifest(manifest({ 'ssl.zip': packages['ssl.zip'] })),
  [{ name: 'ssl.zip', md5: md5(packages['ssl.zip']), size: packages['ssl.zip'].length }]);
for (const invalid of [
  '', 'v1\nssl.zip\n' + md5('x') + '\n1\n1', 'v0\nssl.zip\n' + md5('x') + '\n1',
  'v0\n../evil.zip\n' + md5('x') + '\n1\n1', 'v0\nssl.exe\n' + md5('x') + '\n1\n1',
  'v0\nssl.zip\nnot-a-hash\n1\n1', 'v0\nssl.zip\n' + md5('x') + '\n0\n1', 'v0\nssl.zip\n' + md5('x') + '\n-1\n1',
  `v0\nssl.zip\n${md5('x')}\n1\n1\nssl.zip\n${md5('y')}\n1\n1`,
]) {
  assert.throws(() => parseStudioPackageManifest(invalid), /manifest/, JSON.stringify(invalid));
}

// Version lookup: validated GUID, no redirects, bounded deadline.
{
  const { fetchImpl, requests } = fakeFetch({ [STUDIO_VERSION_URL]: JSON.stringify({ version: '0.741.19.7411056', clientVersionUpload: version }) });
  assert.deepEqual(await resolveStudioTargetVersion({ fetchImpl }), { version, displayVersion: '0.741.19.7411056' });
  assert.deepEqual(requests, [{ url: STUDIO_VERSION_URL, redirect: 'error', hasSignal: true }]);
  for (const body of ['{"clientVersionUpload":"version-../../x"}', 'not json', '{}']) {
    await assert.rejects(resolveStudioTargetVersion({ fetchImpl: fakeFetch({ [STUDIO_VERSION_URL]: body }).fetchImpl }), /Studio version lookup/);
  }
  await assert.rejects(resolveStudioTargetVersion({ fetchImpl: fakeFetch({}).fetchImpl }), /HTTP 404/);
}

const root = mkdtempSync(path.join(tmpdir(), 'rsmcp-package-cache-'));
try {
  const localAppData = path.join(root, 'Local');
  const cache = studioPackageCacheDirectory(localAppData);
  const base = `${STUDIO_DEPLOYMENT_BASE}/${version}-`;
  const routes = {
    [`${base}rbxPkgManifest.txt`]: manifest(),
    ...Object.fromEntries(Object.entries(packages).map(([name, bytes]) => [`${base}${name}`, () => new Response(bytes)])),
  };

  // Existing verified entries are kept; a corrupt entry with the right name is replaced.
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, md5(packages['ssl.zip'])), packages['ssl.zip']);
  writeFileSync(path.join(cache, md5(packages['content-fonts.zip'])), Buffer.from('FONTS'));
  const first = fakeFetch(routes);
  const logs = [];
  assert.deepEqual(await prefetchStudioPackages({ localAppData, version, fetchImpl: first.fetchImpl, log: text => logs.push(text) }),
    { packages: 3, downloaded: 2 });
  assert.deepEqual(first.requests.map(request => request.url).sort(),
    [`${base}RobloxStudio.zip`, `${base}content-fonts.zip`, `${base}rbxPkgManifest.txt`].sort());
  assert.ok(first.requests.every(request => request.redirect === 'error' && request.hasSignal));
  for (const bytes of Object.values(packages)) assert.deepEqual(readFileSync(path.join(cache, md5(bytes))), bytes);
  assert.deepEqual(readdirSync(cache).sort(), Object.values(packages).map(md5).sort(), 'no temporary files remain');
  assert.match(logs[0], /Prefetching 2 of 3 Studio version-76e1a02649ad4f35 packages/);

  // A warm cache downloads nothing but the manifest.
  const second = fakeFetch(routes);
  assert.deepEqual(await prefetchStudioPackages({ localAppData, version, fetchImpl: second.fetchImpl }), { packages: 3, downloaded: 0 });
  assert.deepEqual(second.requests.map(request => request.url), [`${base}rbxPkgManifest.txt`]);

  // Tampered, truncated, oversized and failed downloads never land under the trusted name.
  for (const [label, response] of [
    ['tampered', () => new Response(Buffer.from('studio executable packagX'))],
    ['truncated', () => new Response(packages['RobloxStudio.zip'].subarray(1))],
    ['oversized', () => new Response(Buffer.concat([packages['RobloxStudio.zip'], Buffer.from('!')]))],
    ['http', () => new Response('no', { status: 503 })],
  ]) {
    rmSync(cache, { recursive: true, force: true });
    await assert.rejects(prefetchStudioPackages({
      localAppData, version, fetchImpl: fakeFetch({ ...routes, [`${base}RobloxStudio.zip`]: response }).fetchImpl, concurrency: 1,
    }), /Studio package RobloxStudio\.zip/, label);
    assert.equal(readdirSync(cache).includes(md5(packages['RobloxStudio.zip'])), false, label);
    assert.equal(readdirSync(cache).some(name => name.endsWith('.tmp')), false, `${label} leaves no temporary file`);
  }
  await assert.rejects(prefetchStudioPackages({ localAppData, version: 'version-../x', fetchImpl: fakeFetch(routes).fetchImpl }), /Invalid Studio version/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('Studio package prefetch offline regressions passed');

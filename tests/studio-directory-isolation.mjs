#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import {
  ISOLATED_STUDIO_PLUGINS_DIR_NAME,
  assertStudioDirectoryIsolation,
  assertStudioTestProfile,
  closeStudioProcess,
  configureStudioDirectoryIsolation,
  readStudioPluginDirectorySetting,
} from '../scripts/studio-lifecycle.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-directory-isolation-'));
const settingsPath = path.join(directory, 'GlobalSettings_13.xml');
const studioDocument = (properties) => `<roblox version="4"><Item class="Studio" referent="RBX0"><Properties>${properties}</Properties></Item></roblox>`;
const isolatedProperty = `<QDir name="PluginsDir">${ISOLATED_STUDIO_PLUGINS_DIR_NAME}</QDir>`;
const frozenFixtureModes = new Map();

try {
  const missingPath = path.join(directory, 'new-profile', 'Roblox', 'GlobalSettings_13.xml');
  assert.throws(() => assertStudioDirectoryIsolation({ settingsPath: missingPath }), /enroll|Enroll/);
  await assert.rejects(configureStudioDirectoryIsolation({ settingsPath: missingPath }), /enroll|Enroll/);
  assert.equal(existsSync(path.dirname(missingPath)), false, 'read-only and default configure do not create a profile directory');

  const runningStudio = [{ Id: 123, Path: 'RobloxStudioBeta.exe' }];
  const busyProbe = (options) => {
    assert.deepEqual(options, { strict: true, currentUserOnly: true });
    return runningStudio;
  };
  await assert.rejects(configureStudioDirectoryIsolation({
    settingsPath: missingPath,
    initializeIfMissing: true,
    processProbe: busyProbe,
  }), /running processes/);
  assert.equal(existsSync(path.dirname(missingPath)), false, 'active Studio blocks even parent creation');

  const initialized = await Promise.all(Array.from({ length: 4 }, () => configureStudioDirectoryIsolation({
    settingsPath: missingPath,
    initializeIfMissing: true,
    requireStudioClosed: false,
  })));
  assert.equal(initialized.filter((result) => result.created).length, 1, 'exactly one parallel enrollment creates settings');
  assert.equal(initialized.filter((result) => result.changed).length, 1);
  assert.equal(assertStudioDirectoryIsolation({ settingsPath: missingPath, requireReadOnly: false }).configured, true);
  const initialXml = readFileSync(missingPath, 'utf8');
  const createdTags = [];
  const createdParser = new SaxesParser({ xmlns: true });
  createdParser.on('opentag', (tag) => createdTags.push(tag));
  createdParser.write(initialXml).close();
  assert.deepEqual(createdTags.map((tag) => tag.name), ['roblox', 'Item', 'Properties', 'QDir'], 'fresh settings contain no copied personal properties');
  assert.equal(createdTags[0].attributes.version.value, '4');
  assert.equal(createdTags[0].attributes['xsi:noNamespaceSchemaLocation'].uri, 'http://www.w3.org/2001/XMLSchema-instance');
  assert.equal(createdTags[0].attributes['xsi:noNamespaceSchemaLocation'].value, 'http://www.roblox.com/roblox.xsd');
  assert.equal(createdTags[1].attributes.class.value, 'Studio');
  assert.equal(typeof createdTags[1].attributes.referent.value, 'string');
  assert.equal(createdTags[3].attributes.name.value, 'PluginsDir');
  const unchanged = await configureStudioDirectoryIsolation({
    settingsPath: missingPath,
    initializeIfMissing: true,
    processProbe: () => { throw new Error('Matching settings must not query or disturb active workers'); },
  });
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.changed, false);
  assert.equal(readFileSync(missingPath, 'utf8'), initialXml);

  const original = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<roblox version="4">',
    '  <Item class="Studio" referent="RBX1"><Properties>',
    '    <QDir name="PluginsDir">C:/Users/Test/AppData/Local/Roblox/Plugins</QDir>',
    '    <string name="Untouched">preserve &amp; keep &#x1F600;</string>',
    '    <!-- preserve unknown settings and formatting -->',
    '  </Properties></Item>',
    '  <Item class="Other" referent="RBX2"><Properties><QDir name="PluginsDir">untouched</QDir></Properties></Item>',
    '</roblox>',
    '',
  ].join('\r\n');
  writeFileSync(settingsPath, original);
  assert.throws(() => assertStudioDirectoryIsolation({ settingsPath }), /Routine startup never edits settings/);
  assert.equal(readFileSync(settingsPath, 'utf8'), original, 'assertion never provisions the profile');

  assert.deepEqual(readStudioPluginDirectorySetting(settingsPath), {
    settingsPath,
    value: 'C:/Users/Test/AppData/Local/Roblox/Plugins',
    configured: false,
    readOnly: false,
  });
  await assert.rejects(configureStudioDirectoryIsolation({ settingsPath, processProbe: busyProbe }), /running processes/);
  assert.equal(readFileSync(settingsPath, 'utf8'), original, 'active Studio blocks changes to existing settings');

  const first = await configureStudioDirectoryIsolation({
    settingsPath,
    requireStudioClosed: false,
  });
  assert.equal(first.changed, true);
  assert.equal(first.created, false);
  assert.equal(first.configured, true);
  assert.equal(first.value, ISOLATED_STUDIO_PLUGINS_DIR_NAME);

  const configuredXml = readFileSync(settingsPath, 'utf8');
  assert.equal(
    configuredXml,
    original.replace(
      'C:/Users/Test/AppData/Local/Roblox/Plugins',
      ISOLATED_STUDIO_PLUGINS_DIR_NAME,
    ),
    'configuration changes only the PluginsDir value',
  );

  const second = await configureStudioDirectoryIsolation({
    settingsPath,
    requireStudioClosed: false,
  });
  assert.equal(second.changed, false);
  assert.equal(readFileSync(settingsPath, 'utf8'), configuredXml);
  assert.deepEqual(assertStudioDirectoryIsolation({ settingsPath, requireReadOnly: false }), {
    settingsPath,
    value: ISOLATED_STUDIO_PLUGINS_DIR_NAME,
    configured: true,
    readOnly: false,
  });
  assert.equal(readFileSync(settingsPath, 'utf8'), configuredXml);

  writeFileSync(settingsPath, original);
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => configureStudioDirectoryIsolation({
      settingsPath,
      requireStudioClosed: false,
    })),
  );
  assert.equal(
    concurrent.filter((result) => result.changed).length,
    1,
    'concurrent configurators serialize so exactly one rewrites GlobalSettings',
  );
  assert.equal(readFileSync(settingsPath, 'utf8'), configuredXml);

  await assert.rejects(
    configureStudioDirectoryIsolation({
      settingsPath,
      relativePluginsDirectory: '../shared-plugins',
      requireStudioClosed: false,
    }),
    /one relative directory name/,
  );

  await assert.rejects(
    closeStudioProcess({ processId: 1 }),
    /FILETIME/,
    'exact close refuses a PID without process creation identity',
  );

  const untouched = '<string name="Untouched">keep &amp; preserve</string>';
  const withoutPlugin = studioDocument(untouched);
  writeFileSync(settingsPath, withoutPlugin);
  assert.equal(readStudioPluginDirectorySetting(settingsPath).value, null);
  assert.throws(() => assertStudioDirectoryIsolation({ settingsPath }));
  assert.equal(readFileSync(settingsPath, 'utf8'), withoutPlugin, 'assertion never inserts a missing property');
  const inserted = await configureStudioDirectoryIsolation({ settingsPath, requireStudioClosed: false });
  assert.equal(inserted.created, false);
  assert.equal(inserted.changed, true);
  assert.equal(readFileSync(settingsPath, 'utf8'), studioDocument(`${untouched}${isolatedProperty}`));

  const emptyProperties = '<roblox version="4"><Item class="Studio" referent="RBX0"><Properties /></Item></roblox>';
  writeFileSync(settingsPath, emptyProperties);
  await configureStudioDirectoryIsolation({ settingsPath, requireStudioClosed: false });
  assert.equal(readStudioPluginDirectorySetting(settingsPath).value, ISOLATED_STUDIO_PLUGINS_DIR_NAME);
  writeFileSync(settingsPath, studioDocument('<QDir name="PluginsDir" />'));
  await configureStudioDirectoryIsolation({ settingsPath, requireStudioClosed: false });
  assert.equal(readStudioPluginDirectorySetting(settingsPath).value, ISOLATED_STUDIO_PLUGINS_DIR_NAME);

  const encodedValue = studioDocument('<QDir name=\'PluginsDir\'><![CDATA[RsmcpIsolated]]>Plugins</QDir>');
  writeFileSync(settingsPath, encodedValue);
  assert.equal((await configureStudioDirectoryIsolation({ settingsPath, processProbe: busyProbe })).changed, false);
  assert.equal(readFileSync(settingsPath, 'utf8'), encodedValue, 'already matching XML is not normalized or rewritten');

  const invalidDocuments = [
    studioDocument('<QDir name="PluginsDir">one</QDir><QDir name="PluginsDir">two</QDir>'),
    '<roblox version="4"><Item class="Studio"><Properties /></Item><Item class="Studio"><Properties /></Item></roblox>',
    '<roblox version="4"><Item class="Studio"><Properties /><Properties /></Item></roblox>',
    '<roblox version="4"><Item class="Studio" /></roblox>',
    '<roblox version="4"><Item class="Other"><Properties /></Item></roblox>',
    studioDocument('<string name="PluginsDir">not a directory property</string>'),
    studioDocument('<QDir name="PluginsDir"><string>nested</string></QDir>'),
    studioDocument('<QDir name="PluginsDir">&unknown;</QDir>'),
    studioDocument('<QDir name="PluginsDir">broken</Properties>'),
    `<Settings>${isolatedProperty}</Settings>`,
    `<!DOCTYPE roblox [<!ENTITY dir "unsafe">]>${studioDocument(isolatedProperty)}`,
  ];
  for (const invalidXml of invalidDocuments) {
    writeFileSync(settingsPath, invalidXml);
    assert.throws(() => readStudioPluginDirectorySetting(settingsPath));
    assert.throws(() => assertStudioDirectoryIsolation({ settingsPath }));
    await assert.rejects(configureStudioDirectoryIsolation({
      settingsPath,
      initializeIfMissing: true,
      requireStudioClosed: false,
    }));
    assert.equal(readFileSync(settingsPath, 'utf8'), invalidXml, 'invalid or ambiguous settings must never be overwritten');
  }

  const frozenMissingPath = path.join(directory, 'frozen-profile', 'GlobalSettings_13.xml');
  frozenFixtureModes.set(frozenMissingPath, 0o600);
  await assert.rejects(configureStudioDirectoryIsolation({
    settingsPath: frozenMissingPath,
    initializeIfMissing: true,
    freezeSettings: true,
    processProbe: busyProbe,
  }), /running processes/);
  assert.equal(existsSync(path.dirname(frozenMissingPath)), false);
  const frozenCreated = await configureStudioDirectoryIsolation({
    settingsPath: frozenMissingPath,
    initializeIfMissing: true,
    freezeSettings: true,
    processProbe: () => [],
  });
  assert.equal(frozenCreated.created, true);
  assert.equal(frozenCreated.changed, true);
  assert.equal(frozenCreated.readOnly, true);
  assert.equal(assertStudioDirectoryIsolation({ settingsPath: frozenMissingPath }).readOnly, true);

  const frozenPath = path.join(directory, 'frozen-existing.xml');
  writeFileSync(frozenPath, encodedValue, { mode: 0o640 });
  const writableMode = statSync(frozenPath).mode & 0o7777;
  frozenFixtureModes.set(frozenPath, writableMode);
  assert.equal(assertStudioDirectoryIsolation({ settingsPath: frozenPath, requireReadOnly: false }).readOnly, false);
  assert.throws(() => assertStudioDirectoryIsolation({ settingsPath: frozenPath }), /read-only.*setup/);
  assert.equal(statSync(frozenPath).mode & 0o7777, writableMode, 'validation never changes permissions');
  await assert.rejects(configureStudioDirectoryIsolation({
    settingsPath: frozenPath,
    freezeSettings: true,
    processProbe: busyProbe,
  }), /running processes/);
  assert.equal(statSync(frozenPath).mode & 0o7777, writableMode, 'active Studio blocks freezing even matching settings');
  assert.equal(readFileSync(frozenPath, 'utf8'), encodedValue);
  const frozenExisting = await configureStudioDirectoryIsolation({
    settingsPath: frozenPath,
    freezeSettings: true,
    processProbe: () => [],
  });
  assert.equal(frozenExisting.created, false);
  assert.equal(frozenExisting.changed, true, 'freezing matching settings is a permission change');
  assert.equal(frozenExisting.readOnly, true);
  assert.equal(statSync(frozenPath).mode & 0o7777, writableMode & ~0o222);
  assert.equal(readFileSync(frozenPath, 'utf8'), encodedValue, 'freezing matching settings preserves XML verbatim');
  const beforeIdempotence = statSync(frozenPath);
  const frozenUnchanged = await configureStudioDirectoryIsolation({
    settingsPath: frozenPath,
    freezeSettings: true,
    processProbe: () => { throw new Error('Frozen matching settings must not disturb active workers'); },
  });
  assert.equal(frozenUnchanged.changed, false);
  assert.equal(frozenUnchanged.readOnly, true);
  const afterIdempotence = statSync(frozenPath);
  for (const field of ['ino', 'mode', 'mtimeMs', 'ctimeMs']) {
    assert.equal(afterIdempotence[field], beforeIdempotence[field], `idempotent enrollment preserves ${field}`);
  }

  const frozenRewritePath = path.join(directory, 'frozen-rewrite.xml');
  writeFileSync(frozenRewritePath, original, { mode: 0o640 });
  const rewriteMode = statSync(frozenRewritePath).mode & 0o7777;
  frozenFixtureModes.set(frozenRewritePath, rewriteMode);
  const frozenRewrite = await configureStudioDirectoryIsolation({
    settingsPath: frozenRewritePath,
    freezeSettings: true,
    processProbe: () => [],
  });
  assert.equal(frozenRewrite.readOnly, true);
  assert.equal(readFileSync(frozenRewritePath, 'utf8'), configuredXml, 'freezing and rewriting preserves other XML');
  assert.equal(statSync(frozenRewritePath).mode & 0o7777, rewriteMode & ~0o222);
  await assert.rejects(configureStudioDirectoryIsolation({
    settingsPath: frozenRewritePath,
    relativePluginsDirectory: 'OtherIsolatedPlugins',
    processProbe: busyProbe,
  }), /running processes/);
  assert.equal(statSync(frozenRewritePath).mode & 0o7777, rewriteMode & ~0o222, 'active Studio blocks thawing for replacement');
  assert.equal(readFileSync(frozenRewritePath, 'utf8'), configuredXml);
  const reconfiguredFrozen = await configureStudioDirectoryIsolation({
    settingsPath: frozenRewritePath,
    relativePluginsDirectory: 'OtherIsolatedPlugins',
    processProbe: () => [],
  });
  assert.equal(reconfiguredFrozen.changed, true);
  assert.equal(reconfiguredFrozen.readOnly, true, 'explicit generic reconfiguration preserves existing protection');
  assert.equal(readFileSync(frozenRewritePath, 'utf8'), configuredXml.replace(ISOLATED_STUDIO_PLUGINS_DIR_NAME, 'OtherIsolatedPlugins'));
  assert.equal(statSync(frozenRewritePath).mode & 0o7777, rewriteMode & ~0o222);
  assert.throws(() => assertStudioDirectoryIsolation({ settingsPath: frozenRewritePath }), /PluginsDir/);
  await configureStudioDirectoryIsolation({
    settingsPath: frozenRewritePath,
    freezeSettings: true,
    processProbe: () => [],
  });
  assert.equal(assertStudioDirectoryIsolation({ settingsPath: frozenRewritePath }).readOnly, true);
  assert.equal(readFileSync(frozenRewritePath, 'utf8'), configuredXml);

  if (process.platform === 'win32') {
    for (const frozenSettingsPath of frozenFixtureModes.keys()) {
      const protectedXml = readFileSync(frozenSettingsPath, 'utf8');
      assert.throws(
        () => writeFileSync(frozenSettingsPath, 'Studio settings overwrite'),
        (error) => ['EPERM', 'EACCES'].includes(error.code),
        'native Windows must reject overwriting frozen settings',
      );
      assert.equal(readFileSync(frozenSettingsPath, 'utf8'), protectedXml);
    }
  }

  const identity = {
    sid: 'S-1-5-21-100-200-300-1002',
    accountName: 'MACHINE\\StudioTests',
    profileDirectory: 'C:\\Users\\StudioTests',
    localAppData: 'C:\\Users\\StudioTests\\AppData\\Local',
    environmentProfileDirectory: 'C:\\Users\\StudioTests',
    environmentLocalAppData: 'C:\\Users\\StudioTests\\AppData\\Local',
    profileLoaded: true,
    interactiveSession: true,
  };
  const enrollment = {
    version: 1,
    dedicatedTestProfile: true,
    sid: identity.sid,
    sourceSid: 'S-1-5-21-100-200-300-1001',
    profileDirectory: identity.profileDirectory,
    localAppData: identity.localAppData,
  };
  const probe = (changedIdentity = {}, changedEnrollment = {}) => ({
    identityProbe: () => ({ ...identity, ...changedIdentity }),
    readEnrollment: () => ({ ...enrollment, ...changedEnrollment }),
  });
  assert.deepEqual(assertStudioTestProfile(probe()), identity);
  assert.throws(() => assertStudioTestProfile(probe({}, { dedicatedTestProfile: false })), /enrollment does not match/);
  assert.throws(() => assertStudioTestProfile(probe({}, { sourceSid: identity.sid })), /personal\/source identity/);
  assert.throws(() => assertStudioTestProfile(probe({}, { sid: enrollment.sourceSid })), /enrollment does not match/);
  assert.throws(() => assertStudioTestProfile(probe({}, { profileDirectory: 'C:\\Users\\Personal' })), /enrollment does not match/);
  assert.throws(() => assertStudioTestProfile(probe({ environmentLocalAppData: 'C:\\Users\\Personal\\AppData\\Local' })), /environment-only profile redirection/);
  assert.throws(() => assertStudioTestProfile(probe({ localAppData: 'C:\\Users\\Personal\\AppData\\Local' })), /paths disagree/);
  assert.throws(() => assertStudioTestProfile(probe({ profileLoaded: false })), /loaded Windows user profile/);
  assert.throws(() => assertStudioTestProfile(probe({ interactiveSession: false })), /interactive desktop session/);
  assert.throws(() => assertStudioTestProfile(probe({ sid: 'S-1-5-18' })), /service identity/);
  assert.throws(() => assertStudioTestProfile({
    identityProbe: () => identity,
    readEnrollment: () => undefined,
  }), /enrollment does not match/);
} finally {
  for (const [frozenSettingsPath, mode] of frozenFixtureModes) {
    if (existsSync(frozenSettingsPath)) chmodSync(frozenSettingsPath, mode);
  }
  rmSync(directory, { recursive: true, force: true });
}

console.log('Studio directory isolation tests passed');

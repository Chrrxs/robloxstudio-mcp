#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ISOLATED_STUDIO_PLUGINS_DIR_NAME,
  closeStudioProcess,
  configureStudioDirectoryIsolation,
  readStudioPluginDirectorySetting,
} from '../scripts/studio-lifecycle.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-directory-isolation-'));
const settingsPath = path.join(directory, 'GlobalSettings_13.xml');

try {
  const original = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Settings>',
    '  <Content name="Studio">',
    '    <QDir name="PluginsDir">C:/Users/Test/AppData/Local/Roblox/Plugins</QDir>',
    '    <string name="Untouched">preserve me</string>',
    '  </Content>',
    '</Settings>',
    '',
  ].join('\r\n');
  writeFileSync(settingsPath, original);

  assert.deepEqual(readStudioPluginDirectorySetting(settingsPath), {
    settingsPath,
    value: 'C:/Users/Test/AppData/Local/Roblox/Plugins',
    configured: false,
  });

  const first = await configureStudioDirectoryIsolation({
    settingsPath,
    requireStudioClosed: false,
  });
  assert.equal(first.changed, true);
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

  writeFileSync(
    settingsPath,
    '<Settings><QDir name="PluginsDir">one</QDir><QDir name="PluginsDir">two</QDir></Settings>',
  );
  assert.throws(
    () => readStudioPluginDirectorySetting(settingsPath),
    /found 2/,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('Studio directory isolation tests passed');

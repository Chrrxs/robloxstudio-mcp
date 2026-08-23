#!/usr/bin/env node

import assert from 'node:assert/strict';
import { selectEditInstance } from './lib/mcp-client.mjs';

const connected = {
  instances: [
    { id: 'anon:pre-existing', roles: ['edit', 'server'] },
    { id: 'anon:runner-owned', roles: ['edit'] },
  ],
};

assert.equal(
  selectEditInstance(connected, 'anon:runner-owned')?.id,
  'anon:runner-owned',
  'the runner-selected instance wins even when another edit instance is listed first',
);
assert.equal(
  selectEditInstance(connected, 'anon:missing'),
  undefined,
  'an unavailable requested instance never falls back to a different edit instance',
);
assert.equal(
  selectEditInstance(connected, undefined)?.id,
  'anon:pre-existing',
  'single-test use without an explicit target retains first-edit behavior',
);
assert.equal(
  selectEditInstance([{ instanceId: 'anon:legacy-shape', role: 'edit' }], 'anon:legacy-shape')?.instanceId,
  'anon:legacy-shape',
  'the selector accepts both connected-instance response shapes',
);

console.log('instance routing passed');

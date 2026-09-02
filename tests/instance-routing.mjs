#!/usr/bin/env node

import assert from 'node:assert/strict';
import { routingPeers, selectEditInstance } from './lib/mcp-client.mjs';

const connected = {
  instances: [
    {
      id: 'instance:aaa-111',
      peers: [{ peerId: 'peer:aaa-111', instanceId: 'instance:aaa-111', role: 'edit' }],
    },
    {
      id: 'instance:bbb-222',
      multiplayerGroupId: 'test:runner',
      peers: { edit: 'peer:bbb-222' },
    },
  ],
  multiplayerGroups: [{
    id: 'test:runner',
    controllerInstanceId: 'instance:bbb-222',
    instances: {
      'instance:ccc-333-server': 'peer:ccc-333',
    },
  }],
};

assert.equal(
  selectEditInstance(connected, 'instance:bbb-222')?.id,
  'instance:bbb-222',
  'the runner-selected instance wins even when another edit instance is listed first',
);
assert.equal(
  selectEditInstance(connected, 'instance:missing'),
  undefined,
  'an unavailable requested instance never falls back to a different edit instance',
);
assert.equal(
  selectEditInstance(connected, undefined)?.id,
  'instance:aaa-111',
  'single-test use without an explicit target retains first-edit behavior',
);
assert.deepEqual(
  routingPeers(connected, 'instance:bbb-222').map((peer) => peer.role),
  ['edit', 'server'],
  'routing from a group member includes peers from every Instance in its explicit MultiplayerGroup',
);
assert.deepEqual(
  routingPeers(connected, 'instance:ccc-333-server').map((peer) => peer.role),
  ['edit', 'server'],
  'a role-suffixed runtime Instance ID resolves back to its whole MultiplayerGroup',
);
assert.deepEqual(
  routingPeers(connected, 'instance:ccc-333').map((peer) => peer.role),
  ['edit', 'server'],
  'a canonical runtime Instance ID remains a compatible MultiplayerGroup selector',
);

console.log('instance routing passed');

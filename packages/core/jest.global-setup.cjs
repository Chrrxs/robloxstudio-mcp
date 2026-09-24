const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

module.exports = () => {
  process.env.RSMCP_JEST_REGISTRY_ROOT = mkdtempSync(join(tmpdir(), 'rsmcp-jest-'));
};

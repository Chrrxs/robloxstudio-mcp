const { rmSync } = require('node:fs');

module.exports = () => {
  rmSync(process.env.RSMCP_JEST_REGISTRY_ROOT, { recursive: true, force: true });
  delete process.env.RSMCP_JEST_REGISTRY_ROOT;
};

import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools as Tools } from '../tools/index.js';

const activeTools = new Set<Tools>();

export class RobloxStudioTools extends Tools {
  constructor(bridge: BridgeService) {
    super(bridge);
    activeTools.add(this);
  }
}

afterEach(async () => {
  // Registry lock retries must finish before Jest restores the environment.
  jest.useRealTimers();
  await Promise.all([...activeTools].map(tools => tools.dispose()));
  activeTools.clear();
});

import type { BridgeService } from '../bridge-service.js';

export class StudioHttpClient {
  private readonly bridge: BridgeService;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
  }

  async request(
    endpoint: string,
    data: unknown,
    targetPeerId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<unknown> {
    return this.bridge.sendRequest(endpoint, data, targetPeerId, timeoutMs, signal, operationId);
  }
}

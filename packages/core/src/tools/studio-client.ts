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
  ): Promise<unknown> {
    try {
      return await this.bridge.sendRequest(
        endpoint,
        data,
        targetPeerId,
        timeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'Request timeout') {
        throw new Error(
          'Studio plugin connection timeout. Make sure the Roblox Studio plugin is running and activated.'
        );
      }
      throw error;
    }
  }
}

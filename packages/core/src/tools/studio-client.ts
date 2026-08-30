import { BridgeService } from '../bridge-service.js';

export class StudioHttpClient {
  private bridge: BridgeService;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
  }

  async request(
    endpoint: string,
    data: unknown,
    targetInstanceId: string,
    targetRole: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<any> {
    try {
      const response = await this.bridge.sendRequest(
        endpoint,
        data,
        targetInstanceId,
        targetRole,
        timeoutMs,
        signal,
      );
      return response;
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

import type { BridgeService, RequestStatus } from '../bridge-service.js';

export class StudioHttpClient {
  private readonly bridge: BridgeService;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
  }

  async request(...args: Parameters<BridgeService['sendRequest']>): Promise<unknown> {
    return this.bridge.sendRequest(...args);
  }

  /** Starts an operation that outlives the caller; see BridgeService.submitRequest. */
  async submit(...args: Parameters<BridgeService['submitRequest']>): Promise<RequestStatus> {
    return this.bridge.submitRequest(...args);
  }
}

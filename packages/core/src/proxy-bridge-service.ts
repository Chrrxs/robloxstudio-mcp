import { BridgeService, toPublicPeer } from './bridge-service.js';
import type {
  MultiplayerGroup,
  PublicStudioPeer,
  StudioInstance,
  StudioPeer,
  TopologySnapshot,
} from './bridge-service.js';
import { randomUUID } from 'crypto';

const PROXY_RESPONSE_GRACE_MS = 5_000;
function peerPublicationChanged(previous: StudioPeer | undefined, current: StudioPeer): boolean {
  return previous === undefined
    || previous.transportPeerId !== current.transportPeerId
    || previous.instanceId !== current.instanceId
    || previous.multiplayerGroupId !== current.multiplayerGroupId
    || previous.role !== current.role
    || previous.placeId !== current.placeId
    || previous.placeName !== current.placeName
    || previous.placeKey !== current.placeKey
    || previous.dataModelName !== current.dataModelName
    || previous.isRunning !== current.isRunning
    || previous.pluginVersion !== current.pluginVersion
    || previous.pluginVariant !== current.pluginVariant
    || previous.serverVersion !== current.serverVersion;
}


export class ProxyBridgeService extends BridgeService {
  private primaryBaseUrl: string;
  private authToken?: string;
  readonly proxyInstanceId: string;
  private proxyRequestTimeout = 30000;
  private cachedPeers: StudioPeer[] = [];
  private cachedInstances: StudioInstance[] = [];
  private cachedMultiplayerGroups: MultiplayerGroup[] = [];
  private readonly initialRefresh: Promise<void>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private static REFRESH_INTERVAL_MS = 1000;

  constructor(primaryBaseUrl: string, authToken?: string) {
    super();
    this.primaryBaseUrl = primaryBaseUrl;
    this.authToken = authToken;
    this.proxyInstanceId = randomUUID();
    // Mirror the primary's explicit topology so proxy-mode routing observes
    // every Studio process and Peer without deriving identity from place metadata.
    this.initialRefresh = this.refreshTopology();
    this.refreshTimer = setInterval(
      () => this.refreshTopology(),
      ProxyBridgeService.REFRESH_INTERVAL_MS,
    );
  }

  waitForInitialRefresh(): Promise<void> {
    return this.initialRefresh;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.authToken) headers['X-MCP-Auth'] = this.authToken;
    return headers;
  }

  private async refreshTopology(): Promise<void> {
    try {
      const res = await fetch(`${this.primaryBaseUrl}/topology`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) return;
      const body = (await res.json()) as Partial<TopologySnapshot>;
      if (
        !Array.isArray(body.peers)
        || !Array.isArray(body.instances)
        || !Array.isArray(body.multiplayerGroups)
      ) {
        return;
      }

      const previousPeers = new Map(this.cachedPeers.map((peer) => [peer.peerId, peer]));
      this.cachedPeers = body.peers;
      this.cachedInstances = body.instances;
      this.cachedMultiplayerGroups = body.multiplayerGroups;
      for (const peer of body.peers) {
        if (peerPublicationChanged(previousPeers.get(peer.peerId), peer)) {
          this.notifyPeerRegistered(toPublicPeer(peer));
        }
      }
    } catch {
      // Primary unreachable — keep the last-known topology rather than
      // silently reporting empty.
    }
  }

  override getPeers(): StudioPeer[] {
    return this.cachedPeers;
  }

  override getInstances(): StudioInstance[] {
    return this.cachedInstances;
  }

  override getMultiplayerGroups(): MultiplayerGroup[] {
    return this.cachedMultiplayerGroups;
  }

  override getTopologySnapshot(): TopologySnapshot {
    return {
      peers: this.cachedPeers,
      instances: this.cachedInstances,
      multiplayerGroups: this.cachedMultiplayerGroups,
    };
  }
  override async createMultiplayerGroupEverywhere(
    groupId: string,
    controllerInstanceId: string,
  ): Promise<MultiplayerGroup> {
    const response = await fetch(`${this.primaryBaseUrl}/create-multiplayer-group`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ groupId, controllerInstanceId }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Proxy Multiplayer Group creation failed (${response.status}): ${body || response.statusText}`);
    }
    const result = await response.json() as { group?: MultiplayerGroup };
    if (!result.group || result.group.id !== groupId) {
      throw new Error('Proxy Multiplayer Group creation returned an invalid Group.');
    }
    const group = {
      ...result.group,
      instanceIds: [...result.group.instanceIds],
    };
    this.cachedPeers = this.cachedPeers.map((peer) =>
      peer.instanceId === controllerInstanceId
        ? { ...peer, multiplayerGroupId: group.id }
        : peer);
    this.cachedInstances = this.cachedInstances.map((instance) =>
      instance.id === controllerInstanceId
        ? {
            ...instance,
            multiplayerGroupId: group.id,
            peers: instance.peers.map((peer) => ({ ...peer, multiplayerGroupId: group.id })),
          }
        : instance);
    this.cachedMultiplayerGroups = [
      ...this.cachedMultiplayerGroups.filter((candidate) => candidate.id !== group.id),
      group,
    ];
    return group;
  }

  override async removeMultiplayerGroupEverywhere(
    groupId: string,
  ): Promise<MultiplayerGroup | undefined> {
    const response = await fetch(`${this.primaryBaseUrl}/remove-multiplayer-group`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ groupId }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Proxy Multiplayer Group removal failed (${response.status}): ${body || response.statusText}`);
    }
    const result = await response.json() as { removed?: MultiplayerGroup };
    const removed = result.removed;
    if (removed !== undefined && removed.id !== groupId) {
      throw new Error('Proxy Multiplayer Group removal returned an invalid Group.');
    }
    this.cachedPeers = this.cachedPeers.map((peer) =>
      peer.multiplayerGroupId === groupId
        ? { ...peer, multiplayerGroupId: undefined }
        : peer);
    this.cachedInstances = this.cachedInstances.map((instance) =>
      instance.multiplayerGroupId === groupId
        ? {
            ...instance,
            multiplayerGroupId: undefined,
            peers: instance.peers.map((peer) => ({ ...peer, multiplayerGroupId: undefined })),
          }
        : instance);
    this.cachedMultiplayerGroups = this.cachedMultiplayerGroups.filter(
      (candidate) => candidate.id !== groupId,
    );
    return removed === undefined
      ? undefined
      : { ...removed, instanceIds: [...removed.instanceIds] };
  }


  override async unregisterInstanceIdEverywhere(instanceId: string): Promise<PublicStudioPeer[]> {
    const response = await fetch(`${this.primaryBaseUrl}/unregister-instance-id`, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ instanceId }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Proxy unregister failed (${response.status}): ${body || response.statusText}`);
    }

    const result = await response.json() as { removed?: PublicStudioPeer[] };
    const removed = Array.isArray(result.removed) ? result.removed : [];
    const removedPeerIds = new Set(removed.map((peer) => peer.peerId));
    const removedInstanceIds = new Set([
      instanceId,
      ...removed.map((peer) => peer.instanceId),
    ]);
    this.cachedPeers = this.cachedPeers.filter((peer) => !removedPeerIds.has(peer.peerId));
    this.cachedInstances = this.cachedInstances.filter(
      (instance) => !removedInstanceIds.has(instance.id),
    );
    this.cachedMultiplayerGroups = this.cachedMultiplayerGroups
      .map((group) => ({
        ...group,
        instanceIds: group.instanceIds.filter((id) => !removedInstanceIds.has(id)),
      }))
      .filter((group) => group.instanceIds.length > 0);
    return removed;
  }

  /** Called when this proxy is being discarded (e.g. promotion to primary
      replaced it). Stops the background refresh so it doesn't leak. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  override async sendRequest(
    endpoint: string,
    data: unknown,
    targetPeerId: string,
    timeoutMs = this.proxyRequestTimeout,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('Request aborted');
    const controller = new AbortController();
    const effectiveTimeoutMs = Math.max(1, timeoutMs);
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();
    // The primary starts its request timer after this fetch begins. Leave room
    // for its terminal response to travel back before aborting the proxy hop.
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs + PROXY_RESPONSE_GRACE_MS);

    try {
      const response = await fetch(`${this.primaryBaseUrl}/proxy`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          endpoint,
          data,
          targetPeerId,
          proxyInstanceId: this.proxyInstanceId,
          timeoutMs: effectiveTimeoutMs,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Proxy request failed (${response.status}): ${body}`);
      }

      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Proxy returned an invalid response');
      }
      if ('error' in result && typeof result.error === 'string' && result.error.length > 0) {
        throw new Error(result.error);
      }
      return 'response' in result ? result.response : undefined;
    } catch (error) {
      const isAbortError = error instanceof Error
        ? error.name === 'AbortError'
        : !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
      if (isAbortError) {
        if (!timedOut && signal?.aborted) throw new Error('Request aborted');
        throw new Error('Proxy request timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  override cleanupOldRequests(): void {
    // No-op: primary bridge owns the pending request state
  }

  override clearAllPendingRequests(): void {
    // No-op: primary bridge owns the pending request state
  }
}

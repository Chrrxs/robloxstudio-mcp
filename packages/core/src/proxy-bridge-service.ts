import { BridgeService, isRequestStage, isValidOperationId, MultiplayerGroupInUseError, parseFailureDetails, parseObservations, PRIMARY_PROXY_FEATURES, RequestFailure, requiresAtomicProperties, requiresScriptPreconditions, toPublicPeer } from './bridge-service.js';
import type {
  MultiplayerGroup,
  PublicStudioPeer,
  RequestFailureDetails,
  PrimaryProxyFeature,
  RequestStatus,
  StudioInstance,
  StudioPeer,
  TopologySnapshot,
} from './bridge-service.js';
import { randomUUID } from 'crypto';
import { HTTP_BODY_LIMIT_BYTES } from './http-body-limits.js';

const PROXY_RESPONSE_GRACE_MS = 5_000;


function parseRequestStatus(value: unknown): RequestStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Proxy returned an invalid request status');
  if (
    !('requestId' in value) || typeof value.requestId !== 'string'
    || !('targetPeerId' in value) || typeof value.targetPeerId !== 'string'
    || !('queuedAt' in value) || typeof value.queuedAt !== 'number'
    || !('stage' in value) || !isRequestStage(value.stage)
    || !('state' in value) || (value.state !== 'pending' && value.state !== 'timed_out' && value.state !== 'aborted' && value.state !== 'disconnected' && value.state !== 'settled')
    || !('outcome' in value) || (value.outcome !== 'pending' && value.outcome !== 'not_executed' && value.outcome !== 'unknown' && value.outcome !== 'success' && value.outcome !== 'error')
  ) throw new Error('Proxy returned an invalid request status');
  const status: RequestStatus = {
    requestId: value.requestId, targetPeerId: value.targetPeerId, queuedAt: value.queuedAt,
    stage: value.stage, state: value.state, outcome: value.outcome,
    ...parseObservations(value),
  };
  if ('dispatchedAt' in value && typeof value.dispatchedAt === 'number') status.dispatchedAt = value.dispatchedAt;
  if ('settledAt' in value && typeof value.settledAt === 'number') status.settledAt = value.settledAt;
  if ('waiterEndedAt' in value && typeof value.waiterEndedAt === 'number') status.waiterEndedAt = value.waiterEndedAt;
  if ('response' in value) status.response = value.response;
  if ('error' in value) status.error = value.error;
  if ('resultUnavailable' in value) {
    const unavailable = value.resultUnavailable;
    if (!unavailable || typeof unavailable !== 'object'
      || !('reason' in unavailable) || (unavailable.reason !== 'size_limit' && unavailable.reason !== 'serialization_failed' && unavailable.reason !== 'retention_capacity')
      || !('limitBytes' in unavailable) || typeof unavailable.limitBytes !== 'number'
    ) throw new Error('Proxy returned invalid result availability');
    status.resultUnavailable = {
      reason: unavailable.reason, limitBytes: unavailable.limitBytes,
      ...('bytes' in unavailable && typeof unavailable.bytes === 'number' ? { bytes: unavailable.bytes } : {}),
    };
  }
  return status;
}
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

function parsePrimaryFeatures(value: unknown): Set<PrimaryProxyFeature> {
  const features = new Set<PrimaryProxyFeature>();
  if (!Array.isArray(value)) return features;
  for (const feature of PRIMARY_PROXY_FEATURES) {
    if (value.includes(feature)) features.add(feature);
  }
  return features;
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
  private refreshTimer?: NodeJS.Timeout;
  private static REFRESH_INTERVAL_MS = 1000;
  private static TOPOLOGY_TIMEOUT_MS = 2_000;
  private topologyGeneration = 0;
  private appliedTopologyGeneration = 0;
  // Features of the primary's proxy protocol, from its latest topology. A
  // primary that predates them advertises none and ignores their fields.
  private primaryFeatures = new Set<PrimaryProxyFeature>();
  private primaryVersion?: string;

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

  override refreshTopologyForRouting(signal?: AbortSignal): Promise<void> {
    return this.refreshTopology(signal, true);
  }

  private async refreshTopology(signal?: AbortSignal, requireFresh = false): Promise<void> {
    const generation = ++this.topologyGeneration;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(
      () => controller.abort(new Error('Studio topology refresh timed out')),
      ProxyBridgeService.TOPOLOGY_TIMEOUT_MS,
    );
    try {
      controller.signal.throwIfAborted();
      const res = await fetch(`${this.primaryBaseUrl}/topology`, {
        headers: this.authHeaders(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Studio topology returned HTTP ${res.status}`);
      const body = (await res.json()) as Partial<TopologySnapshot>;
      controller.signal.throwIfAborted();
      if (
        !body ||
        !Array.isArray(body.peers)
        || !Array.isArray(body.instances)
        || !Array.isArray(body.multiplayerGroups)
      ) {
        throw new Error('Primary returned invalid Studio topology');
      }
      // A slow older poll must not resurrect peers removed by a newer snapshot.
      if (generation < this.appliedTopologyGeneration) return;
      this.appliedTopologyGeneration = generation;

      const previousPeers = new Map(this.cachedPeers.map((peer) => [peer.peerId, peer]));
      this.cachedPeers = body.peers;
      this.cachedInstances = body.instances;
      this.cachedMultiplayerGroups = body.multiplayerGroups;
      this.primaryFeatures = parsePrimaryFeatures('proxyFeatures' in body ? body.proxyFeatures : undefined);
      this.primaryVersion = 'serverVersion' in body && typeof body.serverVersion === 'string' ? body.serverVersion : undefined;
      for (const peer of body.peers) {
        if (peerPublicationChanged(previousPeers.get(peer.peerId), peer)) {
          this.notifyPeerRegistered(toPublicPeer(peer));
        }
      }
    } catch (error) {
      if (requireFresh) throw error;
      // Background polling can retain its last-known view when the primary is unreachable.
      // Discovery and routing refreshes fail explicitly, without queuing stale work.
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
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
      signal: AbortSignal.timeout(5_000),
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
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ groupId }),
    });
    if (response.status === 409) {
      const refusal: unknown = await response.json().catch(() => undefined);
      if (
        refusal && typeof refusal === 'object' && !Array.isArray(refusal)
        && 'success' in refusal && refusal.success === false
        && 'error' in refusal && refusal.error === 'multiplayer_group_in_use'
        && 'groupId' in refusal && refusal.groupId === groupId
      ) {
        throw new MultiplayerGroupInUseError(groupId);
      }
      throw new Error('Proxy Multiplayer Group removal returned an invalid refusal.');
    }
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
      signal: AbortSignal.timeout(5_000),
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
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  // Names the primary in errors for proxy features it predates.
  private primaryDescription(): string {
    return `The primary MCP server at ${this.primaryBaseUrl}${this.primaryVersion ? ` (v${this.primaryVersion})` : ''}`;
  }

  override async getRequestStatusEverywhere(requestId: string, waitMs = 0, signal?: AbortSignal): Promise<RequestStatus | undefined> {
    const query = new URLSearchParams({ requestId });
    if (waitMs > 0) {
      await this.initialRefresh;
      if (!this.primaryFeatures.has('status_wait')) {
        throw new Error(`${this.primaryDescription()} cannot wait for an operation; call get_request_status without wait_ms, or restart that server on this version.`);
      }
      query.set('waitMs', String(waitMs));
    }
    // The primary owns the wait; leave room for its answer to travel back.
    const timeout = AbortSignal.timeout(Math.max(0, waitMs) + PROXY_RESPONSE_GRACE_MS);
    const response = await fetch(`${this.primaryBaseUrl}/request-status?${query}`, {
      headers: this.authHeaders(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Proxy request status failed (${response.status})`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('status' in body)) throw new Error('Proxy returned an invalid request status response');
    if (body.status === null) return undefined;
    const status = parseRequestStatus(body.status);
    if (status.requestId !== requestId) throw new Error('Proxy returned status for a different request');
    return status;
  }

  override async sendRequest(
    endpoint: string,
    data: unknown,
    targetPeerId: string,
    timeoutMs = this.proxyRequestTimeout,
    signal?: AbortSignal,
    operationId?: string,
    identity?: unknown,
  ): Promise<unknown> {
    return this.postProxy({ endpoint, data, targetPeerId, timeoutMs, operationId, identity, submit: false }, signal);
  }

  // The primary admits the operation and answers at once, so the operation
  // never depends on this proxy or its caller staying connected.
  override async submitRequest(
    endpoint: string,
    data: unknown,
    targetPeerId: string,
    timeoutMs = this.proxyRequestTimeout,
    operationId?: string,
    identity?: unknown,
  ): Promise<RequestStatus> {
    const requestId = operationId ?? randomUUID();
    const status = parseRequestStatus(await this.postProxy({
      endpoint, data, targetPeerId, timeoutMs, operationId: requestId, identity, submit: true,
    }));
    if (status.requestId !== requestId) throw new Error('Proxy returned status for a different request');
    return status;
  }

  private async postProxy(
    request: {
      endpoint: string; data: unknown; targetPeerId: string; timeoutMs: number;
      operationId?: string; identity?: unknown; submit: boolean;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { endpoint, data, targetPeerId, submit } = request;
    let { identity } = request;
    const requestId = request.operationId ?? randomUUID();
    const details: RequestFailureDetails = { requestId, targetPeerId, stage: 'queued', outcome: 'not_executed', executionOutcome: 'not_executed' };
    if (!isValidOperationId(requestId)) {
      throw new RequestFailure('operationId must be a nonempty string of at most 128 characters', 'invalid_operation_id', details);
    }
    if (signal?.aborted) throw new RequestFailure(`Request aborted: ${requestId}; queued; not_executed`, 'request_aborted', details);
    if (submit && !this.primaryFeatures.has('submit')) {
      throw new RequestFailure(
        `${this.primaryDescription()} cannot start a job that outlives the call; call without async, or restart that server on this version; queued; not_executed`,
        'primary_unsupported', details,
      );
    }
    if (identity !== undefined && !this.primaryFeatures.has('identity')) {
      // That primary identifies an operation by its payload. Without a caller
      // operation ID nothing is retried by identity, so the payload suffices.
      if (request.operationId !== undefined) {
        throw new RequestFailure(
          `${this.primaryDescription()} cannot match a retry of operation ${requestId} to its first attempt; call without operation_id, or restart that server on this version; queued; not_executed`,
          'primary_unsupported', details,
        );
      }
      identity = undefined;
    }
    if (requiresScriptPreconditions(endpoint, data) && !this.primaryFeatures.has('script_preconditions')) {
      const argument = endpoint === '/api/find-and-replace-in-scripts' ? 'expected_revisions' : 'expected_revision';
      throw new RequestFailure(
        `${this.primaryDescription()} serves a Studio plugin that ignores ${argument} and would write unchecked; restart that server on this version, or call without ${argument}; queued; not_executed`,
        'primary_unsupported', details,
      );
    }
    if (requiresAtomicProperties(endpoint, data) && !this.primaryFeatures.has('atomic_properties')) {
      throw new RequestFailure(
        `${this.primaryDescription()} serves a Studio plugin that ignores atomic and dryRun and would write each property separately; restart that server on this version, or call without atomic; queued; not_executed`,
        'primary_unsupported', details,
      );
    }
    const controller = new AbortController();
    const effectiveTimeoutMs = Math.max(1, request.timeoutMs);
    let requestBody: string;
    try {
      requestBody = JSON.stringify({
        endpoint, data, targetPeerId, proxyInstanceId: this.proxyInstanceId,
        timeoutMs: effectiveTimeoutMs, operationId: requestId,
        ...(identity === undefined ? {} : { identity }),
        ...(submit ? { submit: true } : {}),
      });
    } catch {
      throw new RequestFailure(`Request ${requestId} cannot be serialized at proxy admission; queued; not_executed`, 'request_serialization_failed', details);
    }
    const requestBytes = Buffer.byteLength(requestBody);
    if (requestBytes > HTTP_BODY_LIMIT_BYTES) {
      throw new RequestFailure(
        `Request ${requestId} is ${requestBytes} bytes at proxy_send; limit ${HTTP_BODY_LIMIT_BYTES} bytes; queued; not_executed`,
        'request_too_large', { ...details, bytes: requestBytes, limitBytes: HTTP_BODY_LIMIT_BYTES, transportStage: 'proxy_send' },
      );
    }
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();
    // The primary starts its request timer after this fetch begins. Leave room
    // for its terminal response to travel back before aborting the proxy hop.
    // A submission is answered at admission, so it never waits for execution.
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, (submit ? 0 : effectiveTimeoutMs) + PROXY_RESPONSE_GRACE_MS);
    let primaryError = false;

    try {
      const response = await fetch(`${this.primaryBaseUrl}/proxy`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: requestBody,
        signal: controller.signal,
      });

      const body = await response.text();
      let result: unknown;
      try {
        result = JSON.parse(body);
      } catch {
        throw new Error(`Proxy request failed (${response.status}): ${body || response.statusText}`);
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Proxy returned an invalid response');
      }
      if ('error' in result && result.error !== undefined && typeof result.error !== 'string') {
        primaryError = true;
        throw result.error;
      }
      if ('error' in result && typeof result.error === 'string') {
        const details = 'details' in result ? parseFailureDetails(result.details, { requestId, targetPeerId }) : undefined;
        if (details && 'code' in result && typeof result.code === 'string') {
          throw new RequestFailure(result.error, result.code, details);
        }
        throw new RequestFailure(result.error, 'studio_response_error', {
          requestId, targetPeerId, stage: 'dispatched', outcome: 'unknown', executionOutcome: 'unknown',
        });
      }
      if (!response.ok) {
        throw new Error(`Proxy request failed (${response.status}): ${body || response.statusText}`);
      }
      return 'response' in result ? result.response : undefined;
    } catch (error) {
      if (error instanceof RequestFailure || primaryError) throw error;
      const isAbortError = error instanceof Error
        ? error.name === 'AbortError'
        : !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError';
      if (isAbortError) {
        const message = !timedOut && signal?.aborted ? 'Request aborted' : 'Proxy request timeout';
        throw new RequestFailure(
          `${message}: ${requestId}; dispatched to primary; unknown; use get_request_status`,
          !timedOut && signal?.aborted ? 'request_aborted' : 'proxy_request_timeout',
          { requestId, targetPeerId, stage: 'dispatched', outcome: 'unknown', executionOutcome: 'unknown', transportStage: 'proxy_send' },
        );
      }
      throw new RequestFailure(
        `Proxy connection lost: ${requestId}; dispatched to primary; unknown; use get_request_status. ${error instanceof Error ? error.message : String(error)}`,
        'proxy_connection_lost',
        { requestId, targetPeerId, stage: 'dispatched', outcome: 'unknown', executionOutcome: 'unknown', connectionLostAt: Date.now(), transportStage: 'proxy_send' },
      );
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

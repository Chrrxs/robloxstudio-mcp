import { createHash, randomUUID } from 'crypto';
import type {
  StudioCancellationReason,
  StudioQueuedRequest,
  StudioRequestCancellation,
  StudioSession,
  StudioTransportQueue,
} from './studio-transport.js';

export interface StudioPeer {
  peerId: string;
  transportPeerId: string;
  instanceId: string;
  multiplayerGroupId?: string;
  role: string;
  placeId: number;
  placeName: string;
  placeKey?: string;
  dataModelName: string;
  isRunning: boolean;
  pluginVersion: string;
  pluginVariant: string;
  serverVersion: string;
  lastActivity: number;
  connectedAt: number;
}

export interface PublicStudioPeer {
  peerId: string;
  instanceId: string;
  multiplayerGroupId?: string;
  role: string;
  placeId: number;
  placeName: string;
  placeKey?: string;
  dataModelName: string;
  isRunning: boolean;
  pluginVersion: string;
  pluginVariant: string;
  serverVersion: string;
  lastActivity: number;
  connectedAt: number;
}

export interface StudioInstance {
  id: string;
  multiplayerGroupId?: string;
  placeId: number;
  placeName: string;
  peers: StudioPeer[];
}

export interface PublicStudioInstance {
  id: string;
  multiplayerGroupId?: string;
  placeId: number;
  placeName: string;
  peers: PublicStudioPeer[];
}
export interface ConnectedStudioInstance {
  id: string;
  multiplayerGroupId?: string;
  placeId: number;
  placeName: string;
  peers: Record<string, string>;
}
export interface ConnectedMultiplayerGroup {
  id: string;
  controllerInstanceId?: string;
  instances: Record<string, string>;
}



export interface MultiplayerGroup {
  id: string;
  controllerInstanceId?: string;
  instanceIds: string[];
  createdAt: number;
}

export type PublicMultiplayerGroup = MultiplayerGroup;

export interface TopologySnapshot {
  peers: StudioPeer[];
  instances: StudioInstance[];
  multiplayerGroups: MultiplayerGroup[];
}

export interface RegisterPeerInput {
  peerId: string;
  transportPeerId: string;
  instanceId: string;
  multiplayerGroupId?: string;
  role: string;
  placeId?: number;
  placeName?: string;
  placeKey?: string;
  dataModelName?: string;
  isRunning?: boolean;
  pluginVersion?: string;
  pluginVariant?: string;
  serverVersion?: string;
}

export type RegisterPeerResult =
  | {
      ok: true;
      assignedRole: string;
      peerId: string;
      instanceId: string;
      multiplayerGroupId?: string;
    }
  | {
      ok: false;
      error:
        | {
            code: 'duplicate_scope_role';
            message: string;
            existing: PublicStudioPeer;
          }
        | {
            code: 'peer_identity_mismatch';
            message: string;
            existing: PublicStudioPeer;
          }
        | {
            code: 'instance_id_alias_collision';
            message: string;
            existing: PublicStudioPeer;
          };
    };

export type SettlementDisposition = 'accepted' | 'already_settled' | 'unknown';
export type RequestStage = 'queued' | 'dispatched' | 'executing' | 'response_delivery';
export type ExecutionOutcome = 'success' | 'error' | 'not_executed' | 'unknown';

export interface RequestObservations {
  /** Server observation times for plugin handler entry/return, not user Luau instruction execution. */
  executionStartedAt?: number;
  executionCompletedAt?: number;
  executionOutcome?: ExecutionOutcome;
  connectionLostAt?: number;
  connectionRestoredAt?: number;
}

export function isExecutionOutcome(value: unknown): value is ExecutionOutcome {
  return value === 'success' || value === 'error' || value === 'not_executed' || value === 'unknown';
}

export function isRequestStage(value: unknown): value is RequestStage {
  return value === 'queued' || value === 'dispatched' || value === 'executing' || value === 'response_delivery';
}

function handlerOutcome(response: unknown): ExecutionOutcome {
  if (!response || typeof response !== 'object') return 'success';
  if (('error' in response && response.error !== undefined && response.error !== null)
    || ('success' in response && response.success === false)
    || ('ok' in response && response.ok === false)) return 'error';
  if ('summary' in response && response.summary && typeof response.summary === 'object'
    && 'failed' in response.summary && typeof response.summary.failed === 'number' && response.summary.failed > 0) return 'error';
  return 'success';
}

function observations(status: RequestObservations): RequestObservations {
  return {
    executionStartedAt: status.executionStartedAt, executionCompletedAt: status.executionCompletedAt,
    executionOutcome: status.executionOutcome, connectionLostAt: status.connectionLostAt,
    connectionRestoredAt: status.connectionRestoredAt,
  };
}

export interface RequestStatus extends RequestObservations {
  requestId: string;
  targetPeerId: string;
  queuedAt: number;
  dispatchedAt?: number;
  settledAt?: number;
  waiterEndedAt?: number;
  stage: RequestStage;
  state: 'pending' | 'timed_out' | 'aborted' | 'disconnected' | 'settled';
  outcome: 'pending' | 'not_executed' | 'unknown' | 'success' | 'error';
  response?: unknown;
  error?: unknown;
  resultUnavailable?: { reason: 'size_limit' | 'serialization_failed' | 'retention_capacity'; bytes?: number; limitBytes: number };
}

export interface RequestFailureDetails extends RequestObservations {
  requestId: string;
  targetPeerId: string;
  stage: RequestStage;
  outcome: 'not_executed' | 'unknown';
  bytes?: number;
  limitBytes?: number;
  transportStage?: 'server_send' | 'proxy_send' | 'http_receive';
}

export class RequestFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: RequestFailureDetails,
  ) {
    super(message);
    this.name = 'RequestFailure';
  }
}

export function parseObservations(value: object): RequestObservations {
  const result: RequestObservations = {};
  if ('executionOutcome' in value) {
    if (!isExecutionOutcome(value.executionOutcome)) throw new Error('Invalid execution outcome');
    result.executionOutcome = value.executionOutcome;
  }
  for (const key of ['executionStartedAt', 'executionCompletedAt', 'connectionLostAt', 'connectionRestoredAt'] as const) {
    if (!(key in value)) continue;
    const timestamp = Reflect.get(value, key);
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) throw new Error('Invalid observation timestamp');
    result[key] = timestamp;
  }
  return result;
}

export function parseFailureDetails(
  value: unknown,
  identity: Pick<RequestFailureDetails, 'requestId' | 'targetPeerId'>,
): RequestFailureDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  // The HTTP parser rejects before decoding the envelope, so only the caller
  // can attach the operation identity to that transport's diagnostics.
  const isHttpRejection = 'transportStage' in value && value.transportStage === 'http_receive';
  const requestId = 'requestId' in value ? value.requestId : isHttpRejection ? identity.requestId : undefined;
  const targetPeerId = 'targetPeerId' in value ? value.targetPeerId : isHttpRejection ? identity.targetPeerId : undefined;
  if (
    typeof requestId !== 'string'
    || typeof targetPeerId !== 'string'
    || requestId !== identity.requestId || targetPeerId !== identity.targetPeerId
    || !('stage' in value) || !isRequestStage(value.stage)
    || !('outcome' in value) || (value.outcome !== 'not_executed' && value.outcome !== 'unknown')
  ) return undefined;
  return {
    requestId,
    targetPeerId,
    stage: value.stage,
    outcome: value.outcome,
    ...parseObservations(value),
    ...('bytes' in value && typeof value.bytes === 'number' ? { bytes: value.bytes } : {}),
    ...('limitBytes' in value && typeof value.limitBytes === 'number' ? { limitBytes: value.limitBytes } : {}),
    ...('transportStage' in value && (
      value.transportStage === 'server_send' || value.transportStage === 'proxy_send' || value.transportStage === 'http_receive'
    ) ? { transportStage: value.transportStage } : {}),
  };
}

interface OperationRecord {
  status: RequestStatus;
  fingerprint: string;
  transportPeerId?: string;
  updatedAt: number;
  serializedResult?: string;
  resultBytes: number;
}

interface PendingRequest {
  id: string;
  endpoint: string;
  data: unknown;
  targetPeerId: string;
  timestamp: number;
  claimOwner?: string;
  lastDeliveryTransportPeerId?: string;
  resolve: (value: unknown) => void;
  promise: Promise<unknown>;
  reject: (error: unknown) => void;
  timeoutId: NodeJS.Timeout;
  timeoutMs: number;
  requestBytes: number;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface PendingCancellation extends StudioRequestCancellation {
  transportPeerId: string;
  createdAt: number;
  claimOwner?: string;
}

export type RoutingErrorCode =
  | 'multiple_instances_connected'
  | 'ambiguous_target'
  | 'target_role_required'
  | 'target_role_not_present_on_instance'
  | 'unrecognized_instance_id';

export interface PublicTopologyChoices {
  instances: ConnectedStudioInstance[];
  multiplayerGroups: ConnectedMultiplayerGroup[];
  count: number;
}

export interface RoutingError {
  code: RoutingErrorCode;
  message: string;
  data: PublicTopologyChoices;
}

export class RoutingFailure extends Error {
  readonly routingError: RoutingError;

  constructor(routingError: RoutingError) {
    super(routingError.message);
    this.name = 'RoutingFailure';
    this.routingError = routingError;
  }
}

export type PeerRegisteredListener = (peer: PublicStudioPeer) => void;
export type PeerClosedListener = (peer: StudioSession) => void;

export interface ResolveTargetInput {
  instance_id?: string;
  target?: string;
}

export interface ResolvedPeerTarget {
  targetPeerId: string;
  targetInstanceId: string;
  targetRole: string;
}

export type ResolveTargetResult =
  | ({ ok: true; mode: 'single' } & ResolvedPeerTarget)
  | { ok: true; mode: 'fanout'; targets: ResolvedPeerTarget[] }
  | { ok: false; error: RoutingError };

export function toPublicPeer(peer: StudioPeer): PublicStudioPeer {
  return {
    peerId: peer.peerId,
    instanceId: peer.instanceId,
    multiplayerGroupId: peer.multiplayerGroupId,
    role: peer.role,
    placeId: peer.placeId,
    placeName: peer.placeName,
    placeKey: peer.placeKey,
    dataModelName: peer.dataModelName,
    isRunning: peer.isRunning,
    pluginVersion: peer.pluginVersion,
    pluginVariant: peer.pluginVariant,
    serverVersion: peer.serverVersion,
    lastActivity: peer.lastActivity,
    connectedAt: peer.connectedAt,
  };
}

const STALE_PEER_MS = 30_000;
const OPERATION_RETENTION_MS = 5 * 60_000;
const MAX_OPERATION_RECORDS = 32768;
const MAX_RETAINED_RESULTS = 1024;
const MAX_RETAINED_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 1024;
const MAX_PENDING_REQUEST_BYTES = 64 * 1024 * 1024;
const CANCELLATION_TOMBSTONE_TTL_MS = 60_000;
const MAX_CANCELLATION_TOMBSTONES = 4096;
// Node socket backpressure does not represent Studio's MessageReceived capacity.
// Keep each consumer's outstanding execution window small enough to avoid flooding it.
const MAX_OUTSTANDING_REQUESTS_PER_TRANSPORT = 4;

function roleOrder(role: string): number {
  if (role === 'edit') return 0;
  if (role === 'server') return 1;
  const client = /^client-(\d+)$/.exec(role);
  return client ? 2 + Number(client[1]) : Number.MAX_SAFE_INTEGER;
}
function isRuntimeRole(role: string): boolean {
  return role === 'server' || /^client-\d+$/.test(role);
}

function connectedRuntimeInstanceId(peer: StudioPeer): string {
  return `${peer.instanceId}-${peer.role}`;
}

function peerIdsByRole(peers: StudioPeer[]): Record<string, string> {
  return Object.fromEntries(
    [...peers]
      .sort((left, right) =>
        roleOrder(left.role) - roleOrder(right.role) || left.peerId.localeCompare(right.peerId))
      .map((peer) => [peer.role, peer.peerId]),
  );
}


function preferredPeer(peers: StudioPeer[]): StudioPeer {
  return peers.reduce((preferred, candidate) => {
    const difference = roleOrder(candidate.role) - roleOrder(preferred.role);
    if (difference !== 0) return difference < 0 ? candidate : preferred;
    return candidate.connectedAt < preferred.connectedAt ? candidate : preferred;
  });
}

function copyGroup(group: MultiplayerGroup): MultiplayerGroup {
  return { ...group, instanceIds: [...group.instanceIds] };
}

export class BridgeService implements StudioTransportQueue {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly operations = new Map<string, OperationRecord>();
  private readonly retainedResults = new Map<string, OperationRecord>();
  private retainedResultBytes = 0;
  private pendingRequestBytes = 0;
  private readonly pendingCancellations = new Map<string, PendingCancellation>();
  private readonly peersById = new Map<string, StudioPeer>();
  private readonly multiplayerGroupsById = new Map<string, MultiplayerGroup>();
  private readonly peerRegisteredListeners = new Set<PeerRegisteredListener>();
  private readonly requestAvailableListeners = new Set<(transportPeerId: string) => void>();
  private readonly peerClosedListeners = new Set<PeerClosedListener>();
  private readonly deliveryOwnersByTransportPeer = new Map<string, Set<string>>();
  private readonly requestTimeout = 30_000;

  onPeerRegistered(listener: PeerRegisteredListener): () => void {
    this.peerRegisteredListeners.add(listener);
    for (const peer of this.getPublicPeers()) {
      try {
        listener(peer);
      } catch {
        // Observers cannot disrupt bridge setup.
      }
    }
    return () => this.peerRegisteredListeners.delete(listener);
  }

  protected notifyPeerRegistered(peer: PublicStudioPeer): void {
    for (const listener of this.peerRegisteredListeners) {
      try {
        listener(peer);
      } catch {
        // Registration remains successful when a lifecycle observer fails.
      }
    }
  }

  onRequestAvailable(listener: (transportPeerId: string) => void): () => void {
    this.requestAvailableListeners.add(listener);
    return () => this.requestAvailableListeners.delete(listener);
  }

  onPeerClosed(listener: PeerClosedListener): () => void {
    this.peerClosedListeners.add(listener);
    return () => this.peerClosedListeners.delete(listener);
  }

  setDeliveryActive(transportPeerId: string, owner: string, active: boolean): void {
    let owners = this.deliveryOwnersByTransportPeer.get(transportPeerId);
    if (active) {
      if (!owners) {
        owners = new Set<string>();
        this.deliveryOwnersByTransportPeer.set(transportPeerId, owners);
      }
      owners.add(owner);
      for (const operation of this.operations.values()) {
        if (operation.transportPeerId === transportPeerId && operation.status.state !== 'settled'
          && operation.status.connectionLostAt !== undefined && operation.status.connectionRestoredAt === undefined) {
          operation.status.connectionRestoredAt = Date.now();
        }
      }
      return;
    }
    if (!owners) return;
    owners.delete(owner);
    if (owners.size === 0) {
      this.deliveryOwnersByTransportPeer.delete(transportPeerId);
      for (const operation of this.operations.values()) {
        if (operation.transportPeerId !== transportPeerId || operation.status.state === 'settled') continue;
        operation.status.connectionLostAt = Date.now();
        delete operation.status.connectionRestoredAt;
      }
    }
  }

  private notifyRequestAvailable(transportPeerId: string): void {
    for (const listener of this.requestAvailableListeners) {
      try {
        listener(transportPeerId);
      } catch {
        // Delivery observers cannot break queue ownership.
      }
    }
  }

  private notifyRequestCancelled(request: PendingRequest, reason: StudioCancellationReason): void {
    const transportPeerId = request.lastDeliveryTransportPeerId;
    if (!transportPeerId || this.pendingCancellations.has(request.id)) return;
    const now = Date.now();
    this.prunePendingCancellations(now);
    this.pendingCancellations.set(request.id, {
      requestId: request.id,
      reason,
      transportPeerId,
      createdAt: now,
    });
    this.prunePendingCancellations(now);
    this.notifyRequestAvailable(transportPeerId);
  }

  private groupIdForInstance(instanceId: string): string | undefined {
    for (const group of this.getMultiplayerGroups()) {
      if (group.instanceIds.includes(instanceId)) return group.id;
    }
    return undefined;
  }

  private peerScopeKey(peer: StudioPeer): string {
    return peer.multiplayerGroupId ? `group:${peer.multiplayerGroupId}` : `instance:${peer.instanceId}`;
  }

  private registrationScopePeers(instanceId: string, multiplayerGroupId?: string): StudioPeer[] {
    if (multiplayerGroupId) {
      return this.getPeers().filter((peer) => peer.multiplayerGroupId === multiplayerGroupId);
    }
    return this.getPeers().filter(
      (peer) => peer.instanceId === instanceId && peer.multiplayerGroupId === undefined,
    );
  }

  private detachInstanceFromOtherGroups(instanceId: string, retainedGroupId?: string): void {
    for (const group of this.multiplayerGroupsById.values()) {
      if (group.id === retainedGroupId || !group.instanceIds.includes(instanceId)) continue;
      group.instanceIds = group.instanceIds.filter((id) => id !== instanceId);
      if (group.controllerInstanceId === instanceId) group.controllerInstanceId = undefined;
      if (group.instanceIds.length === 0) this.multiplayerGroupsById.delete(group.id);
    }
  }
  private groupAttachmentConflict(instanceId: string, groupId: string): StudioPeer | undefined {
    const incomingRoles = new Set(
      this.getPeers()
        .filter((peer) => peer.instanceId === instanceId)
        .map((peer) => peer.role),
    );
    return this.getPeers().find(
      (peer) =>
        peer.instanceId !== instanceId &&
        peer.multiplayerGroupId === groupId &&
        incomingRoles.has(peer.role),
    );
  }


  private attachInstanceToGroup(instanceId: string, groupId: string): MultiplayerGroup {
    const conflict = this.groupAttachmentConflict(instanceId, groupId);
    if (conflict) {
      throw new Error(
        `Cannot attach Instance "${instanceId}" to Multiplayer Group "${groupId}": role "${conflict.role}" is already owned by Peer "${conflict.peerId}".`,
      );
    }
    this.detachInstanceFromOtherGroups(instanceId, groupId);
    let group = this.multiplayerGroupsById.get(groupId);
    if (!group) {
      group = { id: groupId, instanceIds: [], createdAt: Date.now() };
      this.multiplayerGroupsById.set(groupId, group);
    }
    if (!group.instanceIds.includes(instanceId)) group.instanceIds.push(instanceId);
    for (const peer of this.peersById.values()) {
      if (peer.instanceId === instanceId) peer.multiplayerGroupId = groupId;
    }
    return group;
  }

  createMultiplayerGroup(groupId: string, controllerInstanceId: string): MultiplayerGroup {
    const group = this.attachInstanceToGroup(controllerInstanceId, groupId);
    group.controllerInstanceId = controllerInstanceId;
    return copyGroup(group);
  }
  async createMultiplayerGroupEverywhere(
    groupId: string,
    controllerInstanceId: string,
  ): Promise<MultiplayerGroup> {
    return this.createMultiplayerGroup(groupId, controllerInstanceId);
  }


  removeMultiplayerGroup(groupId: string): MultiplayerGroup | undefined {
    const group = this.multiplayerGroupsById.get(groupId);
    if (!group) return undefined;
    this.multiplayerGroupsById.delete(groupId);
    for (const peer of this.peersById.values()) {
      if (peer.multiplayerGroupId === groupId) peer.multiplayerGroupId = undefined;
    }
    return copyGroup(group);
  }

  async removeMultiplayerGroupEverywhere(groupId: string): Promise<MultiplayerGroup | undefined> {
    return this.removeMultiplayerGroup(groupId);
  }

  private connectedInstanceIdCollision(
    peerId: string,
    instanceId: string,
    role: string,
    multiplayerGroupId?: string,
  ): StudioPeer | undefined {
    const peers = this.getPeers().filter((peer) => peer.peerId !== peerId);
    const canonicalCollision = peers.find((peer) =>
      peer.multiplayerGroupId !== undefined &&
      isRuntimeRole(peer.role) &&
      connectedRuntimeInstanceId(peer) === instanceId);
    if (canonicalCollision) return canonicalCollision;
    if (multiplayerGroupId === undefined || !isRuntimeRole(role)) return undefined;
    const runtimeAlias = `${instanceId}-${role}`;
    return peers.find((peer) => peer.instanceId === runtimeAlias);
  }

  registerPeer(input: RegisterPeerInput): RegisterPeerResult {
    const prior = this.peersById.get(input.peerId);
    if (
      prior &&
      (prior.instanceId !== input.instanceId || prior.transportPeerId !== input.transportPeerId)
    ) {
      return {
        ok: false,
        error: {
          code: 'peer_identity_mismatch',
          message: `Peer "${input.peerId}" is already registered to Instance "${prior.instanceId}" through transport Peer "${prior.transportPeerId}".`,
          existing: toPublicPeer(prior),
        },
      };
    }

    const multiplayerGroupId =
      input.multiplayerGroupId ?? this.groupIdForInstance(input.instanceId) ?? prior?.multiplayerGroupId;
    const attachmentConflict = multiplayerGroupId
      ? this.groupAttachmentConflict(input.instanceId, multiplayerGroupId)
      : undefined;
    if (attachmentConflict) {
      return {
        ok: false,
        error: {
          code: 'duplicate_scope_role',
          message: `Multiplayer Group "${multiplayerGroupId}" already has a Peer registered as "${attachmentConflict.role}".`,
          existing: toPublicPeer(attachmentConflict),
        },
      };
    }
    const scopePeers = this.registrationScopePeers(input.instanceId, multiplayerGroupId).filter(
      (peer) => peer.peerId !== input.peerId,
    );
    let assignedRole = input.role;

    if (input.role === 'client') {
      const used = new Set<number>();
      for (const peer of scopePeers) {
        const match = /^client-(\d+)$/.exec(peer.role);
        if (match) used.add(Number(match[1]));
      }
      const priorOrdinal = prior ? /^client-(\d+)$/.exec(prior.role) : null;
      if (prior && priorOrdinal && !used.has(Number(priorOrdinal[1]))) {
        assignedRole = prior.role;
      } else {
        let ordinal = 1;
        while (used.has(ordinal)) ordinal += 1;
        assignedRole = `client-${ordinal}`;
      }
    }
    const instanceIdCollision = this.connectedInstanceIdCollision(
      input.peerId,
      input.instanceId,
      assignedRole,
      multiplayerGroupId,
    );
    if (instanceIdCollision) {
      return {
        ok: false,
        error: {
          code: 'instance_id_alias_collision',
          message: `Instance "${input.instanceId}" would make a grouped runtime Instance ID ambiguous.`,
          existing: toPublicPeer(instanceIdCollision),
        },
      };
    }


    const existing = scopePeers.find((peer) => peer.role === assignedRole);
    if (existing) {
      const scopeDescription = multiplayerGroupId
        ? `Multiplayer Group "${multiplayerGroupId}"`
        : `Instance "${input.instanceId}"`;
      return {
        ok: false,
        error: {
          code: 'duplicate_scope_role',
          message: `${scopeDescription} already has a Peer registered as "${assignedRole}".`,
          existing: toPublicPeer(existing),
        },
      };
    }

    const now = Date.now();
    const registered: StudioPeer = {
      peerId: input.peerId,
      transportPeerId: input.transportPeerId,
      instanceId: input.instanceId,
      multiplayerGroupId,
      role: assignedRole,
      placeId: input.placeId ?? 0,
      placeName: input.placeName ?? '',
      placeKey: input.placeKey,
      dataModelName: input.dataModelName ?? '',
      isRunning: input.isRunning ?? false,
      pluginVersion: input.pluginVersion ?? '',
      pluginVariant: input.pluginVariant ?? 'unknown',
      serverVersion: input.serverVersion ?? '',
      lastActivity: now,
      connectedAt: prior?.connectedAt ?? now,
    };
    this.peersById.set(input.peerId, registered);
    if (multiplayerGroupId) this.attachInstanceToGroup(input.instanceId, multiplayerGroupId);

    this.notifyPeerRegistered(toPublicPeer(registered));
    this.notifyRequestAvailable(registered.transportPeerId);
    return {
      ok: true,
      assignedRole,
      peerId: registered.peerId,
      instanceId: registered.instanceId,
      multiplayerGroupId: registered.multiplayerGroupId,
    };
  }

  unregisterPeer(peerId: string): void {
    this.unregisterPeerInternal(peerId, new Set<string>());
  }

  private unregisterPeerInternal(
    peerId: string,
    visited: Set<string>,
    removedPeers?: StudioPeer[],
  ): void {
    if (visited.has(peerId)) return;
    visited.add(peerId);
    const removed = this.peersById.get(peerId);
    if (!removed) return;
    removedPeers?.push(removed);

    const dependentPeerIds = removed.transportPeerId === peerId
      ? this.getPeers()
          .filter((peer) => peer.peerId !== peerId && peer.transportPeerId === peerId)
          .map((peer) => peer.peerId)
      : [];
    this.peersById.delete(peerId);

    const session: StudioSession = { peerId, transportPeerId: removed.transportPeerId };
    for (const listener of this.peerClosedListeners) {
      try {
        listener(session);
      } catch {
        // Cleanup proceeds even if a downstream adapter fails.
      }
    }
    if (removed.transportPeerId === peerId) {
      this.deliveryOwnersByTransportPeer.delete(peerId);
    }

    for (const request of Array.from(this.pendingRequests.values())) {
      if (request.targetPeerId !== peerId) continue;
      const deliveryTransportPeerId = request.lastDeliveryTransportPeerId;
      this.endRequestWaiter(request, 'disconnected', `Target Peer "${peerId}" disconnected`);
      if (deliveryTransportPeerId) this.notifyRequestAvailable(deliveryTransportPeerId);
    }
    for (const dependentPeerId of dependentPeerIds) {
      this.unregisterPeerInternal(dependentPeerId, visited, removedPeers);
    }
    this.removeInstanceFromGroupsWhenDisconnected(removed.instanceId);
  }

  private removeInstanceFromGroupsWhenDisconnected(instanceId: string): void {
    if (this.getPeers().some((peer) => peer.instanceId === instanceId)) return;
    this.detachInstanceFromOtherGroups(instanceId);
  }

  unregisterInstanceId(instanceId: string): PublicStudioPeer[] {
    const matching = this.getPeers().filter((peer) => peer.instanceId === instanceId);
    const departingRuntimeGroupIds = new Set(matching.flatMap((peer) =>
      peer.multiplayerGroupId !== undefined && isRuntimeRole(peer.role)
        ? [peer.multiplayerGroupId]
        : []));
    const removedPeers: StudioPeer[] = [];
    const visited = new Set<string>();
    for (const peer of matching) {
      this.unregisterPeerInternal(peer.peerId, visited, removedPeers);
    }
    this.detachInstanceFromOtherGroups(instanceId);
    for (const groupId of departingRuntimeGroupIds) {
      const hasRuntimePeer = this.getPeers().some((peer) =>
        peer.multiplayerGroupId === groupId && isRuntimeRole(peer.role));
      if (!hasRuntimePeer) this.removeMultiplayerGroup(groupId);
    }
    return removedPeers.map(toPublicPeer);
  }

  async unregisterInstanceIdEverywhere(instanceId: string): Promise<PublicStudioPeer[]> {
    return this.unregisterInstanceId(instanceId);
  }

  getPeers(): StudioPeer[] {
    return Array.from(this.peersById.values());
  }

  getPublicPeers(): PublicStudioPeer[] {
    return this.getPeers().map(toPublicPeer);
  }

  getPeerById(peerId: string): StudioPeer | undefined {
    return this.getPeers().find((peer) => peer.peerId === peerId);
  }

  getInstances(): StudioInstance[] {
    const peersByInstance = new Map<string, StudioPeer[]>();
    for (const peer of this.getPeers()) {
      const peers = peersByInstance.get(peer.instanceId);
      if (peers) peers.push(peer);
      else peersByInstance.set(peer.instanceId, [peer]);
    }
    return Array.from(peersByInstance, ([id, peers]) => {
      const preferred = preferredPeer(peers);
      return {
        id,
        multiplayerGroupId: this.groupIdForInstance(id) ?? preferred.multiplayerGroupId,
        placeId: preferred.placeId,
        placeName: preferred.placeName,
        peers,
      };
    });
  }

  getPublicInstances(): PublicStudioInstance[] {
    return this.getInstances().map((instance) => ({
      id: instance.id,
      multiplayerGroupId: instance.multiplayerGroupId,
      placeId: instance.placeId,
      placeName: instance.placeName,
      peers: instance.peers.map(toPublicPeer),
    }));
  }
  getConnectedInstances(): ConnectedStudioInstance[] {
    return this.getInstances().flatMap((instance): ConnectedStudioInstance[] => {
      const peers = instance.multiplayerGroupId === undefined
        ? instance.peers
        : instance.peers.filter((peer) => !isRuntimeRole(peer.role));
      if (peers.length === 0) return [];
      return [{
        id: instance.id,
        multiplayerGroupId: instance.multiplayerGroupId,
        placeId: instance.placeId,
        placeName: instance.placeName,
        peers: peerIdsByRole(peers),
      }];
    });
  }

  getConnectedMultiplayerGroups(): ConnectedMultiplayerGroup[] {
    const peers = this.getPeers();
    return this.getMultiplayerGroups().map((group) => ({
      id: group.id,
      controllerInstanceId: group.controllerInstanceId,
      instances: Object.fromEntries(
        peers
          .filter((peer) => peer.multiplayerGroupId === group.id && isRuntimeRole(peer.role))
          .sort((left, right) =>
            roleOrder(left.role) - roleOrder(right.role) || left.peerId.localeCompare(right.peerId))
          .map((peer) => [connectedRuntimeInstanceId(peer), peer.peerId]),
      ),
    }));
  }


  getMultiplayerGroups(): MultiplayerGroup[] {
    return Array.from(this.multiplayerGroupsById.values(), copyGroup);
  }

  getPublicMultiplayerGroups(): PublicMultiplayerGroup[] {
    return this.getMultiplayerGroups().map(copyGroup);
  }

  getTopologySnapshot(): TopologySnapshot {
    return {
      peers: this.getPeers(),
      instances: this.getInstances(),
      multiplayerGroups: this.getMultiplayerGroups(),
    };
  }

  /** Local topology is authoritative; remote adapters must refresh before fanout. */
  refreshTopologyForRouting(signal?: AbortSignal): Promise<void> | undefined {
    if (signal?.aborted) throw new Error('Request aborted before topology resolution');
    return undefined;
  }

  resolveConnectedInstanceId(instanceId: string): string | undefined {
    const exact = this.getInstances().find((instance) => instance.id === instanceId);
    const groupedRuntime = this.getPeers().find((peer) =>
      peer.multiplayerGroupId !== undefined &&
      isRuntimeRole(peer.role) &&
      connectedRuntimeInstanceId(peer) === instanceId);
    if (exact && groupedRuntime && exact.id !== groupedRuntime.instanceId) return undefined;
    return exact?.id ?? groupedRuntime?.instanceId;
  }

  getInstanceIdsInScope(instanceId: string): string[] {
    const resolvedInstanceId = this.resolveConnectedInstanceId(instanceId);
    if (resolvedInstanceId === undefined) return [];
    const groupId = this.groupIdForInstance(resolvedInstanceId);
    if (groupId) {
      return [...(this.getMultiplayerGroups().find((group) => group.id === groupId)?.instanceIds ?? [])];
    }
    return [resolvedInstanceId];
  }

  getPeersInScope(instanceId: string): StudioPeer[] {
    const instanceIds = new Set(this.getInstanceIdsInScope(instanceId));
    return this.getPeers().filter((peer) => instanceIds.has(peer.instanceId));
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  updatePeerActivity(peerId: string): void {
    const peer = this.getPeerById(peerId);
    if (!peer) return;
    const now = Date.now();
    if (peer.transportPeerId === peerId) {
      for (const candidate of this.getPeers()) {
        if (candidate.transportPeerId === peerId) candidate.lastActivity = now;
      }
      return;
    }
    peer.lastActivity = now;
  }

  updatePeerMetadata(
    peerId: string,
    metadata: Partial<
      Pick<StudioPeer, 'placeId' | 'placeName' | 'placeKey' | 'dataModelName' | 'isRunning'>
    >,
  ): void {
    const peer = this.getPeerById(peerId);
    if (!peer) return;
    if (metadata.placeId !== undefined) peer.placeId = metadata.placeId;
    if (metadata.placeName !== undefined) peer.placeName = metadata.placeName;
    if (metadata.placeKey !== undefined) peer.placeKey = metadata.placeKey;
    if (metadata.dataModelName !== undefined) peer.dataModelName = metadata.dataModelName;
    if (metadata.isRunning !== undefined) peer.isRunning = metadata.isRunning;
  }

  cleanupStalePeers(): void {
    const now = Date.now();
    for (const peer of this.getPeers()) {
      const deliveryActive =
        (this.deliveryOwnersByTransportPeer.get(peer.transportPeerId)?.size ?? 0) > 0;
      if (!deliveryActive && now - peer.lastActivity > STALE_PEER_MS) {
        this.unregisterPeer(peer.peerId);
      }
    }
  }

  private routingErrorData(): PublicTopologyChoices {
    const instances = this.getConnectedInstances();
    const multiplayerGroups = this.getConnectedMultiplayerGroups();
    return {
      instances,
      multiplayerGroups,
      count: instances.length + multiplayerGroups.length,
    };
  }

  private resolvedTarget(peer: StudioPeer): ResolvedPeerTarget {
    return {
      targetPeerId: peer.peerId,
      targetInstanceId: peer.instanceId,
      targetRole: peer.role,
    };
  }

  private resolveWithinScope(
    peers: StudioPeer[],
    target: string | undefined,
    errorData: PublicTopologyChoices,
    selectedInstanceId?: string,
  ): ResolveTargetResult {
    if (target === 'all') {
      return { ok: true, mode: 'fanout', targets: peers.map((peer) => this.resolvedTarget(peer)) };
    }
    if (target) {
      const exact = peers.find((peer) => peer.role === target);
      if (!exact) {
        return {
          ok: false,
          error: {
            code: 'target_role_not_present_on_instance',
            message: `${selectedInstanceId ? `Instance "${selectedInstanceId}" scope` : 'The connected scope'} has no role "${target}". Available roles: ${peers.map((peer) => peer.role).join(', ')}.`,
            data: errorData,
          },
        };
      }
      return { ok: true, mode: 'single', ...this.resolvedTarget(exact) };
    }

    const edit = peers.find((peer) => peer.role === 'edit');
    if (edit) return { ok: true, mode: 'single', ...this.resolvedTarget(edit) };
    if (peers.length === 1) {
      return { ok: true, mode: 'single', ...this.resolvedTarget(peers[0]) };
    }
    return {
      ok: false,
      error: {
        code: 'target_role_required',
        message: `${selectedInstanceId ? `Instance "${selectedInstanceId}" scope` : 'The connected scope'} has multiple roles connected: ${peers.map((peer) => peer.role).join(', ')}. Pass target=<role>.`,
        data: errorData,
      },
    };
  }

  resolveTarget(input: ResolveTargetInput): ResolveTargetResult {
    const errorData = this.routingErrorData();
    if (input.instance_id !== undefined) {
      const peers = this.getPeersInScope(input.instance_id);
      if (peers.length === 0) {
        return {
          ok: false,
          error: {
            code: 'unrecognized_instance_id',
            message: `instance_id "${input.instance_id}" is not connected. Pass a connected top-level or grouped role-suffixed Instance ID.`,
            data: errorData,
          },
        };
      }
      return this.resolveWithinScope(peers, input.target, errorData, input.instance_id);
    }

    const scopeKeys = new Set(this.getPeers().map((peer) => this.peerScopeKey(peer)));
    if (scopeKeys.size === 0) {
      return {
        ok: false,
        error: {
          code: 'unrecognized_instance_id',
          message: 'No Studio Peer is connected.',
          data: errorData,
        },
      };
    }
    if (scopeKeys.size > 1) {
      const code: RoutingErrorCode = input.target ? 'ambiguous_target' : 'multiple_instances_connected';
      return {
        ok: false,
        error: {
          code,
          message: input.target
            ? `target=${input.target} is ambiguous because multiple Studio routing scopes are connected. Pass instance_id to choose a scope.`
            : 'Multiple Studio routing scopes are connected. Pass instance_id to disambiguate.',
          data: errorData,
        },
      };
    }

    const onlyScope = scopeKeys.values().next().value;
    const peers = this.getPeers().filter((peer) => this.peerScopeKey(peer) === onlyScope);
    return this.resolveWithinScope(peers, input.target, errorData);
  }

  sendRequest(
    endpoint: string,
    data: unknown,
    targetPeerId: string,
    timeoutMs = this.requestTimeout,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<unknown> {
    const requestId = operationId ?? randomUUID();
    const effectiveTimeoutMs = Math.max(1, timeoutMs);
    const details: RequestFailureDetails = { requestId, targetPeerId, stage: 'queued', outcome: 'not_executed', executionOutcome: 'not_executed' };
    if (typeof requestId !== 'string' || requestId.trim().length === 0 || requestId.length > 128) {
      return Promise.reject(new RequestFailure('operationId must be a nonempty string of at most 128 characters', 'invalid_operation_id', details));
    }
    if (signal?.aborted) {
      return Promise.reject(new RequestFailure(`Request aborted: ${requestId}; queued; not_executed`, 'request_aborted', details));
    }
    let requestBytes: number;
    let fingerprint: string;
    try {
      const target = this.getPeerById(targetPeerId);
      fingerprint = createHash('sha256').update(JSON.stringify({ targetPeerId, endpoint, data })).digest('hex');
      requestBytes = Buffer.byteLength(JSON.stringify({
        kind: 'request', requestId, peerId: targetPeerId, target: target?.role,
        endpoint, data: data ?? null, remainingMs: effectiveTimeoutMs,
      }));
    } catch {
      return Promise.reject(new RequestFailure(`Request ${requestId} cannot be serialized; queued; not_executed`, 'request_serialization_failed', details));
    }
    this.pruneOperations(Date.now());
    const existing = this.operations.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new RequestFailure(
          `Request ${requestId} already identifies a different operation; existing operation ${existing.status.stage}; not replayed`,
          'operation_id_collision',
          { requestId, targetPeerId: existing.status.targetPeerId, stage: existing.status.stage, outcome: 'unknown', ...observations(existing.status) },
        ));
      }
      const pending = this.pendingRequests.get(requestId);
      if (pending) return pending.promise;
      const status = this.getRequestStatus(requestId)!;
      if (status.state === 'settled' && !status.resultUnavailable) {
        const error = status.error;
        if (error && typeof error === 'object'
          && 'name' in error && error.name === 'RequestFailure'
          && 'code' in error && typeof error.code === 'string'
          && 'message' in error && typeof error.message === 'string' && 'details' in error) {
          const failureDetails = parseFailureDetails(error.details, { requestId, targetPeerId });
          if (failureDetails) return Promise.reject(new RequestFailure(error.message, error.code, failureDetails));
        }
        return Object.hasOwn(status, 'error') ? Promise.reject(status.error) : Promise.resolve(status.response);
      }
      return Promise.reject(new RequestFailure(
        `Request ${requestId} already exists: ${status.state}; ${status.stage}; ${status.outcome}; use get_request_status; not replayed`,
        'operation_not_replayed',
        { requestId, targetPeerId, stage: status.stage, outcome: status.executionOutcome === 'not_executed' ? 'not_executed' : 'unknown', ...observations(status) },
      ));
    }
    if (requestBytes > MAX_REQUEST_BYTES) {
      return Promise.reject(new RequestFailure(
        `Request ${requestId} is ${requestBytes} bytes at server_send; limit ${MAX_REQUEST_BYTES} bytes; queued; not_executed`,
        'request_too_large', { ...details, bytes: requestBytes, limitBytes: MAX_REQUEST_BYTES, transportStage: 'server_send' },
      ));
    }
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS || this.pendingRequestBytes + requestBytes > MAX_PENDING_REQUEST_BYTES) {
      return Promise.reject(new RequestFailure(
        `Request ${requestId} rejected at admission: pending capacity exceeded (${this.pendingRequests.size}/${MAX_PENDING_REQUESTS} requests, ${this.pendingRequestBytes + requestBytes}/${MAX_PENDING_REQUEST_BYTES} bytes); queued; not_executed`,
        'request_capacity_exceeded', { ...details, bytes: this.pendingRequestBytes + requestBytes, limitBytes: MAX_PENDING_REQUEST_BYTES },
      ));
    }

    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const abortListener = () => {
      const pending = this.pendingRequests.get(requestId);
      if (pending) this.endRequestWaiter(pending, 'aborted', 'Request aborted');
    };
    const timeoutId = setTimeout(() => {
      const pending = this.pendingRequests.get(requestId);
      if (pending) this.endRequestWaiter(pending, 'timed_out', 'Request timeout');
    }, effectiveTimeoutMs);
    const now = Date.now();
    const request: PendingRequest = {
      id: requestId, endpoint, data, targetPeerId, timestamp: now,
      resolve, reject, promise, timeoutId, timeoutMs: effectiveTimeoutMs, requestBytes,
      abortSignal: signal, abortListener,
    };
    this.pendingRequests.set(requestId, request);
    this.pendingRequestBytes += requestBytes;
    this.operations.set(requestId, {
      status: { requestId, targetPeerId, queuedAt: now, stage: 'queued', state: 'pending', outcome: 'pending', executionOutcome: 'unknown' },
      fingerprint, updatedAt: now, resultBytes: 0,
    });
    this.pruneOperations(now);
    signal?.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) abortListener();
    const target = this.getPeerById(targetPeerId);
    if (this.pendingRequests.has(requestId) && target) this.notifyRequestAvailable(target.transportPeerId);
    return promise;
  }

  private endRequestWaiter(
    request: PendingRequest,
    state: 'timed_out' | 'aborted' | 'disconnected',
    message: string,
  ): void {
    if (!this.removePendingRequest(request)) return;
    const operation = this.operations.get(request.id);
    const stage = operation?.status.stage ?? (request.lastDeliveryTransportPeerId ? 'dispatched' : 'queued');
    const outcome = stage === 'queued' || operation?.status.executionOutcome === 'not_executed' ? 'not_executed' : 'unknown';
    if (operation) {
      operation.status.state = state;
      operation.status.outcome = outcome;
      if (stage === 'queued') operation.status.executionOutcome = 'not_executed';
      operation.status.waiterEndedAt = Date.now();
      operation.updatedAt = Date.now();
      this.operations.delete(request.id);
      this.operations.set(request.id, operation);
    }
    if (state !== 'disconnected') {
      this.notifyRequestCancelled(request, state === 'timed_out' ? 'timeout' : 'aborted');
    }
    const connectionLost = operation?.status.connectionLostAt !== undefined && operation.status.connectionRestoredAt === undefined;
    request.reject(new RequestFailure(
      `${message}: ${request.id}; ${stage}; ${outcome}${connectionLost ? '; connection lost' : ''}; waiter ended, execution is not cancelled or rolled back`,
      state === 'timed_out' ? (connectionLost ? 'request_connection_lost' : 'request_timeout') : `request_${state}`,
      { requestId: request.id, targetPeerId: request.targetPeerId, stage, outcome, ...(operation ? observations(operation.status) : {}) },
    ));
  }

  private removePendingRequest(request: PendingRequest): boolean {
    if (this.pendingRequests.get(request.id) !== request) return false;
    clearTimeout(request.timeoutId);
    if (request.abortSignal && request.abortListener) {
      request.abortSignal.removeEventListener('abort', request.abortListener);
    }
    this.pendingRequests.delete(request.id);
    this.pendingRequestBytes -= request.requestBytes;
    return true;
  }

  claimNextRequestForTransport(
    transportPeerId: string,
    claimOwner: string,
  ): StudioQueuedRequest | null {
    let outstandingCount = 0;
    for (const request of this.pendingRequests.values()) {
      if (request.lastDeliveryTransportPeerId === transportPeerId) outstandingCount++;
    }
    if (outstandingCount >= MAX_OUTSTANDING_REQUESTS_PER_TRANSPORT) return null;

    let oldestRequest: PendingRequest | undefined;
    for (const request of this.pendingRequests.values()) {
      if (request.claimOwner !== undefined) continue;
      const peer = this.getPeerById(request.targetPeerId);
      if (!peer || peer.transportPeerId !== transportPeerId) continue;
      if (!oldestRequest || request.timestamp < oldestRequest.timestamp) oldestRequest = request;
    }
    if (!oldestRequest) return null;
    const peer = this.getPeerById(oldestRequest.targetPeerId);
    if (!peer) return null;
    oldestRequest.claimOwner = claimOwner;
    oldestRequest.lastDeliveryTransportPeerId = transportPeerId;
    const operation = this.operations.get(oldestRequest.id);
    if (operation) {
      operation.transportPeerId = transportPeerId;
      operation.status.stage = 'dispatched';
      operation.status.dispatchedAt = Date.now();
      operation.updatedAt = Date.now();
    }
    return {
      requestId: oldestRequest.id,
      peerId: oldestRequest.targetPeerId,
      target: peer.role,
      endpoint: oldestRequest.endpoint,
      data: oldestRequest.data,
      remainingMs: Math.max(1, oldestRequest.timeoutMs - (Date.now() - oldestRequest.timestamp)),
    };
  }

  claimNextCancellationForTransport(
    transportPeerId: string,
    claimOwner: string,
  ): StudioRequestCancellation | null {
    this.prunePendingCancellations(Date.now());
    for (const cancellation of this.pendingCancellations.values()) {
      if (cancellation.transportPeerId !== transportPeerId || cancellation.claimOwner !== undefined) {
        continue;
      }
      cancellation.claimOwner = claimOwner;
      return { requestId: cancellation.requestId, reason: cancellation.reason };
    }
    return null;
  }

  releaseDeliveryClaims(claimOwner: string): void {
    const transportPeerIds = new Set<string>();
    // A claimed mutation may already be executing. Reconnect must never replay it.
    for (const cancellation of this.pendingCancellations.values()) {
      if (cancellation.claimOwner !== claimOwner) continue;
      cancellation.claimOwner = undefined;
      transportPeerIds.add(cancellation.transportPeerId);
    }
    for (const transportPeerId of transportPeerIds) this.notifyRequestAvailable(transportPeerId);
  }

  private ownedOperation(transportPeerId: string, requestId: string): OperationRecord | undefined {
    this.pruneOperations(Date.now());
    const operation = this.operations.get(requestId);
    if (!operation || operation.transportPeerId !== transportPeerId) return undefined;
    const peer = this.getPeerById(operation.status.targetPeerId);
    const transport = this.getPeerById(transportPeerId);
    return peer?.transportPeerId === transportPeerId && transport?.transportPeerId === transportPeerId ? operation : undefined;
  }

  observeTransportProgress(
    transportPeerId: string, requestId: string, phase: 'executing' | 'response_delivery', outcome?: ExecutionOutcome,
  ): void {
    const operation = this.ownedOperation(transportPeerId, requestId);
    if (!operation || operation.status.state === 'settled' || operation.status.stage === 'response_delivery'
      || (phase === 'executing' && operation.status.stage !== 'dispatched')) return;
    const now = Date.now();
    operation.status.stage = phase;
    if (phase === 'executing') operation.status.executionStartedAt = now;
    else {
      operation.status.executionOutcome = outcome ?? 'unknown';
      if (outcome !== 'not_executed') operation.status.executionCompletedAt = now;
    }
    operation.updatedAt = now;
    this.operations.delete(requestId);
    this.operations.set(requestId, operation);
  }

  settleTransportResponse(
    transportPeerId: string,
    requestId: string,
    response: unknown,
    error?: unknown,
    executionOutcome?: ExecutionOutcome,
  ): SettlementDisposition {
    const operation = this.ownedOperation(transportPeerId, requestId);
    if (!operation) return 'unknown';
    if (error !== undefined && executionOutcome !== undefined) {
      error = new RequestFailure(
        typeof error === 'string' ? error : 'Studio response failed',
        'studio_response_error',
        {
          requestId, targetPeerId: operation.status.targetPeerId, ...observations(operation.status),
          executionCompletedAt: executionOutcome === 'not_executed' ? undefined : operation.status.executionCompletedAt ?? Date.now(),
          stage: 'response_delivery', outcome: executionOutcome === 'not_executed' ? 'not_executed' : 'unknown', executionOutcome,
        },
      );
    }
    return this.recordResponse(requestId, response, error, executionOutcome);
  }

  /** Trusted in-process settlement; transport handlers must use settleTransportResponse. */
  resolveRequest(requestId: string, response: unknown): SettlementDisposition {
    return this.recordResponse(requestId, response);
  }

  /** Trusted in-process settlement; transport handlers must use settleTransportResponse. */
  rejectRequest(requestId: string, error: unknown): SettlementDisposition {
    return this.recordResponse(requestId, undefined, error);
  }

  private recordResponse(requestId: string, response: unknown, error?: unknown, executionOutcome?: ExecutionOutcome): SettlementDisposition {
    const now = Date.now();
    this.pruneOperations(now);
    const operation = this.operations.get(requestId);
    if (!operation) return 'unknown';
    if (operation.status.state === 'settled') return 'already_settled';

    const hasError = error !== undefined;
    operation.status.state = 'settled';
    const localRejection = error instanceof RequestFailure && error.details.transportStage === 'server_send';
    const responseOutcome = handlerOutcome(response);
    const completedOutcome = !hasError && responseOutcome === 'error' ? 'error'
      : executionOutcome ?? (localRejection ? 'not_executed' : hasError
        ? operation.status.executionOutcome === 'success' ? 'success' : 'error' : responseOutcome);
    operation.status.executionOutcome = completedOutcome;
    operation.status.outcome = hasError || completedOutcome === 'error' || completedOutcome === 'not_executed' ? 'error' : 'success';
    if (!localRejection) {
      operation.status.stage = 'response_delivery';
      if (completedOutcome !== 'not_executed') operation.status.executionCompletedAt ??= now;
    }
    operation.status.settledAt = now;
    operation.updatedAt = now;
    try {
      const recordedError = error instanceof Error
        ? { ...error, name: error.name, message: error.message }
        : error;
      const serialized = JSON.stringify(hasError ? { error: recordedError } : { response });
      const bytes = Buffer.byteLength(serialized);
      if (bytes > MAX_RETAINED_RESULT_BYTES) {
        operation.status.resultUnavailable = { reason: 'size_limit', bytes, limitBytes: MAX_RETAINED_RESULT_BYTES };
      } else {
        operation.serializedResult = serialized;
        operation.resultBytes = bytes;
        this.retainedResultBytes += bytes;
        this.retainedResults.set(requestId, operation);
      }
    } catch {
      operation.status.resultUnavailable = { reason: 'serialization_failed', limitBytes: MAX_RETAINED_RESULT_BYTES };
    }
    // Nonpending entries stay ordered by their latest lifecycle transition.
    this.operations.delete(requestId);
    this.operations.set(requestId, operation);
    const request = this.pendingRequests.get(requestId);
    if (request && this.removePendingRequest(request)) {
      if (hasError) request.reject(error);
      else request.resolve(response);
    }
    this.pendingCancellations.delete(requestId);
    this.pruneOperations(now);
    if (operation.transportPeerId) this.notifyRequestAvailable(operation.transportPeerId);
    return 'accepted';
  }

  getRequestStatus(requestId: string): RequestStatus | undefined {
    this.pruneOperations(Date.now());
    const operation = this.operations.get(requestId);
    if (!operation) return undefined;
    const status = { ...operation.status };
    if (status.resultUnavailable) status.resultUnavailable = { ...status.resultUnavailable };
    if (operation.serializedResult !== undefined) {
      const result: unknown = JSON.parse(operation.serializedResult);
      if (result && typeof result === 'object') {
        if ('response' in result) status.response = result.response;
        if ('error' in result) status.error = result.error;
      }
    }
    return status;
  }

  async getRequestStatusEverywhere(requestId: string): Promise<RequestStatus | undefined> {
    return this.getRequestStatus(requestId);
  }

  private pruneOperations(now: number): void {
    for (const [requestId, operation] of this.operations) {
      if (this.pendingRequests.has(requestId)) continue;
      if (now - operation.updatedAt < OPERATION_RETENTION_MS) break;
      this.operations.delete(requestId);
      this.retainedResults.delete(requestId);
      this.retainedResultBytes -= operation.resultBytes;
    }
    while (this.operations.size > MAX_OPERATION_RECORDS) {
      let removed = false;
      for (const [requestId, operation] of this.operations) {
        if (this.pendingRequests.has(requestId)) continue;
        this.operations.delete(requestId);
        this.retainedResults.delete(requestId);
        this.retainedResultBytes -= operation.resultBytes;
        removed = true;
        break;
      }
      if (!removed) break;
    }
    if (this.retainedResults.size <= MAX_RETAINED_RESULTS && this.retainedResultBytes <= MAX_RETAINED_RESULT_BYTES) return;
    for (const [requestId, operation] of this.retainedResults) {
      operation.status.resultUnavailable = {
        reason: 'retention_capacity', bytes: operation.resultBytes, limitBytes: MAX_RETAINED_RESULT_BYTES,
      };
      this.retainedResultBytes -= operation.resultBytes;
      operation.resultBytes = 0;
      operation.serializedResult = undefined;
      this.retainedResults.delete(requestId);
      if (this.retainedResults.size <= MAX_RETAINED_RESULTS && this.retainedResultBytes <= MAX_RETAINED_RESULT_BYTES) break;
    }
  }

  private prunePendingCancellations(now: number): void {
    for (const [requestId, cancellation] of this.pendingCancellations) {
      if (now - cancellation.createdAt < CANCELLATION_TOMBSTONE_TTL_MS) break;
      this.pendingCancellations.delete(requestId);
    }
    while (this.pendingCancellations.size > MAX_CANCELLATION_TOMBSTONES) {
      const oldestRequestId = this.pendingCancellations.keys().next().value;
      if (oldestRequestId === undefined) break;
      this.pendingCancellations.delete(oldestRequestId);
    }
  }

  cleanupOldRequests(): void {
    const now = Date.now();
    for (const request of this.pendingRequests.values()) {
      if (now - request.timestamp >= request.timeoutMs) {
        this.endRequestWaiter(request, 'timed_out', 'Request timeout');
      }
    }
    this.pruneOperations(now);
  }

  clearAllPendingRequests(): void {
    for (const request of Array.from(this.pendingRequests.values())) {
      this.endRequestWaiter(request, 'disconnected', 'Connection closed');
    }
    this.pendingCancellations.clear();
  }
}

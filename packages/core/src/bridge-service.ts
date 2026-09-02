import { randomUUID } from 'crypto';
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

interface PendingRequest {
  id: string;
  endpoint: string;
  data: unknown;
  targetPeerId: string;
  timestamp: number;
  claimOwner?: string;
  lastDeliveryTransportPeerId?: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  timeoutMs: number;
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
const ACCEPTED_REQUEST_TOMBSTONE_TTL_MS = 60_000;
const MAX_ACCEPTED_REQUEST_TOMBSTONES = 4096;
const CANCELLATION_TOMBSTONE_TTL_MS = 60_000;
const MAX_CANCELLATION_TOMBSTONES = 4096;
// Node socket backpressure does not represent Studio's MessageReceived capacity.
// Keep each consumer's outstanding execution window small enough to avoid flooding it.
const MAX_OUTSTANDING_REQUESTS_PER_DELIVERY_OWNER = 4;

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
  private readonly acceptedRequestIds = new Map<string, number>();
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
      return;
    }
    if (!owners) return;
    owners.delete(owner);
    if (owners.size === 0) this.deliveryOwnersByTransportPeer.delete(transportPeerId);
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
      this.removePendingRequest(request);
      request.reject(new Error(`Target Peer "${peerId}" disconnected`));
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
  ): Promise<unknown> {
    const requestId = randomUUID();
    const effectiveTimeoutMs = Math.max(1, timeoutMs);
    if (signal?.aborted) return Promise.reject(new Error('Request aborted'));

    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const cancelPending = (reason: StudioCancellationReason, error: Error): void => {
      const pending = this.pendingRequests.get(requestId);
      if (!pending || !this.removePendingRequest(pending)) return;
      this.notifyRequestCancelled(pending, reason);
      pending.reject(error);
    };
    const timeoutId = setTimeout(
      () => cancelPending('timeout', new Error('Request timeout')),
      effectiveTimeoutMs,
    );
    const abortListener = () => cancelPending('aborted', new Error('Request aborted'));
    const request: PendingRequest = {
      id: requestId,
      endpoint,
      data,
      targetPeerId,
      timestamp: Date.now(),
      resolve,
      reject,
      timeoutId,
      timeoutMs: effectiveTimeoutMs,
      abortSignal: signal,
      abortListener,
    };

    this.pendingRequests.set(requestId, request);
    signal?.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) abortListener();
    const target = this.getPeerById(targetPeerId);
    if (this.pendingRequests.has(requestId) && target) {
      this.notifyRequestAvailable(target.transportPeerId);
    }
    return promise;
  }

  private removePendingRequest(request: PendingRequest): boolean {
    if (this.pendingRequests.get(request.id) !== request) return false;
    clearTimeout(request.timeoutId);
    if (request.abortSignal && request.abortListener) {
      request.abortSignal.removeEventListener('abort', request.abortListener);
    }
    this.pendingRequests.delete(request.id);
    return true;
  }

  claimNextRequestForTransport(
    transportPeerId: string,
    claimOwner: string,
  ): StudioQueuedRequest | null {
    let outstandingCount = 0;
    for (const request of this.pendingRequests.values()) {
      if (request.claimOwner === claimOwner) outstandingCount++;
    }
    if (outstandingCount >= MAX_OUTSTANDING_REQUESTS_PER_DELIVERY_OWNER) return null;

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
    for (const request of this.pendingRequests.values()) {
      if (request.claimOwner !== claimOwner) continue;
      request.claimOwner = undefined;
      const peer = this.getPeerById(request.targetPeerId);
      if (peer) transportPeerIds.add(peer.transportPeerId);
    }
    for (const cancellation of this.pendingCancellations.values()) {
      if (cancellation.claimOwner !== claimOwner) continue;
      cancellation.claimOwner = undefined;
      transportPeerIds.add(cancellation.transportPeerId);
    }
    for (const transportPeerId of transportPeerIds) this.notifyRequestAvailable(transportPeerId);
  }

  resolveRequest(requestId: string, response: unknown): SettlementDisposition {
    return this.settleRequest(requestId, (request) => request.resolve(response));
  }

  rejectRequest(requestId: string, error: unknown): SettlementDisposition {
    return this.settleRequest(requestId, (request) => request.reject(error));
  }

  private settleRequest(
    requestId: string,
    settle: (request: PendingRequest) => void,
  ): SettlementDisposition {
    const now = Date.now();
    this.pruneAcceptedRequestIds(now);
    const request = this.pendingRequests.get(requestId);
    if (!request) return this.acceptedRequestIds.has(requestId) ? 'already_settled' : 'unknown';

    const deliveryTransportPeerId = request.lastDeliveryTransportPeerId;
    this.removePendingRequest(request);
    this.acceptedRequestIds.set(requestId, now);
    this.pruneAcceptedRequestIds(now);
    settle(request);
    if (deliveryTransportPeerId) this.notifyRequestAvailable(deliveryTransportPeerId);
    return 'accepted';
  }

  private pruneAcceptedRequestIds(now: number): void {
    for (const [requestId, acceptedAt] of this.acceptedRequestIds) {
      if (now - acceptedAt < ACCEPTED_REQUEST_TOMBSTONE_TTL_MS) break;
      this.acceptedRequestIds.delete(requestId);
    }
    while (this.acceptedRequestIds.size > MAX_ACCEPTED_REQUEST_TOMBSTONES) {
      const oldestRequestId = this.acceptedRequestIds.keys().next().value;
      if (oldestRequestId === undefined) break;
      this.acceptedRequestIds.delete(oldestRequestId);
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
      if (now - request.timestamp > request.timeoutMs && this.removePendingRequest(request)) {
        this.notifyRequestCancelled(request, 'timeout');
        request.reject(new Error('Request timeout'));
      }
    }
  }

  clearAllPendingRequests(): void {
    for (const request of Array.from(this.pendingRequests.values())) {
      this.removePendingRequest(request);
      request.reject(new Error('Connection closed'));
    }
    this.pendingCancellations.clear();
  }
}

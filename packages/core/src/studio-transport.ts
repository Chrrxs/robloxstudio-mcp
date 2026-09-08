import type { RawData } from 'ws';
import type { ExecutionOutcome, SettlementDisposition } from './bridge-service.js';
import { isExecutionOutcome, RequestFailure } from './bridge-service.js';

export interface StudioSession {
  peerId: string;
  transportPeerId: string;
}

export interface StudioQueuedRequest {
  requestId: string;
  peerId: string;
  target: string;
  endpoint: string;
  data: unknown;
  remainingMs: number;
}


export type StudioCancellationReason = 'timeout' | 'aborted' | 'connection_closed';

export interface StudioRequestCancellation {
  requestId: string;
  reason: StudioCancellationReason;
}

export interface StudioTransportQueue {
  claimNextRequestForTransport(transportPeerId: string, claimOwner: string): StudioQueuedRequest | null;
  releaseDeliveryClaims(claimOwner: string): void;
  onRequestAvailable(listener: (transportPeerId: string) => void): () => void;
  claimNextCancellationForTransport(
    transportPeerId: string,
    claimOwner: string,
  ): StudioRequestCancellation | null;
  onPeerClosed(listener: (peer: StudioSession) => void): () => void;
  setDeliveryActive(transportPeerId: string, owner: string, active: boolean): void;
  updatePeerActivity(peerId: string): void;
  observeTransportProgress(
    transportPeerId: string, requestId: string, phase: 'executing' | 'response_delivery', outcome?: ExecutionOutcome,
  ): void;
  settleTransportResponse(
    transportPeerId: string,
    requestId: string,
    response: unknown,
    error?: unknown,
    executionOutcome?: ExecutionOutcome,
  ): SettlementDisposition;
}

export interface StudioRequestEvent extends StudioQueuedRequest {
  kind: 'request';
}

export interface StudioCancelEvent extends StudioRequestCancellation {
  kind: 'cancel';
}

export interface StudioStatusEvent {
  kind: 'status';
  knownPeer: boolean;
  mcpConnected: boolean;
  serverVersion?: string;
  pluginVersion?: string;
  pluginVariant?: string;
}

export interface StudioHeartbeatEvent {
  kind: 'heartbeat';
  timestamp: number;
}

export interface StudioAckEvent {
  kind: 'ack';
  requestId: string;
  disposition: SettlementDisposition;
}

export type StudioServerEvent =
  | StudioRequestEvent
  | StudioCancelEvent
  | StudioStatusEvent
  | StudioHeartbeatEvent
  | StudioAckEvent;

export interface StudioSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'close' | 'error', listener: () => void): this;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  removeListener(event: 'close' | 'error', listener: () => void): this;
  removeListener(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
}

export interface StudioSocketHandle {
  readonly transportPeerId: string;
  close(): void;
}

interface ActiveStudioSocket {
  transportPeerId: string;
  claimOwner: string;
  socket: StudioSocket;
  status: () => StudioStatusEvent;
  heartbeatTimer?: NodeJS.Timeout;
  closeTimer?: NodeJS.Timeout;
  closed: boolean;
  sending: boolean;
  pumping: boolean;
  settling: boolean;
  statusPending: boolean;
  heartbeatPending: boolean;
  lastStatusJson?: string;
  acknowledgements: Map<string, StudioAckEvent>;
  onClose: () => void;
  onError: () => void;
  onMessage: (data: RawData, isBinary: boolean) => void;
}

const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_PENDING_ACKS = 128;
export const STUDIO_PROTOCOL_VERSION = 1;
export const MAX_ACTIVE_STUDIO_SOCKETS = 64;
export const MAX_STUDIO_FRAME_BYTES = 64 * 1024 * 1024;
// A single maximum-size text message, including the WebSocket framing header.
export const MAX_STUDIO_BUFFERED_BYTES = MAX_STUDIO_FRAME_BYTES + 14;

/** Authenticated, duplex Studio delivery with one bounded socket write at a time. */
export class WebSocketStudioTransport {
  private readonly sockets = new Map<string, ActiveStudioSocket>();
  private readonly closing = new Set<ActiveStudioSocket>();
  private readonly unsubscribeRequestAvailable: () => void;
  private readonly unsubscribePeerClosed: () => void;
  private nextGeneration = 0;
  private closed = false;

  constructor(private readonly queue: StudioTransportQueue) {
    this.unsubscribeRequestAvailable = queue.onRequestAvailable((transportPeerId) => {
      const connection = this.sockets.get(transportPeerId);
      if (connection) this.pump(connection);
    });
    this.unsubscribePeerClosed = queue.onPeerClosed((peer) => {
      if (peer.peerId === peer.transportPeerId) this.closeTransport(peer.transportPeerId);
    });
  }

  get activeSocketCount(): number {
    return this.sockets.size;
  }

  canOpen(transportPeerId: string): boolean {
    return !this.closed && (this.sockets.has(transportPeerId) || this.sockets.size < MAX_ACTIVE_STUDIO_SOCKETS);
  }

  open(
    transportPeerId: string,
    socket: StudioSocket,
    status: () => StudioStatusEvent,
  ): StudioSocketHandle | undefined {
    if (!this.canOpen(transportPeerId) || socket.readyState !== 1) return undefined;
    this.nextGeneration += 1;
    const claimOwner = `ws:${transportPeerId}:${this.nextGeneration}`;
    const connection: ActiveStudioSocket = {
      transportPeerId,
      claimOwner,
      socket,
      status,
      closed: false,
      sending: false,
      pumping: false,
      settling: false,
      statusPending: true,
      heartbeatPending: false,
      acknowledgements: new Map(),
      onClose: () => {
        this.closeSocket(connection);
        this.finishClose(connection);
      },
      onError: () => this.closeSocket(connection, 1011, 'socket_error'),
      onMessage: (data, isBinary) => this.receive(connection, data, isBinary),
    };

    // Activate the new owner before releasing the old one. Old callbacks can
    // neither turn off delivery for the replacement nor consume its commands.
    this.queue.setDeliveryActive(transportPeerId, claimOwner, true);
    const replaced = this.sockets.get(transportPeerId);
    if (replaced) this.closeSocket(replaced, 1012, 'transport_replaced');
    this.sockets.set(transportPeerId, connection);
    this.queue.updatePeerActivity(transportPeerId);
    socket.on('close', connection.onClose);
    socket.on('error', connection.onError);
    socket.on('message', connection.onMessage);
    connection.heartbeatTimer = setInterval(() => {
      if (!this.isCurrent(connection)) return;
      this.queue.updatePeerActivity(transportPeerId);
      connection.statusPending = true;
      connection.heartbeatPending = true;
      this.pump(connection);
    }, HEARTBEAT_INTERVAL_MS);
    connection.heartbeatTimer.unref();
    this.pump(connection);
    return { transportPeerId, close: () => this.closeSocket(connection, 1000, 'transport_closed') };
  }

  refreshStatus(transportPeerId?: string): void {
    if (transportPeerId !== undefined) {
      const connection = this.sockets.get(transportPeerId);
      if (connection) {
        connection.statusPending = true;
        this.pump(connection);
      }
      return;
    }
    for (const connection of this.sockets.values()) {
      connection.statusPending = true;
      this.pump(connection);
    }
  }

  closeTransport(transportPeerId: string): void {
    const connection = this.sockets.get(transportPeerId);
    if (connection) this.closeSocket(connection, 1000, 'peer_unregistered');
  }

  close(): void {
    this.closed = true;
    for (const connection of this.sockets.values()) this.closeSocket(connection, 1001, 'server_shutdown');
    this.unsubscribeRequestAvailable();
    this.unsubscribePeerClosed();
  }

  private isCurrent(connection: ActiveStudioSocket): boolean {
    return !connection.closed && this.sockets.get(connection.transportPeerId) === connection;
  }

  private receive(connection: ActiveStudioSocket, data: RawData, isBinary: boolean): void {
    if (!this.isCurrent(connection)) return;
    if (isBinary) {
      this.closeSocket(connection, 1003, 'text_frames_required');
      return;
    }
    const bytes = Array.isArray(data)
      ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
      : data.byteLength;
    if (bytes > MAX_STUDIO_FRAME_BYTES) {
      this.closeSocket(connection, 1009, `server_receive bytes=${bytes} limit=${MAX_STUDIO_FRAME_BYTES}`);
      return;
    }
    let message: unknown;
    try {
      const buffer = Array.isArray(data) ? Buffer.concat(data, bytes)
        : data instanceof ArrayBuffer ? Buffer.from(data) : data;
      message = JSON.parse(buffer.toString('utf8'));
    } catch {
      this.closeSocket(connection, 1007, 'invalid_json');
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)
      || !('kind' in message) || (message.kind !== 'response' && message.kind !== 'progress')
      || !('requestId' in message) || typeof message.requestId !== 'string'
      || message.requestId.length === 0 || message.requestId.length > 1024) {
      this.closeSocket(connection, 1008, 'invalid_response');
      return;
    }
    if (message.kind === 'progress') {
      const outcome = 'outcome' in message ? message.outcome : undefined;
      if (!('phase' in message) || (message.phase !== 'executing' && message.phase !== 'response_delivery')
        || (outcome !== undefined && !isExecutionOutcome(outcome))
        || (message.phase === 'executing' && 'outcome' in message)) return;
      this.queue.observeTransportProgress(
        connection.transportPeerId, message.requestId, message.phase, outcome,
      );
      this.queue.updatePeerActivity(connection.transportPeerId);
      return;
    }
    const executionOutcome = 'executionOutcome' in message ? message.executionOutcome : undefined;
    if (executionOutcome !== undefined && !isExecutionOutcome(executionOutcome)) return;
    const response = 'response' in message ? message.response : undefined;
    const error = 'error' in message ? message.error : undefined;
    connection.settling = true;
    try {
      const disposition = this.queue.settleTransportResponse(
        connection.transportPeerId, message.requestId, response, error, executionOutcome,
      );
      if (!this.isCurrent(connection)) return;
      // Recording must succeed before acknowledging. If a slow consumer fills
      // this bounded queue, reconnect can safely obtain the retained disposition.
      if (!connection.acknowledgements.has(message.requestId)
        && connection.acknowledgements.size >= MAX_PENDING_ACKS) {
        this.closeSocket(connection, 1013, 'ack_backpressure');
        return;
      }
      connection.acknowledgements.set(message.requestId, {
        kind: 'ack', requestId: message.requestId, disposition,
      });
      this.queue.updatePeerActivity(connection.transportPeerId);
    } catch {
      this.closeSocket(connection, 1011, 'response_recording_failed');
    } finally {
      connection.settling = false;
    }
    this.pump(connection);
  }

  private pump(connection: ActiveStudioSocket): void {
    if (!this.isCurrent(connection) || connection.sending || connection.pumping || connection.settling) return;
    connection.pumping = true;
    try {
      while (this.isCurrent(connection) && !connection.sending) {
        const ack = connection.acknowledgements.values().next().value;
        if (ack) {
          connection.acknowledgements.delete(ack.requestId);
          this.send(connection, ack);
          continue;
        }
        if (connection.statusPending) {
          connection.statusPending = false;
          const status = connection.status();
          const statusJson = JSON.stringify(status);
          if (statusJson !== connection.lastStatusJson) {
            connection.lastStatusJson = statusJson;
            this.send(connection, status, statusJson);
            continue;
          }
        }
        const cancellation = this.queue.claimNextCancellationForTransport(
          connection.transportPeerId, connection.claimOwner,
        );
        if (cancellation) {
          this.send(connection, { kind: 'cancel', ...cancellation });
          continue;
        }
        const request = this.queue.claimNextRequestForTransport(connection.transportPeerId, connection.claimOwner);
        if (request) {
          this.send(connection, { kind: 'request', ...request, data: request.data ?? null });
          continue;
        }
        if (connection.heartbeatPending) {
          connection.heartbeatPending = false;
          this.send(connection, { kind: 'heartbeat', timestamp: Date.now() });
          continue;
        }
        return;
      }
    } catch {
      this.closeSocket(connection, 1011, 'transport_pump_failed');
    } finally {
      connection.pumping = false;
    }
  }

  private send(connection: ActiveStudioSocket, event: StudioServerEvent, serialized?: string): void {
    let json: string;
    try {
      json = serialized ?? JSON.stringify(event);
    } catch {
      if (event.kind !== 'request') throw new Error('Unserializable Studio event');
      this.queue.settleTransportResponse(connection.transportPeerId, event.requestId, undefined,
        new RequestFailure(
          'Studio request could not be serialized before WebSocket delivery at server_send',
          'studio_frame_serialization_failed',
          {
            requestId: event.requestId, targetPeerId: event.peerId, stage: 'dispatched',
            outcome: 'not_executed', executionOutcome: 'not_executed', transportStage: 'server_send',
          },
        ));
      return;
    }
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_STUDIO_FRAME_BYTES) {
      if (event.kind === 'request') {
        this.queue.settleTransportResponse(connection.transportPeerId, event.requestId, undefined,
          new RequestFailure(
            `Studio request frame is ${bytes} bytes; limit is ${MAX_STUDIO_FRAME_BYTES} at server_send`,
            'studio_frame_too_large',
            {
              requestId: event.requestId, targetPeerId: event.peerId, stage: 'dispatched',
              outcome: 'not_executed', executionOutcome: 'not_executed', transportStage: 'server_send', bytes, limitBytes: MAX_STUDIO_FRAME_BYTES,
            },
          ));
      } else {
        this.closeSocket(connection, 1009, `server_send bytes=${bytes} limit=${MAX_STUDIO_FRAME_BYTES}`);
      }
      return;
    }
    if (connection.socket.readyState !== 1
      || connection.socket.bufferedAmount + bytes > MAX_STUDIO_BUFFERED_BYTES) {
      this.closeSocket(connection, 1013, 'server_send_backpressure');
      return;
    }
    connection.sending = true;
    connection.socket.send(json, (error) => {
      if (!this.isCurrent(connection)) return;
      connection.sending = false;
      if (error) this.closeSocket(connection, 1011, 'server_send_failed');
      else this.pump(connection);
    });
  }

  private closeSocket(connection: ActiveStudioSocket, code?: number, reason?: string): void {
    if (connection.closed) return;
    connection.closed = true;
    clearInterval(connection.heartbeatTimer);
    connection.socket.removeListener('message', connection.onMessage);
    connection.acknowledgements.clear();
    if (this.sockets.get(connection.transportPeerId) === connection) this.sockets.delete(connection.transportPeerId);
    this.queue.setDeliveryActive(connection.transportPeerId, connection.claimOwner, false);
    this.queue.releaseDeliveryClaims(connection.claimOwner);
    if (code !== undefined) {
      this.closing.add(connection);
      connection.closeTimer = setTimeout(() => {
        connection.socket.terminate();
        this.finishClose(connection);
      }, 1000);
      connection.closeTimer.unref();
      connection.socket.close(code, reason);
      // A reconnect flood must not retain arbitrarily many closing sockets.
      if (this.closing.size > MAX_ACTIVE_STUDIO_SOCKETS) {
        const oldest = this.closing.values().next().value;
        if (oldest) {
          oldest.socket.terminate();
          this.finishClose(oldest);
        }
      }
    }
  }

  private finishClose(connection: ActiveStudioSocket): void {
    clearTimeout(connection.closeTimer);
    this.closing.delete(connection);
    connection.socket.removeListener('close', connection.onClose);
    connection.socket.removeListener('error', connection.onError);
  }
}

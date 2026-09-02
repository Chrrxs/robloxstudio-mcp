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
}


export interface StudioRequestEvent {
  kind: 'request';
  requestId: string;
  peerId: string;
  target: string;
  endpoint: string;
  data: unknown;
  remainingMs: number;
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

export type StudioServerEvent =
  | StudioRequestEvent
  | StudioCancelEvent
  | StudioStatusEvent
  | StudioHeartbeatEvent;

export interface EventStreamSink {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close' | 'error' | 'drain', listener: () => void): this;
  removeListener(event: 'close' | 'error' | 'drain', listener: () => void): this;
}

export interface EventStreamHandle {
  readonly transportPeerId: string;
  close(): void;
}

interface ActiveEventStream {
  transportPeerId: string;
  claimOwner: string;
  sink: EventStreamSink;
  status: () => StudioStatusEvent;
  heartbeatTimer?: NodeJS.Timeout;
  closed: boolean;
  blocked: boolean;
  statusPending: boolean;
  lastStatusJson?: string;
  onClose: () => void;
  onDrain: () => void;
}

const HEARTBEAT_INTERVAL_MS = 10_000;
export const MAX_ACTIVE_EVENT_STREAMS = 64;

/** Persistent SSE downstream adapter, multiplexed by transport Peer. */
export class SseStudioTransport {
  private readonly streams = new Map<string, ActiveEventStream>();
  private readonly unsubscribeRequestAvailable: () => void;
  private readonly unsubscribePeerClosed: () => void;
  private nextGeneration = 0;

  constructor(private readonly queue: StudioTransportQueue) {
    this.unsubscribeRequestAvailable = queue.onRequestAvailable((transportPeerId) => {
      const stream = this.streams.get(transportPeerId);
      if (stream) this.pump(stream);
    });
    this.unsubscribePeerClosed = queue.onPeerClosed((route) => {
      if (route.peerId === route.transportPeerId) {
        this.closeTransport(route.transportPeerId);
      }
    });
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  canOpen(transportPeerId: string): boolean {
    return this.streams.has(transportPeerId) || this.streams.size < MAX_ACTIVE_EVENT_STREAMS;
  }

  open(
    transportPeerId: string,
    sink: EventStreamSink,
    status: () => StudioStatusEvent,
  ): EventStreamHandle | undefined {
    if (!this.canOpen(transportPeerId)) return undefined;

    this.nextGeneration += 1;
    const claimOwner = `sse:${transportPeerId}:${this.nextGeneration}`;
    const stream: ActiveEventStream = {
      transportPeerId,
      claimOwner,
      sink,
      status,
      closed: false,
      blocked: false,
      statusPending: true,
      onClose: () => this.closeStream(stream),
      onDrain: () => {
        if (stream.closed) return;
        stream.blocked = false;
        this.pump(stream);
      },
    };

    this.queue.setDeliveryActive(transportPeerId, claimOwner, true);
    this.queue.updatePeerActivity(transportPeerId);
    const replaced = this.streams.get(transportPeerId);
    if (replaced) this.closeStream(replaced, true);

    this.streams.set(transportPeerId, stream);
    sink.on('close', stream.onClose);
    sink.on('error', stream.onClose);
    sink.on('drain', stream.onDrain);
    stream.heartbeatTimer = setInterval(() => {
      if (!stream.closed && !stream.blocked) {
        this.queue.updatePeerActivity(transportPeerId);
        stream.statusPending = true;
        this.pump(stream);
        if (!stream.blocked) {
          this.write(stream, { kind: 'heartbeat', timestamp: Date.now() });
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    stream.heartbeatTimer.unref();
    this.pump(stream);

    return {
      transportPeerId,
      close: () => this.closeStream(stream, true),
    };
  }

  refreshStatus(transportPeerId?: string): void {
    if (transportPeerId !== undefined) {
      const stream = this.streams.get(transportPeerId);
      if (stream) {
        stream.lastStatusJson = undefined;
        stream.statusPending = true;
        this.pump(stream);
      }
      return;
    }
    for (const stream of this.streams.values()) {
      stream.lastStatusJson = undefined;
      stream.statusPending = true;
      this.pump(stream);
    }
  }

  closeTransport(transportPeerId: string): void {
    const stream = this.streams.get(transportPeerId);
    if (stream) this.closeStream(stream, true);
  }

  close(): void {
    for (const stream of Array.from(this.streams.values())) {
      this.closeStream(stream, true);
    }
    this.unsubscribeRequestAvailable();
    this.unsubscribePeerClosed();
  }

  private pump(stream: ActiveEventStream): void {
    if (stream.closed || stream.blocked || this.streams.get(stream.transportPeerId) !== stream) return;

    if (stream.statusPending) {
      stream.statusPending = false;
      let status: StudioStatusEvent;
      try {
        status = stream.status();
      } catch {
        this.closeStream(stream);
        return;
      }
      const statusJson = JSON.stringify(status);
      if (statusJson !== stream.lastStatusJson) {
        stream.lastStatusJson = statusJson;
        if (!this.write(stream, status)) return;
      }
    }

    while (!stream.closed && !stream.blocked) {
      const cancellation = this.queue.claimNextCancellationForTransport(
        stream.transportPeerId,
        stream.claimOwner,
      );
      if (!cancellation) break;
      if (!this.write(stream, { kind: 'cancel', ...cancellation })) return;
    }

    while (!stream.closed && !stream.blocked) {
      const request = this.queue.claimNextRequestForTransport(stream.transportPeerId, stream.claimOwner);
      if (!request) return;
      const event: StudioRequestEvent = {
        kind: 'request',
        requestId: request.requestId,
        peerId: request.peerId,
        target: request.target,
        endpoint: request.endpoint,
        data: request.data === undefined ? null : request.data,
        remainingMs: request.remainingMs,
      };
      if (!this.write(stream, event)) return;
    }
  }

  private write(stream: ActiveEventStream, event: StudioServerEvent): boolean {
    if (stream.closed) return false;
    try {
      const writable = stream.sink.write(`data: ${JSON.stringify(event)}\n\n`);
      if (!writable) stream.blocked = true;
      return writable;
    } catch {
      this.closeStream(stream);
      return false;
    }
  }

  private closeStream(stream: ActiveEventStream, endSink = false): void {
    if (stream.closed) return;
    stream.closed = true;
    clearInterval(stream.heartbeatTimer);
    stream.sink.removeListener('close', stream.onClose);
    stream.sink.removeListener('error', stream.onClose);
    stream.sink.removeListener('drain', stream.onDrain);
    if (this.streams.get(stream.transportPeerId) === stream) {
      this.streams.delete(stream.transportPeerId);
    }
    this.queue.updatePeerActivity(stream.transportPeerId);
    this.queue.setDeliveryActive(stream.transportPeerId, stream.claimOwner, false);
    this.queue.releaseDeliveryClaims(stream.claimOwner);
    if (endSink) {
      try {
        stream.sink.end();
      } catch {
        // The peer may already have destroyed the response.
      }
    }
  }
}

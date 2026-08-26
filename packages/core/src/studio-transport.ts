export interface StudioSession {
  logicalSessionId: string;
  physicalSessionId: string;
}

export interface StudioQueuedRequest {
  requestId: string;
  logicalSessionId: string;
  target: string;
  endpoint: string;
  data: unknown;
}

export interface StudioTransportQueue {
  claimNextRequestForPhysical(physicalSessionId: string, claimOwner: string): StudioQueuedRequest | null;
  releaseDeliveryClaims(claimOwner: string): void;
  onRequestAvailable(listener: (physicalSessionId: string) => void): () => void;
  onSessionClosed(listener: (session: StudioSession) => void): () => void;
  setDeliveryActive(physicalSessionId: string, owner: string, active: boolean): void;
  updateInstanceActivity(pluginSessionId: string): void;
}


export interface StudioRequestEvent {
  kind: 'request';
  requestId: string;
  logicalSessionId: string;
  target: string;
  endpoint: string;
  data: unknown;
}

export interface StudioStatusEvent {
  kind: 'status';
  knownInstance: boolean;
  mcpConnected: boolean;
  serverVersion?: string;
  pluginVersion?: string;
  pluginVariant?: string;
}

export interface StudioHeartbeatEvent {
  kind: 'heartbeat';
  timestamp: number;
}

export type StudioServerEvent = StudioRequestEvent | StudioStatusEvent | StudioHeartbeatEvent;

export interface EventStreamSink {
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close' | 'error' | 'drain', listener: () => void): this;
  removeListener(event: 'close' | 'error' | 'drain', listener: () => void): this;
}

export interface EventStreamHandle {
  readonly physicalSessionId: string;
  close(): void;
}

interface ActiveEventStream {
  physicalSessionId: string;
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

/** Persistent SSE downstream adapter, multiplexed by physical Studio peer. */
export class SseStudioTransport {
  private readonly streams = new Map<string, ActiveEventStream>();
  private readonly unsubscribeRequestAvailable: () => void;
  private readonly unsubscribeSessionClosed: () => void;
  private nextGeneration = 0;

  constructor(private readonly queue: StudioTransportQueue) {
    this.unsubscribeRequestAvailable = queue.onRequestAvailable((physicalSessionId) => {
      const stream = this.streams.get(physicalSessionId);
      if (stream) this.pump(stream);
    });
    this.unsubscribeSessionClosed = queue.onSessionClosed((route) => {
      if (route.logicalSessionId === route.physicalSessionId) {
        this.closePhysical(route.physicalSessionId);
      }
    });
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  canOpen(physicalSessionId: string): boolean {
    return this.streams.has(physicalSessionId) || this.streams.size < MAX_ACTIVE_EVENT_STREAMS;
  }

  open(
    physicalSessionId: string,
    sink: EventStreamSink,
    status: () => StudioStatusEvent,
  ): EventStreamHandle | undefined {
    if (!this.canOpen(physicalSessionId)) return undefined;

    this.nextGeneration += 1;
    const claimOwner = `sse:${physicalSessionId}:${this.nextGeneration}`;
    const stream: ActiveEventStream = {
      physicalSessionId,
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

    this.queue.setDeliveryActive(physicalSessionId, claimOwner, true);
    this.queue.updateInstanceActivity(physicalSessionId);
    const replaced = this.streams.get(physicalSessionId);
    if (replaced) this.closeStream(replaced, true);

    this.streams.set(physicalSessionId, stream);
    sink.on('close', stream.onClose);
    sink.on('error', stream.onClose);
    sink.on('drain', stream.onDrain);
    stream.heartbeatTimer = setInterval(() => {
      if (!stream.closed && !stream.blocked) {
        this.queue.updateInstanceActivity(physicalSessionId);
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
      physicalSessionId,
      close: () => this.closeStream(stream, true),
    };
  }

  refreshStatus(physicalSessionId?: string): void {
    if (physicalSessionId !== undefined) {
      const stream = this.streams.get(physicalSessionId);
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

  closePhysical(physicalSessionId: string): void {
    const stream = this.streams.get(physicalSessionId);
    if (stream) this.closeStream(stream, true);
  }

  close(): void {
    for (const stream of Array.from(this.streams.values())) {
      this.closeStream(stream, true);
    }
    this.unsubscribeRequestAvailable();
    this.unsubscribeSessionClosed();
  }

  private pump(stream: ActiveEventStream): void {
    if (stream.closed || stream.blocked || this.streams.get(stream.physicalSessionId) !== stream) return;

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
      const request = this.queue.claimNextRequestForPhysical(stream.physicalSessionId, stream.claimOwner);
      if (!request) return;
      const event: StudioRequestEvent = {
        kind: 'request',
        requestId: request.requestId,
        logicalSessionId: request.logicalSessionId,
        target: request.target,
        endpoint: request.endpoint,
        data: request.data === undefined ? null : request.data,
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
    if (this.streams.get(stream.physicalSessionId) === stream) {
      this.streams.delete(stream.physicalSessionId);
    }
    this.queue.updateInstanceActivity(stream.physicalSessionId);
    this.queue.setDeliveryActive(stream.physicalSessionId, stream.claimOwner, false);
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

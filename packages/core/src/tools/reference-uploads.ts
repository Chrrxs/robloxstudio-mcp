import { OpenCloudOperationError, OpenCloudRequestError } from '../opencloud-client.js';
import { RobloxCookieRequestError, RobloxUploadOperationError } from '../roblox-cookie-client.js';

/** A create request Roblox accepted and is still processing. */
export interface RemoteUploadOperation {
  provider: 'open_cloud' | 'user_auth';
  /** Open Cloud operation path, or the user-auth operation ID. */
  id: string;
}

/**
 * Reported by an uploader as its work becomes visible to Roblox, so a failed
 * attempt can be classified: never sent, sent without an answer, accepted as
 * a remote operation, or created.
 */
export interface ReferenceUploadProgress {
  sending(): void;
  accepted(operation: RemoteUploadOperation): void;
  /** The asset exists; resolving the image ID it is used by may still fail. */
  created(assetId: string): void;
}

/** Where a resumed upload continues from. */
export interface ReferenceUploadCheckpoint {
  remoteOperation?: RemoteUploadOperation;
  createdAssetId?: string;
}

export interface ReferenceUploadAttempt {
  upload(progress: ReferenceUploadProgress): Promise<number>;
  resume(checkpoint: ReferenceUploadCheckpoint, progress: ReferenceUploadProgress): Promise<number>;
}

export type ReferenceUploadStage =
  /** Uploading, or resuming an upload Roblox already accepted. */
  | 'uploading'
  /** The image asset ID is known; the generation has not been handed to Studio. */
  | 'uploaded'
  /** The generation was handed to the bridge under this operation ID. */
  | 'dispatched'
  /** Roblox created nothing; a retry uploads again. */
  | 'upload_failed'
  /** The upload may have created an asset, so it is never repeated. */
  | 'upload_unknown';

type UploadPhase = 'local' | 'sending' | 'accepted' | 'created';

interface UploadRecord {
  operationId: string;
  identityKey: string;
  targetPeerId: string;
  stage: ReferenceUploadStage;
  phase: UploadPhase;
  startedAt: number;
  updatedAt: number;
  imageAssetId?: number;
  createdAssetId?: string;
  remoteOperation?: RemoteUploadOperation;
  error?: string;
  inFlight?: Promise<number>;
  /** The latest call's upload-and-dispatch work, for status waits. */
  job?: Promise<unknown>;
}

/** The public view of an operation's reference-image preparation. */
export interface ReferenceUploadView {
  stage: ReferenceUploadStage;
  targetPeerId: string;
  startedAt: number;
  updatedAt: number;
  imageAssetId?: number;
  uploadedAssetId?: string;
  remoteOperation?: RemoteUploadOperation;
  error?: string;
}

/** Thrown when an operation cannot get its reference image without risking a duplicate upload. */
export class ReferenceUploadError extends Error {
  constructor(
    message: string,
    readonly code: 'operation_id_collision' | 'reference_upload_failed' | 'reference_upload_unknown',
  ) {
    super(message);
    this.name = 'ReferenceUploadError';
  }
}

// Outlives the bridge record of the generation it prepared: a generation is
// held open for at most 300 s and its record is retained 5 minutes after that.
export const REFERENCE_UPLOAD_RETENTION_MS = 10 * 60_000;
const MAX_REFERENCE_UPLOAD_RECORDS = 256;
const PHASE_ORDER: Record<UploadPhase, number> = { local: 0, sending: 1, accepted: 2, created: 3 };

// True only when Roblox certainly created no asset for this attempt.
function createdNothing(error: unknown, phase: UploadPhase): boolean {
  if (phase === 'local') return true;
  if (phase === 'sending') {
    // An HTTP answer below 500 is a refusal. A 5xx, timeout, or lost connection
    // leaves the outcome unknown.
    return (error instanceof OpenCloudRequestError || error instanceof RobloxCookieRequestError) && error.status < 500;
  }
  if (phase === 'accepted') return error instanceof OpenCloudOperationError || error instanceof RobloxUploadOperationError;
  return false;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Reference-image uploads for generate_model, keyed by the caller's operation
 * ID so that retries, including concurrent ones, share one upload. Each
 * record keeps the uploaded image asset ID and any remote operation ID for the
 * current server session.
 */
export class ReferenceUploads {
  private readonly records = new Map<string, UploadRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The record for operationId after checking this request matches it.
   * Undefined when this session has prepared nothing under that ID.
   */
  lookup(operationId: string, identityKey: string, targetPeerId: string): ReferenceUploadView | undefined {
    const record = this.matching(operationId, identityKey, targetPeerId);
    return record && this.toView(record);
  }

  /**
   * The image asset ID for this operation: reuses a finished upload, joins one
   * in flight, resumes one Roblox accepted, or starts one. An upload whose
   * outcome is unknown and cannot be resumed is refused, never repeated.
   */
  acquire(operationId: string, identityKey: string, targetPeerId: string, attempt: ReferenceUploadAttempt): Promise<number> {
    let record = this.matching(operationId, identityKey, targetPeerId);
    if (record) {
      record.targetPeerId = targetPeerId;
      if (record.inFlight) return record.inFlight;
      if (record.imageAssetId !== undefined) return Promise.resolve(record.imageAssetId);
      if (record.stage === 'upload_unknown') {
        const checkpoint = { remoteOperation: record.remoteOperation, createdAssetId: record.createdAssetId };
        if (checkpoint.remoteOperation || checkpoint.createdAssetId) {
          return this.run(record, (progress) => attempt.resume(checkpoint, progress));
        }
        return Promise.reject(new ReferenceUploadError(
          `The reference image upload for operation ${operationId} has an unknown outcome (${record.error ?? 'no answer'}); it may have created an asset, so it is not repeated. Pass image_asset_id for an asset it created, or use a new operation_id.`,
          'reference_upload_unknown',
        ));
      }
      record.phase = 'local';
      record.remoteOperation = undefined;
      record.createdAssetId = undefined;
    } else {
      const now = this.now();
      record = { operationId, identityKey, targetPeerId, stage: 'uploading', phase: 'local', startedAt: now, updatedAt: now };
      this.records.set(operationId, record);
      this.prune();
    }
    return this.run(record, (progress) => attempt.upload(progress));
  }

  /** Records that the generation was handed to the bridge for targetPeerId. */
  dispatched(operationId: string, targetPeerId: string): void {
    const record = this.records.get(operationId);
    if (!record || record.imageAssetId === undefined) return;
    record.stage = 'dispatched';
    record.targetPeerId = targetPeerId;
    record.error = undefined;
    this.touch(record);
  }

  /**
   * Records that a job with a finished upload was not admitted. Upload
   * failures are already recorded; a retry reuses the uploaded image.
   */
  dispatchFailed(operationId: string, error: unknown): void {
    const record = this.records.get(operationId);
    if (!record || record.imageAssetId === undefined || record.inFlight) return;
    record.stage = 'uploaded';
    record.error = errorText(error);
    this.touch(record);
  }

  /** Lets status waits follow a call's upload and dispatch, not only its upload. */
  attach(operationId: string, job: Promise<unknown>): void {
    const record = this.records.get(operationId);
    if (!record) return;
    record.job = job;
    const release = () => {
      if (record.job === job) record.job = undefined;
    };
    job.then(release, release);
  }

  view(operationId: string): ReferenceUploadView | undefined {
    this.prune();
    const record = this.records.get(operationId);
    return record && this.toView(record);
  }

  /** Resolves once the operation's preparation ends or waitMs passes; never ends the work. */
  async waitForPreparation(operationId: string, waitMs: number, signal?: AbortSignal): Promise<void> {
    const record = this.records.get(operationId);
    const work = record?.job ?? record?.inFlight;
    if (!work || waitMs <= 0 || signal?.aborted) return;
    const { promise: ended, resolve: end } = Promise.withResolvers<void>();
    const timer = setTimeout(end, waitMs);
    const onAbort = () => end();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([work.then(() => undefined, () => undefined), ended]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private matching(operationId: string, identityKey: string, targetPeerId: string): UploadRecord | undefined {
    this.prune();
    const record = this.records.get(operationId);
    if (!record) return undefined;
    // A dispatched generation is bound to its Peer, exactly like the bridge record.
    if (record.identityKey !== identityKey || (record.stage === 'dispatched' && record.targetPeerId !== targetPeerId)) {
      throw new ReferenceUploadError(
        `Request ${operationId} already identifies a different operation; nothing was uploaded or sent`,
        'operation_id_collision',
      );
    }
    return record;
  }

  private run(record: UploadRecord, upload: (progress: ReferenceUploadProgress) => Promise<number>): Promise<number> {
    record.stage = 'uploading';
    record.error = undefined;
    this.touch(record);
    const advance = (phase: UploadPhase) => {
      if (PHASE_ORDER[phase] > PHASE_ORDER[record.phase]) record.phase = phase;
      this.touch(record);
    };
    const progress: ReferenceUploadProgress = {
      sending: () => advance('sending'),
      accepted: (operation) => {
        record.remoteOperation = operation;
        advance('accepted');
      },
      created: (assetId) => {
        record.createdAssetId = assetId;
        advance('created');
      },
    };
    const inFlight = upload(progress).then(
      (imageAssetId) => {
        record.imageAssetId = imageAssetId;
        record.stage = 'uploaded';
        record.inFlight = undefined;
        this.touch(record);
        return imageAssetId;
      },
      (error: unknown) => {
        const failed = createdNothing(error, record.phase);
        record.stage = failed ? 'upload_failed' : 'upload_unknown';
        record.error = errorText(error);
        record.inFlight = undefined;
        this.touch(record);
        throw new ReferenceUploadError(
          failed
            ? `Reference image upload failed: ${record.error}`
            : `Reference image upload for operation ${record.operationId} has an unknown outcome: ${record.error}`,
          failed ? 'reference_upload_failed' : 'reference_upload_unknown',
        );
      },
    );
    record.inFlight = inFlight;
    return inFlight;
  }

  private touch(record: UploadRecord): void {
    record.updatedAt = this.now();
    // Keep records ordered by their latest transition for pruning.
    this.records.delete(record.operationId);
    this.records.set(record.operationId, record);
  }

  private prune(): void {
    const cutoff = this.now() - REFERENCE_UPLOAD_RETENTION_MS;
    for (const [operationId, record] of this.records) {
      if (record.updatedAt >= cutoff) break;
      if (!record.inFlight) this.records.delete(operationId);
    }
    for (const [operationId, record] of this.records) {
      if (this.records.size <= MAX_REFERENCE_UPLOAD_RECORDS) break;
      if (!record.inFlight) this.records.delete(operationId);
    }
  }

  private toView(record: UploadRecord): ReferenceUploadView {
    return {
      stage: record.stage,
      targetPeerId: record.targetPeerId,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.imageAssetId !== undefined ? { imageAssetId: record.imageAssetId } : {}),
      ...(record.createdAssetId !== undefined ? { uploadedAssetId: record.createdAssetId } : {}),
      ...(record.remoteOperation ? { remoteOperation: { ...record.remoteOperation } } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }
}

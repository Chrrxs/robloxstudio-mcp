// Private ClientBroker transport. Only metadata and <=1 MiB data chunks cross
// InvokeClient; callers still receive the original capture-studio response.
const HttpService = game.GetService("HttpService");
const READ_ENDPOINT = "/__mcp/capture-studio/read";
const RELEASE_ENDPOINT = "/__mcp/capture-studio/release";
const CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const MAX_TRANSFERS = 2;
const TRANSFER_TTL_SECONDS = 60;

interface CaptureMetadata {
	success: true;
	encoding: "png" | "rgba8";
	source: "StudioCaptureService";
	width: number;
	height: number;
	nativeWidth: number;
	nativeHeight: number;
}

interface Transfer {
	data?: string;
	offset: number;
	expiresAt: number;
	expiryThread?: thread;
}

type Invoke = (endpoint: string, data: Record<string, unknown>) => unknown;
const transfers = new Map<string, Transfer>();

function integer(value: unknown, min: number, max: number): value is number {
	return typeIs(value, "number") && value >= min && value <= max && value === math.floor(value);
}

function validId(value: unknown): value is string {
	return typeIs(value, "string") && value.size() > 0 && value.size() <= 64;
}

function metadata(value: unknown): CaptureMetadata | undefined {
	if (!typeIs(value, "table")) return undefined;
	const fields = value as Record<string, unknown>;
	if (
		fields.success !== true ||
		(fields.encoding !== "png" && fields.encoding !== "rgba8") ||
		fields.source !== "StudioCaptureService" ||
		!integer(fields.width, 1, 65536) || !integer(fields.height, 1, 65536) ||
		!integer(fields.nativeWidth, 1, 65536) || !integer(fields.nativeHeight, 1, 65536)
	) return undefined;
	return {
		success: true, encoding: fields.encoding, source: fields.source,
		width: fields.width, height: fields.height,
		nativeWidth: fields.nativeWidth, nativeHeight: fields.nativeHeight,
	};
}

function fail(message: string): { success: false; error: string } {
	return { success: false, error: `Capture transfer: ${message}` };
}

function discard(id: string): void {
	const transfer = transfers.get(id);
	if (transfer === undefined) return;
	transfers.delete(id);
	if (transfer.expiryThread !== undefined) task.cancel(transfer.expiryThread);
}

function prune(): void {
	const now = os.clock();
	for (const [id, transfer] of transfers) {
		if (now >= transfer.expiresAt) discard(id);
	}
}

function release(data: Record<string, unknown>): unknown {
	if (!validId(data.transferId)) return fail("invalid transfer ID");
	discard(data.transferId);
	// Idempotent release also negotiates chunk support before capture starts.
	return { success: true, chunkBytes: CHUNK_BYTES };
}

function begin(data: Record<string, unknown>, capture: () => unknown): unknown {
	prune();
	const id = data.transferId;
	// An older server cannot consume chunk descriptors. Let it use legacy
	// capture rather than returning an unsafe inline image or a hard error.
	if (id === undefined) return { unavailable: "Client capture requires bounded transfer support" };
	if (!validId(id)) return fail("invalid transfer ID");
	if (transfers.has(id)) return fail("duplicate transfer ID");
	// Reserve before capture yields: concurrent captures cannot over-admit or
	// evict each other's data. Retained strings are capped at 2 * 64 MiB.
	if (transfers.size() >= MAX_TRANSFERS) return fail("two captures are already in flight; release or await them first");
	const transfer: Transfer = { offset: 0, expiresAt: os.clock() + TRANSFER_TTL_SECONDS };
	transfers.set(id, transfer);
	// Capture only the ID, not the large payload, in the expiry closure.
	transfer.expiryThread = task.delay(TRANSFER_TTL_SECONDS, () => {
		const current = transfers.get(id);
		if (current !== undefined && os.clock() >= current.expiresAt) {
			current.expiryThread = undefined;
			discard(id);
		}
	});
	const [ok, result] = pcall(capture);
	if (!ok) {
		if (transfers.get(id) === transfer) discard(id);
		return fail(`capture failed: ${tostring(result)}`);
	}
	if (transfers.get(id) !== transfer || os.clock() >= transfer.expiresAt) {
		if (transfers.get(id) === transfer) discard(id);
		return fail("capture expired before it completed");
	}
	const info = metadata(result);
	if (info === undefined) {
		discard(id);
		// Unavailability must reach core unchanged to preserve legacy fallback.
		if (typeIs(result, "table")) {
			const fields = result as Record<string, unknown>;
			if (typeIs(fields.unavailable, "string")) return { unavailable: fields.unavailable.sub(1, 4096) };
			if (typeIs(fields.error, "string")) return fail(fields.error.sub(1, 4096));
		}
		return fail("invalid capture response");
	}
	const fields = result as Record<string, unknown>;
	const pixels = fields.data;
	if (!typeIs(pixels, "string") || !validSize(pixels.size(), info)) {
		discard(id);
		return fail("invalid or oversized capture data");
	}
	transfer.data = pixels;
	return {
		transferId: id, totalBytes: pixels.size(), chunkBytes: CHUNK_BYTES,
		metadata: info,
	};
}

function validSize(size: unknown, info: CaptureMetadata): size is number {
	if (!integer(size, 4, MAX_TRANSFER_BYTES) || size % 4 !== 0) return false;
	return info.encoding !== "rgba8" || size === math.ceil(info.width * info.height * 4 / 3) * 4;
}

function read(data: Record<string, unknown>): unknown {
	prune();
	const id = data.transferId;
	if (!validId(id)) return fail("invalid transfer ID");
	const transfer = transfers.get(id);
	if (transfer === undefined) return fail("unknown or expired transfer");
	const pixels = transfer.data;
	const offset = data.offset;
	const length = data.length;
	if (
		pixels === undefined || !integer(offset, 0, pixels.size() - 1) ||
		!integer(length, 1, CHUNK_BYTES) || offset !== transfer.offset ||
		length !== math.min(CHUNK_BYTES, pixels.size() - offset)
	) {
		discard(id);
		return fail("invalid chunk offset or length");
	}
	const chunk = pixels.sub(offset + 1, offset + length);
	transfer.offset += length;
	// Last read releases immediately, even if the receiver disappears before
	// its explicit release. Explicit release is idempotent for error paths.
	if (transfer.offset === pixels.size()) discard(id);
	return { transferId: id, offset, data: chunk };
}

function receive(invoke: Invoke, data: Record<string, unknown>): unknown {
	const id = HttpService.GenerateGUID(false);
	const [ok, result] = pcall(() => {
		// Older clients return inline data and may disconnect on a large capture.
		// Probe a harmless release of our fresh ID before requesting any pixels.
		const probe = invoke(RELEASE_ENDPOINT, { transferId: id });
		if (!typeIs(probe, "table")) return { unavailable: "Client capture lacks bounded transfer support" };
		const capability = probe as Record<string, unknown>;
		if (capability.success !== true || capability.chunkBytes !== CHUNK_BYTES) {
			return { unavailable: "Client capture lacks bounded transfer support" };
		}
		const response = invoke("/api/capture-studio", { encoding: data.encoding, transferId: id });
		if (!typeIs(response, "table")) error("invalid transfer response");
		const fields = response as Record<string, unknown>;
		if (typeIs(fields.unavailable, "string")) return { unavailable: fields.unavailable.sub(1, 4096) };
		if (typeIs(fields.error, "string")) error(fields.error.sub(1, 4096));
		const info = metadata(fields.metadata);
		if (info === undefined || fields.transferId !== id || fields.chunkBytes !== CHUNK_BYTES || !validSize(fields.totalBytes, info)) {
			error("invalid transfer metadata or size");
		}
		const size = fields.totalBytes;
		const chunks: string[] = [];
		let offset = 0;
		while (offset < size) {
			const length = math.min(CHUNK_BYTES, size - offset);
			const response = invoke(READ_ENDPOINT, { transferId: id, offset, length });
			if (!typeIs(response, "table")) error("invalid chunk response");
			const chunk = response as Record<string, unknown>;
			if (typeIs(chunk.error, "string")) error(chunk.error.sub(1, 4096));
			if (chunk.transferId !== id || chunk.offset !== offset || !typeIs(chunk.data, "string") || chunk.data.size() !== length) {
				error("chunk ID, offset or length mismatch");
			}
			chunks.push(chunk.data);
			offset += length;
		}
		return {
			success: true, encoding: info.encoding, source: info.source,
			width: info.width, height: info.height,
			nativeWidth: info.nativeWidth, nativeHeight: info.nativeHeight,
			data: chunks.join(""),
		};
	});
	// The final read already frees successful transfers. Cleanup is best-effort:
	// it must not mask an unavailable signal from an older client or a completed
	// image. Failed partial transfers also have the bounded expiry above.
	pcall(() => invoke(RELEASE_ENDPOINT, { transferId: id }));
	if (!ok) return fail(tostring(result));
	return result;
}

export = { READ_ENDPOINT, RELEASE_ENDPOINT, begin, read, release, receive };

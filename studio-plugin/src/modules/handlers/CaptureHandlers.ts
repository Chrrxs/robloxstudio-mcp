import * as RenderMonitor from "../RenderMonitor";

const CaptureService = game.GetService("CaptureService");
const AssetService = game.GetService("AssetService");
const Workspace = game.GetService("Workspace");

const MAX_TILE_SIZE = 1024;
const MAX_RAW_PIXEL_BYTES = 36 * 1024 * 1024;
const MAX_CREATED_IMAGE_DIM = 2048;
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD_BYTE = string.byte("=")[0];

// StudioCaptureService (Studio-only, PluginSecurity) is the fast path: it hands
// back the framebuffer directly, so it needs neither CaptureService's
// asynchronous callback nor an EditableImage round-trip — and it captures at
// ViewportSize, which is exactly the coordinate space simulate_mouse_input
// expects. It is gated behind Studio FFlags and is missing from @rbxts/types,
// hence the local structural declarations below.
interface CaptureEnumItem {
	readonly Name: string;
}

interface StudioScreenshotOptions {
	OutputSize: Vector2;
	ResampleMode: Enum.ResamplerMode;
	Position?: Vector2;
	Format?: CaptureEnumItem;
	UICaptureMode?: Enum.UICaptureMode;
}

interface StudioScreenshotCapture {
	readonly BufferStatus: CaptureEnumItem;
	readonly BufferFormat: CaptureEnumItem;
	readonly OriginalSize: Vector2;
	readonly Resolution: Vector2;
	GetBuffer(this: StudioScreenshotCapture): buffer;
	GetErrors(this: StudioScreenshotCapture): unknown[];
}

interface StudioCaptureServiceLike {
	CanCaptureScreenshot(this: StudioCaptureServiceLike): boolean;
	CaptureScreenshot(
		this: StudioCaptureServiceLike,
		options: StudioScreenshotOptions,
	): StudioScreenshotCapture | undefined;
}

// Unchecked cast, single reason: these enums exist in Studio but are missing
// from @rbxts/types, so the global Enum table has to be read dynamically.
const ENUM_TABLE = Enum as unknown as Record<string, Record<string, CaptureEnumItem> | undefined>;
const STUDIO_CAPTURE_FORMATS = ENUM_TABLE.StudioCaptureScreenshotFormat;

// Measured on a 1980x1032 viewport: RGBA8 completes in ~0.16s and PNG in ~1s.
// A capture that is still Pending well past that never completes (it happens
// while a playtest owns the renderer), so we stop waiting and let the caller
// fall back instead of stalling the tool call.
const STUDIO_CAPTURE_TIMEOUT = 3;

const B64: number[] = [];
for (let i = 0; i < 64; i++) {
	B64[i] = string.byte(BASE64_CHARS, i + 1)[0];
}

function encodeBase64(buf: buffer): string {
	const len = buffer.len(buf);
	const fullTriples = math.floor(len / 3);
	const remaining = len - fullTriples * 3;
	const outLen = (fullTriples + (remaining > 0 ? 1 : 0)) * 4;
	const out = buffer.create(outLen);

	let si = 0;
	let di = 0;

	for (let t = 0; t < fullTriples; t++) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		const b2 = buffer.readu8(buf, si + 2);

		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.bor(bit32.lshift(bit32.band(b1, 15), 2), bit32.rshift(b2, 6))]);
		buffer.writeu8(out, di + 3, B64[bit32.band(b2, 63)]);

		si += 3;
		di += 4;
	}

	if (remaining === 2) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.lshift(bit32.band(b1, 15), 2)]);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	} else if (remaining === 1) {
		const b0 = buffer.readu8(buf, si);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.lshift(bit32.band(b0, 3), 4)]);
		buffer.writeu8(out, di + 2, PAD_BYTE);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	}

	return buffer.tostring(out);
}

function readPixelsTiled(img: EditableImage, w: number, h: number): buffer {
	const BYTES_PER_PIXEL = 4;
	const fullBuf = buffer.create(w * h * BYTES_PER_PIXEL);
	const fullRowBytes = w * BYTES_PER_PIXEL;

	for (let ty = 0; ty < h; ty += MAX_TILE_SIZE) {
		const tileH = math.min(MAX_TILE_SIZE, h - ty);
		for (let tx = 0; tx < w; tx += MAX_TILE_SIZE) {
			const tileW = math.min(MAX_TILE_SIZE, w - tx);
			const tileBuf = img.ReadPixelsBuffer(new Vector2(tx, ty), new Vector2(tileW, tileH));
			const tileRowBytes = tileW * BYTES_PER_PIXEL;
			for (let row = 0; row < tileH; row++) {
				buffer.copy(fullBuf, (ty + row) * fullRowBytes + tx * BYTES_PER_PIXEL, tileBuf, row * tileRowBytes, tileRowBytes);
			}
		}
	}
	return fullBuf;
}

// Triggers CaptureService:CaptureScreenshot and waits for the temporary
// content id. Works in any DM, including the play CLIENT (where reading the
// pixels back is blocked, but capturing is not). The returned rbxtemp:// id is
// a process-scoped handle: it can be dereferenced from a DIFFERENT, more
// privileged DM (the edit DM) — see captureRead.
function doCaptureScreenshot(): { contentId: string } | { error: string } {
	// Fast-fail with a clear reason if the window isn't rendering — otherwise
	// CaptureScreenshot's callback never fires and we'd block for the full 10s.
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined) return { error: notRendering };

	let contentId: string | undefined;

	CaptureService.CaptureScreenshot((id: string) => {
		contentId = id;
	});

	const startTime = tick();
	while (contentId === undefined) {
		if (tick() - startTime > 10) {
			return {
				error: "Screenshot capture timed out (CaptureScreenshot callback never fired). The Studio window is likely minimized or occluded — restore it so the viewport renders. (Known Roblox bug: capture can also fail if the viewport renders a solid color.)",
			};
		}
		task.wait(0.1);
	}

	return { contentId };
}

// Promotes a CaptureScreenshot content id into an EditableImage and reads its
// RGBA pixels. MUST run in the edit/plugin context: the running game VM lacks
// the privilege to create an EditableImage from a temporary texture id (errors
// "cannot currently create editable image from temporary texture id"), while
// the edit DM can — even for an id captured in the play client DM.
function readContentToBase64(contentId: string): unknown {
	const [editableOk, editableResult] = pcall(() => {
		return AssetService.CreateEditableImageAsync(Content.fromUri(contentId));
	});

	if (!editableOk) {
		return {
			error: `Failed to create EditableImage from screenshot. Enable EditableImage API: Game Settings > Security > 'Allow Mesh / Image APIs'. (${tostring(editableResult)})`,
		};
	}

	let sourceImage = editableResult as EditableImage;
	const imgSize = sourceImage.Size;
	const nativeW = math.floor(imgSize.X);
	const nativeH = math.floor(imgSize.Y);
	let w = nativeW;
	let h = nativeH;

	if (nativeW * nativeH * 4 > MAX_RAW_PIXEL_BYTES) {
		const scale = math.min(
			math.sqrt(MAX_RAW_PIXEL_BYTES / (nativeW * nativeH * 4)),
			MAX_CREATED_IMAGE_DIM / math.max(nativeW, nativeH),
		);
		w = math.max(1, math.floor(nativeW * scale));
		h = math.max(1, math.floor(nativeH * scale));
		const [scaleOk, scaledResult] = pcall(() => {
			const target = AssetService.CreateEditableImage({ Size: new Vector2(w, h) });
			target.DrawImageTransformed(new Vector2(0, 0), new Vector2(w / nativeW, h / nativeH), 0, sourceImage, {
				CombineType: Enum.ImageCombineType.AlphaBlend,
				SamplingMode: Enum.ResamplerMode.Default,
				PivotPoint: new Vector2(0, 0),
			});
			return target;
		});
		sourceImage.Destroy();
		if (!scaleOk) {
			return {
				error: `Screenshot is ${nativeW}x${nativeH} (too large to transfer raw) and downscaling failed: ${tostring(scaledResult)}`,
			};
		}
		sourceImage = scaledResult as EditableImage;
	}

	const [readOk, pixelBuffer] = pcall(() => {
		return readPixelsTiled(sourceImage, w, h);
	});

	sourceImage.Destroy();

	if (!readOk) {
		return { error: `Failed to read pixel data: ${tostring(pixelBuffer)}` };
	}

	const base64Data = encodeBase64(pixelBuffer as buffer);

	return { success: true, width: w, height: h, data: base64Data, nativeWidth: nativeW, nativeHeight: nativeH };
}

let cachedStudioService: StudioCaptureServiceLike | undefined;

function getStudioCaptureService(): StudioCaptureServiceLike | undefined {
	if (cachedStudioService !== undefined) return cachedStudioService;
	// Unchecked cast, single reason: StudioCaptureService is absent from
	// @rbxts/types, so GetService cannot be called through the typed overload.
	const dynamicGame = game as unknown as { GetService(name: string): unknown };
	const [ok, service] = pcall(() => dynamicGame.GetService("StudioCaptureService"));
	if (!ok || service === undefined) return undefined;
	cachedStudioService = service as StudioCaptureServiceLike;
	return cachedStudioService;
}

// Captures through StudioCaptureService. Returns undefined when the service
// cannot capture right now (missing FFlag, permission not granted, or this
// DataModel is not the active one) so the caller can fall back to the
// CaptureService + EditableImage path.
function doStudioCapture(wantPng: boolean): unknown | undefined {
	if (STUDIO_CAPTURE_FORMATS === undefined) return undefined;

	const service = getStudioCaptureService();
	if (service === undefined) return undefined;

	const [canOk, can] = pcall(() => service.CanCaptureScreenshot());
	if (!canOk || can !== true) return undefined;

	const camera = Workspace.CurrentCamera;
	if (camera === undefined) return undefined;

	const viewport = camera.ViewportSize;
	const nativeW = math.max(1, math.floor(viewport.X));
	const nativeH = math.max(1, math.floor(viewport.Y));
	let w = nativeW;
	let h = nativeH;

	// Raw RGBA rides back base64-encoded, so an oversized viewport is
	// downscaled by the engine during the capture itself — no second pass.
	if (!wantPng && nativeW * nativeH * 4 > MAX_RAW_PIXEL_BYTES) {
		const scale = math.sqrt(MAX_RAW_PIXEL_BYTES / (nativeW * nativeH * 4));
		w = math.max(1, math.floor(nativeW * scale));
		h = math.max(1, math.floor(nativeH * scale));
	}

	// CaptureSize is a framebuffer crop, not the logical viewport size. At
	// fractional display scaling it cuts off the right/bottom of the frame.
	const options: StudioScreenshotOptions = {
		OutputSize: new Vector2(w, h),
		ResampleMode: Enum.ResamplerMode.Default,
		Format: wantPng ? STUDIO_CAPTURE_FORMATS.PNG : STUDIO_CAPTURE_FORMATS.RGBA8,
	};

	const [captureOk, captureResult] = pcall(() => service.CaptureScreenshot(options));
	if (!captureOk) return { error: `StudioCaptureService:CaptureScreenshot failed: ${tostring(captureResult)}` };
	if (captureResult === undefined) return undefined;

	const capture = captureResult;
	const startTime = tick();
	while (capture.BufferStatus.Name === "Pending" || capture.BufferStatus.Name === "NotStarted") {
		if (tick() - startTime > STUDIO_CAPTURE_TIMEOUT) return undefined;
		task.wait(0.02);
	}

	if (capture.BufferStatus.Name !== "Ready") {
		const [errorsOk, errors] = pcall(() => capture.GetErrors());
		const detail = errorsOk ? game.GetService("HttpService").JSONEncode(errors) : "unavailable";
		return { error: `StudioCaptureService capture failed (status ${capture.BufferStatus.Name}): ${detail}` };
	}

	const [bufferOk, captureBuffer] = pcall(() => capture.GetBuffer());
	if (!bufferOk) return { error: `StudioCaptureService:GetBuffer failed: ${tostring(captureBuffer)}` };

	const resolution = capture.Resolution;
	return {
		success: true,
		encoding: wantPng ? "png" : "rgba8",
		source: "StudioCaptureService",
		width: math.max(1, math.floor(resolution.X)),
		height: math.max(1, math.floor(resolution.Y)),
		nativeWidth: nativeW,
		nativeHeight: nativeH,
		data: encodeBase64(captureBuffer as buffer),
	};
}

// Studio-only capture endpoint. Reports `unavailable` (instead of an error) so
// the server can fall back to the legacy CaptureService path.
function captureStudio(requestData: Record<string, unknown>): unknown {
	const wantPng = requestData.encoding === "png";
	const result = doStudioCapture(wantPng);
	if (result === undefined) {
		return { unavailable: "StudioCaptureService cannot capture this DataModel right now" };
	}
	return result;
}

// Edit-mode single shot: capture and read back in the same (edit) context.
function captureScreenshotData(): unknown {
	const cap = doCaptureScreenshot();
	if ("error" in cap) return cap;
	return readContentToBase64(cap.contentId);
}

function captureScreenshot(): unknown {
	return captureScreenshotData();
}

// Play-mode step 1 (run on the CLIENT): capture only, return the temp id.
function captureBegin(): unknown {
	return doCaptureScreenshot();
}

// Play-mode step 2 (run on EDIT): read pixels from a temp id captured elsewhere.
function captureRead(requestData: Record<string, unknown>): unknown {
	const contentId = requestData.contentId as string | undefined;
	if (!contentId) return { error: "contentId is required" };
	return readContentToBase64(contentId);
}

export = {
	captureScreenshotData,
	captureScreenshot,
	captureStudio,
	captureBegin,
	captureRead,
};

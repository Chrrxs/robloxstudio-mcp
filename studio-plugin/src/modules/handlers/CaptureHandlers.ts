import * as RenderMonitor from "../RenderMonitor";

const CaptureService = game.GetService("CaptureService");
const AssetService = game.GetService("AssetService");
const Workspace = game.GetService("Workspace");
const CoreGui = game.GetService("CoreGui");
const RunService = game.GetService("RunService");

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
		// Lead with Roblox's own message: the Game Settings toggle is only one of
		// the reasons this can fail (temporary-texture privilege and multiplayer
		// client handles are others), and telling someone who already enabled
		// it to enable it again is a dead end.
		return {
			error:
				`Failed to create EditableImage from screenshot: ${tostring(editableResult)}. ` +
				"If that mentions permissions, check Game Settings > Security > 'Allow Mesh / Image APIs'.",
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

// Viewport corner markers for the host-side window capture fallback.
//
// Roblox's own capture APIs can be unavailable for the play viewport:
// StudioCaptureService reports CanCaptureScreenshot() == false in the play
// client (RequestScreenshotPermissionAsync raises "Feature not supported
// yet"), and CaptureService:CaptureScreenshot hands back a fully black frame
// there on some Studio builds (observed with the Vulkan renderer). When that
// happens the MCP server grabs the whole Studio window through the host OS
// instead and needs to know where the 3D viewport sits inside that window.
// Four small magenta squares pinned to the viewport corners give it an exact,
// DPI-independent answer; the server hides them again before the real capture.
const MARKER_GUI_NAME = "__MCPCaptureMarkers";
const MARKER_SIZE = 12;
const MARKER_COLOR = Color3.fromRGB(255, 0, 255);
// Safety net: the server always hides the markers itself, but if it dies
// mid-capture the viewport must not stay decorated.
const MARKER_AUTO_HIDE_SECONDS = 15;
const MARKER_RENDER_FRAMES = 3;
const MARKER_RENDER_TIMEOUT = 2;

function viewportSize(): { viewportWidth: number; viewportHeight: number } | undefined {
	const camera = Workspace.CurrentCamera;
	if (camera === undefined) return undefined;
	const viewport = camera.ViewportSize;
	return {
		viewportWidth: math.max(1, math.floor(viewport.X)),
		viewportHeight: math.max(1, math.floor(viewport.Y)),
	};
}

function hideMarkers(): void {
	const existing = CoreGui.FindFirstChild(MARKER_GUI_NAME);
	if (existing !== undefined) existing.Destroy();
}

// Blocks until the markers have been composited into a few rendered frames
// (bounded, so a non-rendering window cannot hang the request).
function waitForRenderedFrames(): number {
	let frames = 0;
	const [ok, connection] = pcall(() => RunService.RenderStepped.Connect(() => { frames++; }));
	if (!ok) return 0;
	const start = os.clock();
	while (frames < MARKER_RENDER_FRAMES && os.clock() - start < MARKER_RENDER_TIMEOUT) task.wait(0.03);
	(connection as RBXScriptConnection).Disconnect();
	return frames;
}

function showMarkers(): unknown {
	hideMarkers();
	const size = viewportSize();
	if (size === undefined) return { error: "No CurrentCamera; cannot place viewport markers." };

	const gui = new Instance("ScreenGui");
	gui.Name = MARKER_GUI_NAME;
	gui.IgnoreGuiInset = true;
	gui.ScreenInsets = Enum.ScreenInsets.None;
	gui.DisplayOrder = 2147483647;
	gui.ResetOnSpawn = false;
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Global;

	const corners: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];
	for (const [x, y] of corners) {
		const frame = new Instance("Frame");
		frame.Name = `Corner${x}${y}`;
		frame.AnchorPoint = new Vector2(x, y);
		frame.Position = UDim2.fromScale(x, y);
		frame.Size = UDim2.fromOffset(MARKER_SIZE, MARKER_SIZE);
		frame.BackgroundColor3 = MARKER_COLOR;
		frame.BackgroundTransparency = 0;
		frame.BorderSizePixel = 0;
		frame.ZIndex = 2147483647;
		frame.Parent = gui;
	}
	gui.Parent = CoreGui;

	task.delay(MARKER_AUTO_HIDE_SECONDS, () => {
		if (gui.Parent !== undefined) gui.Destroy();
	});

	const framesRendered = waitForRenderedFrames();
	return { success: true, ...size, markerSize: MARKER_SIZE, framesRendered };
}

// Host-capture support endpoint. action="show" draws the corner markers and
// reports the viewport size, "hide" removes them, "query" only reports the
// viewport size (used when the server already knows where the viewport is).
function captureMarkers(requestData: Record<string, unknown>): unknown {
	const action = requestData.action;
	if (action === "show") return showMarkers();
	if (action === "hide") {
		hideMarkers();
		return { success: true };
	}
	if (action === "query") {
		const size = viewportSize();
		if (size === undefined) return { error: "No CurrentCamera; cannot read viewport size." };
		return { success: true, ...size, markerSize: MARKER_SIZE };
	}
	return { error: `capture-markers action must be "show", "hide" or "query" (got ${tostring(action)})` };
}

export = {
	captureScreenshotData,
	captureScreenshot,
	captureStudio,
	captureBegin,
	captureRead,
	captureMarkers,
};

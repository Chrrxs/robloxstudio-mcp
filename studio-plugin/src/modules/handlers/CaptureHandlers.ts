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

// Studio exposes this API at runtime, but the installed @rbxts/types predates it.
interface StudioDeviceSimulatorServiceLike {
	GetDeviceAsync(this: StudioDeviceSimulatorServiceLike): string;
	GetScalingModeAsync(this: StudioDeviceSimulatorServiceLike): CaptureEnumItem;
	SetScalingModeAsync(this: StudioDeviceSimulatorServiceLike, scalingMode: CaptureEnumItem): void;
}

// Unchecked cast, single reason: these enums exist in Studio but are missing
// from @rbxts/types, so the global Enum table has to be read dynamically.
const ENUM_TABLE = Enum as unknown as Record<string, Record<string, CaptureEnumItem> | undefined>;
const STUDIO_CAPTURE_FORMATS = ENUM_TABLE.StudioCaptureScreenshotFormat;
const FIT_TO_WINDOW = ENUM_TABLE.DeviceSimulatorScalingMode?.FitToWindow;

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
	return withViewportRead(captureScreenshotFrame);
}

function captureScreenshotFrame(): { contentId: string } | { error: string } {
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
	return withViewportRead(() => captureStudioFrame(wantPng));
}

function captureStudioFrame(wantPng: boolean): unknown | undefined {
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
const CAPTURE_AUTO_FINISH_SECONDS = 60;
const VIEWPORT_ACQUIRE_TIMEOUT = 25;

interface MarkerCaptureTransaction {
	readonly captureId: string;
	simulator?: StudioDeviceSimulatorServiceLike;
	deviceId?: string;
	scalingMode?: CaptureEnumItem;
	restorePending: boolean;
	busy: boolean;
	expired: boolean;
}

type MarkerFinishResult =
	| { success: true; captureId: string; stale?: true }
	| { error: string; captureId: string };

let activeMarkerCapture: MarkerCaptureTransaction | undefined;
let activeViewportReads = 0;

function withViewportRead<T>(readFrame: () => T): T | { error: string } {
	const start = os.clock();
	while (activeMarkerCapture !== undefined) {
		if (os.clock() - start >= VIEWPORT_ACQUIRE_TIMEOUT) {
			return { error: "Timed out waiting for the active host capture to restore the viewport; retry capture." };
		}
		task.wait(0.03);
	}
	// No yield between observing the writer and acquiring this reader.
	activeViewportReads++;
	const [ok, result] = pcall(readFrame);
	activeViewportReads--;
	if (!ok) return { error: `Viewport capture failed: ${tostring(result)}` };
	return result;
}

function markerAccessError(action: unknown, captureId: unknown): string | undefined {
	const capture = activeMarkerCapture;
	if (captureId !== undefined) {
		if (!typeIs(captureId, "string") || captureId === "") return "A non-empty captureId is required.";
		if (capture === undefined || capture.captureId !== captureId || capture.expired) {
			return "The host capture token is stale or expired; discard this capture and prepare a new transaction.";
		}
		if (capture.busy) return "The host capture is still preparing or restoring; retry after that operation completes.";
	} else if (capture !== undefined && (action === "show" || action === "hide")) {
		return "An active host capture owns the viewport markers; supply its captureId.";
	}
	return undefined;
}

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

function finishMarkerCapture(captureId: string): MarkerFinishResult {
	const capture = activeMarkerCapture;
	// A delayed retry or safety callback must never touch another capture's GUI.
	if (capture === undefined || capture.captureId !== captureId) {
		return { success: true, captureId, stale: true };
	}
	if (capture.busy) return { error: "Host capture is still preparing or restoring; retry finish with the same captureId.", captureId };

	capture.busy = true;
	const [ok, failure] = pcall(() => {
		hideMarkers();
		const simulator = capture.simulator;
		const originalMode = capture.scalingMode;
		if (capture.restorePending && simulator !== undefined && originalMode !== undefined) {
			// Never switch devices or overwrite a mode the user changed mid-capture.
			if (simulator.GetDeviceAsync() === capture.deviceId
				&& simulator.GetScalingModeAsync() === FIT_TO_WINDOW
				&& simulator.GetDeviceAsync() === capture.deviceId) {
				simulator.SetScalingModeAsync(originalMode);
				// A minimized window may not render; the restored mode still releases
				// the transaction so the next capture can proceed when it is visible.
				waitForRenderedFrames();
			}
			capture.restorePending = false;
		}
	});
	capture.busy = false;
	if (!ok) {
		return {
			error: `Could not finish host capture or restore device scaling: ${tostring(failure)} Retry finish with captureId ${captureId}, or restore the simulator scaling mode manually.`,
			captureId,
		};
	}
	activeMarkerCapture = undefined;
	return { success: true, captureId };
}

function prepareMarkerCapture(): unknown {
	const start = os.clock();
	while (activeMarkerCapture !== undefined || activeViewportReads > 0) {
		if (os.clock() - start >= VIEWPORT_ACQUIRE_TIMEOUT) {
			return { error: "Timed out waiting for another viewport capture to finish; retry host capture." };
		}
		task.wait(0.03);
	}
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined) return { error: notRendering };
	const size = viewportSize();
	if (size === undefined) return { error: "No CurrentCamera; cannot prepare host capture." };
	const capture: MarkerCaptureTransaction = {
		captureId: game.GetService("HttpService").GenerateGUID(false),
		restorePending: false,
		busy: true,
		expired: false,
	};
	activeMarkerCapture = capture;
	task.delay(CAPTURE_AUTO_FINISH_SECONDS, () => {
		if (activeMarkerCapture !== capture) return;
		capture.expired = true;
		// A yielding prepare owns the state until it resumes and rolls back.
		if (capture.busy) return;
		const result = finishMarkerCapture(capture.captureId);
		if ("error" in result) warn(result.error);
	});

	const [ok, failure] = pcall(() => {
		// Unchecked cast: the live simulator service is missing from this SDK's
		// GetService overloads; the structural return type describes only APIs used here.
		const dynamicGame = game as unknown as { GetService(name: string): StudioDeviceSimulatorServiceLike };
		const simulator = dynamicGame.GetService("StudioDeviceSimulatorService");
		capture.simulator = simulator;
		capture.deviceId = simulator.GetDeviceAsync();
		if (capture.deviceId === "default") return;
		if (FIT_TO_WINDOW === undefined) {
			error("Studio does not expose DeviceSimulatorScalingMode.FitToWindow; update Studio before capturing a simulated viewport.");
		}
		const scalingMode = simulator.GetScalingModeAsync();
		capture.scalingMode = scalingMode;
		if (scalingMode === FIT_TO_WINDOW) return;
		if (simulator.GetScalingModeAsync() !== scalingMode || simulator.GetDeviceAsync() !== capture.deviceId) {
			error("The simulated device or scaling mode changed while preparing host capture; retry after the device settles.");
		}
		if (capture.expired) error("Host capture preparation expired.");
		// Set before the yielding setter: a setter failure can still have changed Studio.
		capture.restorePending = true;
		simulator.SetScalingModeAsync(FIT_TO_WINDOW);
		if (waitForRenderedFrames() < MARKER_RENDER_FRAMES) {
			error(RenderMonitor.notRenderingReason() ?? "The fitted viewport did not render in time; restore the Studio window and retry.");
		}
		if (simulator.GetDeviceAsync() !== capture.deviceId
			|| simulator.GetScalingModeAsync() !== FIT_TO_WINDOW) {
			error("The simulated device or scaling mode changed while fitting the viewport; retry after the device settles.");
		}
	});
	capture.busy = false;
	if (!ok || capture.expired) {
		const restored = finishMarkerCapture(capture.captureId);
		const detail = ok ? "Host capture preparation expired." : tostring(failure);
		return {
			error: `Could not prepare host capture: ${detail}${"error" in restored ? ` ${restored.error}` : ""}`,
			captureId: capture.captureId,
		};
	}
	// Fitting can round 1200 logical pixels to 1199: keep the pre-fit dimensions
	// for the server's final image, while show/query report the actual fitted camera.
	return { success: true, captureId: capture.captureId, viewportChanged: capture.restorePending, ...size };
}

function showMarkers(captureId: unknown): unknown {
	hideMarkers();
	const size = viewportSize();
	if (size === undefined) return { error: "No CurrentCamera; cannot place viewport markers." };

	const gui = new Instance("ScreenGui");
	gui.Name = MARKER_GUI_NAME;
	gui.IgnoreGuiInset = true;
	// Camera.ViewportSize reports the device safe area, so markers must bound it too.
	gui.ScreenInsets = Enum.ScreenInsets.DeviceSafeInsets;
	gui.SafeAreaCompatibility = Enum.SafeAreaCompatibility.None;
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
	const accessError = markerAccessError("show", captureId);
	if (accessError !== undefined) {
		gui.Destroy();
		return { error: accessError };
	}
	const renderedSize = viewportSize();
	if (renderedSize === undefined) {
		gui.Destroy();
		return { error: "No CurrentCamera after rendering viewport markers." };
	}
	return { success: true, ...renderedSize, markerSize: MARKER_SIZE, framesRendered };
}

// prepare temporarily fits a simulated viewport; finish restores it after the
// clean host grab. hide only removes markers: restoring here would clip that grab.
// show/query report the current camera dimensions, not prepare's original size.
function captureMarkers(requestData: Record<string, unknown>): unknown {
	const action = requestData.action;
	if (action === "prepare") return prepareMarkerCapture();
	if (action === "finish") {
		const captureId = requestData.captureId;
		if (!typeIs(captureId, "string") || captureId === "") {
			return { error: 'capture-markers action "finish" requires a non-empty captureId.' };
		}
		return finishMarkerCapture(captureId);
	}
	if (action === "show" || action === "hide" || action === "query") {
		const accessError = markerAccessError(action, requestData.captureId);
		if (accessError !== undefined) return { error: accessError };
	}
	if (action === "show") return showMarkers(requestData.captureId);
	if (action === "hide") {
		hideMarkers();
		return { success: true };
	}
	if (action === "query") {
		const size = viewportSize();
		if (size === undefined) return { error: "No CurrentCamera; cannot read viewport size." };
		return { success: true, ...size, markerSize: MARKER_SIZE };
	}
	return { error: `capture-markers action must be "prepare", "finish", "show", "hide" or "query" (got ${tostring(action)})` };
}

export = {
	captureScreenshotData,
	captureScreenshot,
	captureStudio,
	captureBegin,
	captureRead,
	captureMarkers,
};

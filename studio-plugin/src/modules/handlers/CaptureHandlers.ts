import * as RenderMonitor from "../RenderMonitor";

const CaptureService = game.GetService("CaptureService");
const AssetService = game.GetService("AssetService");

const MAX_TILE_SIZE = 1024;
const MAX_RAW_PIXEL_BYTES = 36 * 1024 * 1024;
const MAX_CREATED_IMAGE_DIM = 2048;
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD_BYTE = string.byte("=")[0];

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
	captureBegin,
	captureRead,
};

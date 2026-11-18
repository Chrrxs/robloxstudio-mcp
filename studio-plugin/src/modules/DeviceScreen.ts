// Under Studio's Device Simulator, Camera.ViewportSize is only the device safe
// area, while VirtualInput reads positions in full device-screen pixels (safe
// area insets included). Screenshots must be returned in that full-screen
// grid, and how each capture path renders the screen differs (StudioCapture
// squeezes it into the viewport size, CaptureService returns it unsqueezed at
// a smaller scale), so captures report the full screen size and the server
// resamples to it. Without the simulator both sizes match.

export interface ScreenScale {
	readonly x: number;
	readonly y: number;
}

export interface ScreenSize {
	readonly width: number;
	readonly height: number;
}

export const IDENTITY_SCALE: ScreenScale = { x: 1, y: 1 };

const PROBE_GUI_NAME = "__MCPScreenProbe";
// A freshly parented frame normally has its layout on first read; if not, a
// few frames settle it. Bounded so a stalled window cannot hang input.
const PROBE_LAYOUT_TIMEOUT = 0.5;

// Sub-pixel differences are rounding between the camera and the GUI layout.
export function axisScale(fullSize: number, viewportSize: number): number {
	if (!(fullSize > 0) || !(viewportSize > 0)) return 1;
	if (math.abs(fullSize - viewportSize) < 1) return 1;
	return fullSize / viewportSize;
}

export function screenScale(full: ScreenSize | undefined, viewport: ScreenSize | undefined): ScreenScale {
	if (full === undefined || viewport === undefined) return IDENTITY_SCALE;
	return { x: axisScale(full.width, viewport.width), y: axisScale(full.height, viewport.height) };
}

export function isScaled(scale: ScreenScale): boolean {
	return scale.x !== 1 || scale.y !== 1;
}

export function viewportSize(): ScreenSize | undefined {
	const camera = game.GetService("Workspace").CurrentCamera;
	if (camera === undefined) return undefined;
	const size = camera.ViewportSize;
	return { width: size.X, height: size.Y };
}

// Size of a full-screen frame that ignores both the top bar inset and the
// device safe area insets: the space VirtualInput positions are read in.
export function fullScreenSize(): ScreenSize | undefined {
	const probe = new Instance("ScreenGui");
	const [ok, measured] = pcall(() => {
		probe.Name = PROBE_GUI_NAME;
		probe.IgnoreGuiInset = true;
		probe.ScreenInsets = Enum.ScreenInsets.None;
		probe.SafeAreaCompatibility = Enum.SafeAreaCompatibility.None;
		probe.ResetOnSpawn = false;
		const frame = new Instance("Frame");
		frame.Size = UDim2.fromScale(1, 1);
		frame.BackgroundTransparency = 1;
		frame.Parent = probe;
		probe.Parent = game.GetService("CoreGui");
		let size = frame.AbsoluteSize;
		const start = os.clock();
		while ((size.X <= 0 || size.Y <= 0) && os.clock() - start < PROBE_LAYOUT_TIMEOUT) {
			game.GetService("RunService").Heartbeat.Wait();
			size = frame.AbsoluteSize;
		}
		return size;
	});
	probe.Destroy();
	if (!ok || measured.X <= 0 || measured.Y <= 0) return undefined;
	return { width: measured.X, height: measured.Y };
}

export function measureScreenScale(): ScreenScale {
	const viewport = viewportSize();
	if (viewport === undefined) return IDENTITY_SCALE;
	return screenScale(fullScreenSize(), viewport);
}

export function isDeviceSimulating(): boolean {
	const [ok, device] = pcall(() => game.GetService("StudioDeviceSimulatorService").GetDeviceAsync());
	return ok && typeIs(device, "string") && device !== "default";
}

// The full device screen, only when it differs from the viewport; captures
// report it so the server can resample the image into input space.
export function squeezedScreenSize(): ScreenSize | undefined {
	const viewport = viewportSize();
	const full = fullScreenSize();
	if (viewport === undefined || full === undefined || !isScaled(screenScale(full, viewport))) return undefined;
	return { width: math.round(full.width), height: math.round(full.height) };
}

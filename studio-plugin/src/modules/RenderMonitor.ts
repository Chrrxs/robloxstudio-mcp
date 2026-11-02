// Detects whether the Studio window is actually rendering, so virtual input
// and screenshot tools can surface a clear reason instead of silently failing.
//
// When a Studio window is MINIMIZED, the engine suspends the render loop AND
// input processing, but keeps running scripts (Heartbeat keeps firing). That's
// why simulate_*_input would return success while having zero effect, and
// CaptureService:CaptureScreenshot would time out. Validated live: during a 3s
// minimize, RenderStepped's max inter-frame gap was 5.08s while Heartbeat's was
// 0.10s. So RenderStepped freshness is the reliable "is this window rendering?"
// signal; Heartbeat is not.

import { RunService } from "@rbxts/services";

let lastFrame = 0;
let connected = false;

// Above this many seconds since the last rendered frame, we treat the window
// as not rendering. RenderStepped normally fires every ~16ms; a multi-second
// gap only happens when minimized/suspended, so 1s cleanly avoids false
// positives from ordinary frame hitches while still catching the real case.
const STALE_THRESHOLD = 1.0;

// Run on the first rendered frame after a stale gap. Input sent while the
// window wasn't rendering may never have reached the engine, so callers use
// this to re-send cleanup (e.g. key releases) once it can land.
const resumeCallbacks = new Array<() => void>();

export function onRenderResumed(callback: () => void): void {
	resumeCallbacks.push(callback);
}

export function start(): void {
	if (connected) return;
	// RenderStepped can only be connected from a client/edit render loop; it
	// throws in the play-server DM. pcall so a server-DM call is a safe no-op
	// (connected stays false → notRenderingReason() returns undefined there).
	const [ok] = pcall(() => {
		RunService.RenderStepped.Connect(() => {
			const now = tick();
			// One compare per frame; callbacks only fire on the stale→fresh edge.
			const resumed = now - lastFrame > STALE_THRESHOLD;
			lastFrame = now;
			if (resumed) {
				for (const callback of resumeCallbacks) task.spawn(callback);
			}
		});
	});
	if (ok) {
		connected = true;
		lastFrame = tick();
	}
}

export function secondsSinceFrame(): number {
	if (!connected) return 0;
	return tick() - lastFrame;
}

// Returns a human-readable reason if the window appears minimized / not
// rendering (so input + screenshots won't work), else undefined. Fail-open:
// when the monitor isn't active in this DM (server peer, or connect failed) it
// returns undefined so we never block on a false signal.
export function notRenderingReason(): string | undefined {
	if (!connected) return undefined;
	const gap = secondsSinceFrame();
	if (gap > STALE_THRESHOLD) {
		return string.format(
			"Studio window appears minimized or not rendering (no frame in %.1fs). " +
				"Virtual input and screenshots only work while the window is visible — " +
				"restore/un-minimize the Studio window and retry.",
			gap,
		);
	}
	return undefined;
}

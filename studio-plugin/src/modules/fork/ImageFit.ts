// Shrinks a capture frame so its longest side fits the server's maxPx.
// The engine resamples while capturing, so less data crosses the bridge.
function fitFrame(w: number, h: number, maxPx: unknown): { w: number; h: number } {
	if (!typeIs(maxPx, "number") || maxPx < 1) return { w, h };
	const longest = math.max(w, h);
	if (longest <= maxPx) return { w, h };
	const scale = maxPx / longest;
	return { w: math.max(1, math.floor(w * scale)), h: math.max(1, math.floor(h * scale)) };
}

export = { fitFrame };

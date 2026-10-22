// Resolves a screenshot crop to a viewport-pixel rectangle in the peer that
// renders the frame (edit, or client-N during a playtest).
import Utils from "../Utils";

const Workspace = game.GetService("Workspace");
const GuiService = game.GetService("GuiService");

type RectResult = { x: number; y: number; w: number; h: number; viewportWidth: number; viewportHeight: number };

function clampToViewport(minX: number, minY: number, maxX: number, maxY: number, vw: number, vh: number) {
	const x0 = math.max(0, math.floor(minX));
	const y0 = math.max(0, math.floor(minY));
	const x1 = math.min(vw, math.ceil(maxX));
	const y1 = math.min(vh, math.ceil(maxY));
	if (x1 <= x0 || y1 <= y0) return undefined;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, viewportWidth: vw, viewportHeight: vh };
}

function guiRect(gui: GuiObject, vw: number, vh: number): RectResult | undefined {
	let offset = new Vector2(0, 0);
	const screenGui = gui.FindFirstAncestorWhichIsA("ScreenGui");
	if (screenGui !== undefined && !screenGui.IgnoreGuiInset) offset = GuiService.GetGuiInset()[0];
	const pos = gui.AbsolutePosition.add(offset);
	const size = gui.AbsoluteSize;
	return clampToViewport(pos.X, pos.Y, pos.X + size.X, pos.Y + size.Y, vw, vh);
}

function worldRect(camera: Camera, cf: CFrame, size: Vector3, vw: number, vh: number): RectResult | undefined {
	let minX = math.huge;
	let minY = math.huge;
	let maxX = -math.huge;
	let maxY = -math.huge;
	let visible = 0;
	for (const sx of [-1, 1]) {
		for (const sy of [-1, 1]) {
			for (const sz of [-1, 1]) {
				const corner = cf.PointToWorldSpace(new Vector3(size.X * sx, size.Y * sy, size.Z * sz).div(2));
				const [screen] = camera.WorldToViewportPoint(corner);
				if (screen.Z <= 0) continue;
				visible++;
				minX = math.min(minX, screen.X);
				minY = math.min(minY, screen.Y);
				maxX = math.max(maxX, screen.X);
				maxY = math.max(maxY, screen.Y);
			}
		}
	}
	if (visible === 0) return undefined;
	return clampToViewport(minX, minY, maxX, maxY, vw, vh);
}

function resolve(data: Record<string, unknown>): unknown {
	const camera = Workspace.CurrentCamera;
	if (camera === undefined) return { error: "no camera in this DataModel" };
	const vw = math.floor(camera.ViewportSize.X);
	const vh = math.floor(camera.ViewportSize.Y);

	if (typeIs(data.rect, "table")) {
		const rect = data.rect as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
		if (!typeIs(rect.x, "number") || !typeIs(rect.y, "number") || !typeIs(rect.w, "number") || !typeIs(rect.h, "number")) {
			return { error: "rect needs numeric x, y, w, h" };
		}
		return clampToViewport(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, vw, vh)
			?? { error: `${rect.x},${rect.y},${rect.w},${rect.h} is outside the ${vw}x${vh} viewport` };
	}

	const path = data.path;
	if (!typeIs(path, "string") || path === "") return { error: "path or rect is required" };
	const instance = Utils.getInstanceByPath(path);
	if (instance === undefined) return { error: `no instance at ${path}` };

	let result: RectResult | undefined;
	if (instance.IsA("GuiObject")) {
		result = guiRect(instance, vw, vh);
	} else if (instance.IsA("BasePart")) {
		result = worldRect(camera, instance.CFrame, instance.Size, vw, vh);
	} else if (instance.IsA("Model")) {
		const [cf, size] = instance.GetBoundingBox();
		result = worldRect(camera, cf, size, vw, vh);
	} else {
		return { error: `${path} is a ${instance.ClassName}; crop needs a GuiObject, BasePart or Model` };
	}
	return result ?? { error: `${path} is not on screen` };
}

export = { resolve };

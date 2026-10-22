// ui_layout: geometry and text-fit facts for a GUI subtree, in viewport
// pixels (the same space as screenshots and simulate_mouse_input). The server
// runs the overlap and outside-parent checks.
import CaptureRect from "./CaptureRect";
import Utils from "../Utils";

const Players = game.GetService("Players");

const MAX_NODES = 400;

interface LayoutNode {
	path: string;
	className: string;
	parent: number; // index into nodes, -1 for the root
	x: number;
	y: number;
	w: number;
	h: number;
	z: number;
	hidden?: boolean;
	clips?: boolean;
	textFits?: boolean;
	truncates?: boolean;
}

// "PlayerGui.X" means the local player's PlayerGui on a client peer, and
// StarterGui.X where there is no local player (edit mode).
function resolveGuiPath(path: string): Instance | undefined {
	const [head, rest] = [path.sub(1, 9), path.sub(10)];
	if (head === "PlayerGui" && (rest === "" || rest.sub(1, 1) === ".")) {
		const playerGui: Instance | undefined = Players.LocalPlayer !== undefined
			? Players.LocalPlayer.FindFirstChildOfClass("PlayerGui")
			: game.GetService("StarterGui");
		if (playerGui === undefined) return undefined;
		return rest === "" ? playerGui : Utils.getInstanceByPath(`${Utils.getInstancePath(playerGui)}${rest}`);
	}
	return Utils.getInstanceByPath(path);
}

function relativePath(instance: Instance, rootPath: string): string {
	const full = Utils.getInstancePath(instance);
	if (full === rootPath) return instance.Name;
	let rest = full.sub(rootPath.size() + 1);
	if (rest.sub(1, 1) === ".") rest = rest.sub(2);
	return rest;
}

function selfVisible(instance: Instance): boolean {
	if (instance.IsA("GuiObject")) return instance.Visible;
	if (instance.IsA("LayerCollector")) return instance.Enabled;
	return true;
}

function ancestorsVisible(instance: Instance): boolean {
	let current = instance.Parent;
	while (current !== undefined) {
		if (!selfVisible(current)) return false;
		current = current.Parent;
	}
	return true;
}

function layout(data: Record<string, unknown>): unknown {
	const path = data.gui_path;
	if (!typeIs(path, "string") || path === "") return { error: "gui_path is required" };
	const root = resolveGuiPath(path);
	if (root === undefined) return { error: `no instance at ${path}` };
	if (!root.IsA("GuiObject") && !root.IsA("LayerCollector") && !root.IsA("BasePlayerGui") && !root.IsA("StarterGui")) {
		return { error: `${path} is a ${root.ClassName}, not a GUI` };
	}
	const rootPath = Utils.getInstancePath(root);
	const nodes: LayoutNode[] = [];
	let total = 0;

	const visit = (instance: Instance, parent: number, parentVisible: boolean) => {
		const isGui = instance.IsA("GuiObject");
		const isContainer = instance.IsA("LayerCollector") || instance.IsA("BasePlayerGui") || instance.IsA("StarterGui") || instance.IsA("Folder");
		if (!isGui && !isContainer) return;
		total++;
		const visible = parentVisible && selfVisible(instance);
		let index = parent;
		if (nodes.size() < MAX_NODES) {
			const node: LayoutNode = { path: relativePath(instance, rootPath), className: instance.ClassName, parent, x: 0, y: 0, w: 0, h: 0, z: 0 };
			if (isGui) {
				const gui = instance as GuiObject;
				const pos = gui.AbsolutePosition.add(CaptureRect.guiOffset(gui));
				node.x = math.round(pos.X);
				node.y = math.round(pos.Y);
				node.w = math.round(gui.AbsoluteSize.X);
				node.h = math.round(gui.AbsoluteSize.Y);
				node.z = gui.ZIndex;
				if (gui.ClipsDescendants) node.clips = true;
				if (gui.IsA("TextLabel") || gui.IsA("TextButton") || gui.IsA("TextBox")) {
					node.textFits = gui.TextFits;
					node.truncates = gui.TextTruncate !== Enum.TextTruncate.None;
				}
			}
			if (!visible) node.hidden = true;
			nodes.push(node);
			index = nodes.size() - 1;
		}
		// A hidden subtree is listed once, not element by element.
		if (!visible) return;
		for (const child of instance.GetChildren()) visit(child, index, visible);
	};
	visit(root, -1, ancestorsVisible(root));
	return { nodes, total };
}

export = { layout, resolveGuiPath };

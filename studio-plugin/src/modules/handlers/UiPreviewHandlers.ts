// Stateful edit-mode UI preview (preview_ui). One preview per edit peer:
// a story module rendered through the bundled story renderer, or a clone of a
// native ScreenGui / GuiObject. The preview lives in a non-archivable host
// ScreenGui under StarterGui: CreateVirtualInput clicks reach StarterGui UI in
// edit mode but are rejected over CoreGui ("position hits CoreGUI"), and an
// Archivable=false host is neither saved nor copied into playtest DataModels.
// Story control state lives in the mounted renderer and persists between
// actions until unmount, playtest start, plugin unload, or IDLE_TIMEOUT.
//
// Story previews hot-reload: the renderer reloads them when the story or a
// module it requires changes. Controls the agent set are re-applied to each
// reloaded generation (the reload itself starts from the story's defaults),
// actions wait for an in-flight reload, and the next action reports reloads,
// reload failures and late story errors. Native UI previews are static clones
// and never reload.

import { HttpService, RunService } from "@rbxts/services";
import Utils from "../Utils";
import State from "../State";
import PluginSession from "../PluginSession";
import { readyVirtualInput, VirtualInput } from "./InputHandlers";

const StarterGui = game.GetService("StarterGui");
const GuiService = game.GetService("GuiService");
// EditModeActive is false while a playtest owns the viewport; it is missing from the typings.
const StudioTestService = game.GetService("StudioTestService") as StudioTestService & { EditModeActive: boolean };

const HOST_PREFIX = "__MCPUiPreview_";
// Above any realistic game DisplayOrder; a cloned ScreenGui sits one above the host backdrop.
const HOST_DISPLAY_ORDER = 1073741824;
const BACKDROP_COLOR = Color3.fromRGB(37, 38, 42);
const IDLE_TIMEOUT = 600;
const MONITOR_INTERVAL = 0.2;
// Bounded wait for a queued or loading hot reload before an action proceeds.
const RELOAD_WAIT = 15;
const RELOAD_POLL = 0.05;
// A reloaded React story publishes its controls just after it commits.
const CONTROLS_WAIT = 1;
const MAX_REPORTED_ERRORS = 5;
const ERROR_LIMIT = 600;
const INTERACTIVE_ACTIONS: Record<string, true> = { set_controls: true, click: true, type: true };
const CLICK_HOLD = 0.05;
const INSPECT_LIMIT = 300;
const TEXT_LIMIT = 120;
const NATIVE_SCRIPT_NOTE =
	"Scripts and LocalScripts inside native UI do not run in edit mode; the preview shows the UI's static state. Use a story module to preview behaviour.";
const NATIVE_RELOAD_NOTE = "Native UI previews are static clones and do not hot-reload; mount again to see changes to the source.";
const STORY_RELOAD_NOTE =
	"Hot reloading is on: edits to the story or modules it requires reapply without remounting, and controls you set are re-applied after each reload.";

interface ControlsSnapshot {
	Controls: Record<string, unknown>;
	Values: Record<string, unknown>;
}

// Contract of studio-plugin/ui-renderer/Preview.tsx (compiled into the UIRenderer folder as McpPreview).
interface ReloadStatus {
	readonly Generation: number;
	readonly State: "loading" | "ready" | "failed";
	readonly Error?: string;
}

interface RendererHandle {
	readonly GetStoryType: () => string | undefined;
	readonly GetRoot: () => Frame | undefined;
	readonly GetControls: () => ControlsSnapshot | undefined;
	readonly SetControls: (values: Record<string, unknown>) => void;
	readonly GetReload: () => ReloadStatus;
	readonly GetErrors: () => readonly string[];
	readonly Cleanup: () => void;
}

interface Renderer {
	mount(this: void, story: ModuleScript, target: Frame, owner: Plugin): RendererHandle;
}

// Converted control definition as published by the renderer's mounters.
interface ControlDefinition {
	EntryType: "Control" | "ControlGroup";
	Type?: string;
	ControlValue?: unknown;
	Order?: number;
	Min?: number;
	Max?: number;
	Step?: number;
	List?: unknown;
	ClassName?: string;
	Predicator?: (instance: Instance) => boolean;
	Controls?: Record<string, ControlDefinition>;
}

type PreviewKind = "story" | "screengui" | "guiobject";

interface Preview {
	kind: PreviewKind;
	target: string;
	host: ScreenGui;
	content: Frame;
	clone?: GuiObject | ScreenGui;
	story?: RendererHandle;
	/** Raw control values the agent set, by name (groups nest); re-applied after every hot reload. */
	overrides: Record<string, unknown>;
	/** Last generation the overrides were re-applied to, and the last one reported to the agent. */
	appliedGeneration: number;
	reportedGeneration: number;
	/** Count of renderer late errors already reported. */
	reportedErrors: number;
	/** Reload state last reported, so settling after a reported "loading"/"failed" is reported too. */
	reportedState: string;
	/** Re-apply outcomes not yet reported. */
	pendingReapplied?: string[];
	pendingDropped: { name: string; reason: string }[];
	syncing: boolean;
	lastUsed: number;
	restoreDevGui: boolean;
	finishing: boolean;
}

let owner: Plugin | undefined;
let active: Preview | undefined;
let mounting = false;
let monitoring = false;

function fail(message: string): never {
	error(message, 0);
}

function restoreDevelopmentGui(preview: Preview): string | undefined {
	if (!preview.restoreDevGui) return undefined;
	const [ok, err] = pcall(() => {
		StarterGui.ShowDevelopmentGui = false;
	});
	if (!ok) return `Restoring StarterGui.ShowDevelopmentGui failed: ${tostring(err)}`;
	preview.restoreDevGui = false;
	return undefined;
}

function finish(preview: Preview, replacing = false): string | undefined {
	if (preview.finishing) return "UI preview cleanup is already in progress.";
	preview.finishing = true;
	const errors: string[] = [];
	if (preview.story !== undefined) {
		const [ok, err] = pcall(preview.story.Cleanup);
		if (!ok) errors.push(tostring(err));
	}
	for (const gui of [preview.clone, preview.host]) {
		if (gui === undefined) continue;
		const [ok, err] = pcall(() => gui.Destroy());
		if (!ok) errors.push(`Removing ${gui.Name} failed: ${tostring(err)}`);
	}
	if (!replacing) {
		const restoreFailure = restoreDevelopmentGui(preview);
		if (restoreFailure !== undefined) errors.push(restoreFailure);
	}
	if (active === preview) active = undefined;
	return errors.size() > 0 ? errors.join("; ") : undefined;
}

function endActive(reason: string): void {
	const preview = active;
	if (preview === undefined) return;
	const failure = finish(preview);
	if (failure !== undefined) warn(`[robloxstudio-mcp] UI preview cleanup (${reason}) failed: ${failure}`);
}

function playtestActive(): boolean {
	return RunService.IsRunning() || !StudioTestService.EditModeActive;
}

// Auto-unmount on playtest start and after IDLE_TIMEOUT without preview_ui calls.
function startMonitor(): void {
	if (monitoring) return;
	monitoring = true;
	task.spawn(() => {
		while (active !== undefined) {
			task.wait(MONITOR_INTERVAL);
			const preview = active;
			if (preview === undefined || mounting || preview.finishing) continue;
			if (playtestActive()) endActive("playtest started");
			else if (os.clock() - preview.lastUsed > IDLE_TIMEOUT) endActive("idle timeout");
			else if (preview.story !== undefined && !preview.syncing) {
				// Re-apply the agent's controls as soon as a hot reload settles, not only on the next action.
				const [ok, err] = pcall(() => syncStory(preview, false));
				if (!ok) warn(`[robloxstudio-mcp] UI preview reload sync failed: ${tostring(err)}`);
			}
		}
		monitoring = false;
	});
}

function init(plugin: Plugin): void {
	owner = plugin;
	plugin.Unloading.Connect(() => endActive("plugin unloading"));
}

/** Called before MCP starts a playtest so the edit viewport never keeps a preview. */
function endForPlaytest(): void {
	endActive("playtest starting");
}

function previewRoot(preview: Preview): Instance {
	if (preview.story !== undefined) return preview.story.GetRoot() ?? preview.content;
	return preview.clone ?? preview.content;
}

function relativePath(root: Instance, instance: Instance): string {
	if (instance === root) return ".";
	const parts: string[] = [];
	let node: Instance | undefined = instance;
	while (node !== undefined && node !== root) {
		parts.unshift(node.Name);
		node = node.Parent;
	}
	return parts.join("/");
}

function resolveElement(root: Instance, path: unknown): Instance {
	if (!typeIs(path, "string")) fail("element must be a path relative to the preview root, e.g. Shop/Buy.");
	const trimmed = path.gsub("^%s+", "")[0].gsub("%s+$", "")[0];
	if (trimmed === "" || trimmed === ".") return root;
	const segments = trimmed.split("/");
	let start = 0;
	if (segments[0] === root.Name && root.FindFirstChild(segments[0]) === undefined) start = 1;
	let node = root;
	for (let i = start; i < segments.size(); i++) {
		const child = node.FindFirstChild(segments[i]);
		if (child === undefined) {
			const names = node.GetChildren().map((c) => c.Name);
			fail(
				`No child "${segments[i]}" under "${relativePath(root, node)}". Children: ${names.size() > 0 ? names.join(", ") : "(none)"}. Use action=inspect to list the tree.`,
			);
		}
		node = child;
	}
	return node;
}

function shown(instance: Instance): boolean {
	let node: Instance | undefined = instance;
	while (node !== undefined) {
		if (node.IsA("GuiObject") && !node.Visible) return false;
		if (node.IsA("ScreenGui")) return node.Enabled;
		if (node.IsA("LayerCollector")) return true;
		node = node.Parent;
	}
	return false;
}

// Viewport pixel rect: AbsolutePosition is in GUI space, offset by the GUI inset ((0,0) in edit mode).
function screenRect(obj: GuiObject): [number, number, number, number] {
	const [inset] = GuiService.GetGuiInset();
	const position = obj.AbsolutePosition.add(inset);
	return [math.round(position.X), math.round(position.Y), math.round(obj.AbsoluteSize.X), math.round(obj.AbsoluteSize.Y)];
}

// ---------------------------------------------------------------------------
// Story controls

function encodeValue(value: unknown): unknown {
	if (value === undefined || typeIs(value, "string") || typeIs(value, "number") || typeIs(value, "boolean")) return value;
	if (typeIs(value, "Color3")) return `#${value.ToHex().upper()}`;
	if (typeIs(value, "EnumItem")) return tostring(value);
	if (typeIs(value, "Instance")) return Utils.getInstancePath(value);
	if (typeIs(value, "table")) {
		// RGBA control values are { Color, Transparency }.
		const rgba = value as { Color?: unknown; Transparency?: unknown };
		if (typeIs(rgba.Color, "Color3") && typeIs(rgba.Transparency, "number")) {
			return { color: `#${rgba.Color.ToHex().upper()}`, transparency: rgba.Transparency };
		}
	}
	return `<${typeOf(value)}> ${tostring(value)}`;
}

function sortedEntries(controls: Record<string, ControlDefinition>): [string, ControlDefinition][] {
	const entries: [string, ControlDefinition][] = [];
	for (const [name, definition] of pairs(controls)) entries.push([name, definition]);
	entries.sort((a, b) => {
		const orderA = a[1].Order ?? 0;
		const orderB = b[1].Order ?? 0;
		return orderA !== orderB ? orderA < orderB : a[0] < b[0];
	});
	return entries;
}

function describeControls(controls: Record<string, ControlDefinition>, values: Record<string, unknown>): defined[] {
	const described: defined[] = [];
	for (const [name, definition] of sortedEntries(controls)) {
		const value = values[name];
		if (definition.EntryType === "ControlGroup") {
			const groupValues = (typeIs(value, "table") ? value : {}) as Record<string, unknown>;
			described.push({ name, type: "Group", controls: describeControls(definition.Controls ?? {}, groupValues) });
			continue;
		}
		const entry: Record<string, unknown> = { name, type: definition.Type, value: encodeValue(value) };
		if (definition.Min !== undefined) entry.min = definition.Min;
		if (definition.Max !== undefined) entry.max = definition.Max;
		if (definition.Step !== undefined) entry.step = definition.Step;
		if (definition.Type === "Choose" && typeIs(definition.List, "table")) {
			entry.options = (definition.List as defined[]).map((item) => encodeValue(item));
		} else if (definition.Type === "EnumList" && typeIs(definition.List, "table")) {
			const keys: string[] = [];
			for (const [key, item] of pairs(definition.List as Record<string, unknown>)) {
				keys.push(key);
				if (item === value) entry.value = key;
			}
			keys.sort();
			entry.options = keys;
		} else if (definition.Type === "Object") {
			entry.className = definition.ClassName ?? "Instance";
		}
		described.push(entry);
	}
	return described;
}

function parseColor(raw: unknown, label: string): Color3 {
	if (typeIs(raw, "string")) {
		const [ok, color] = pcall(() => Color3.fromHex(raw));
		if (ok) return color;
	} else if (typeIs(raw, "table")) {
		const rgb = raw as defined[];
		if (rgb.size() === 3 && rgb.every((c) => typeIs(c, "number") && c >= 0 && c <= 255)) {
			return Color3.fromRGB(rgb[0] as number, rgb[1] as number, rgb[2] as number);
		}
	}
	fail(`${label} expects a hex color like "#FF8800" or [r, g, b] with 0-255 channels.`);
}

function checkRange(value: number, definition: ControlDefinition, label: string): number {
	if ((definition.Min !== undefined && value < definition.Min) || (definition.Max !== undefined && value > definition.Max)) {
		fail(`${label} must be between ${definition.Min ?? "-inf"} and ${definition.Max ?? "inf"}; got ${value}.`);
	}
	return value;
}

function decodeControl(definition: ControlDefinition, raw: unknown, label: string): unknown {
	const controlType = definition.Type;
	if (controlType === "String") {
		if (!typeIs(raw, "string")) fail(`${label} is a String control; pass a string.`);
		return raw;
	}
	if (controlType === "Number" || controlType === "Slider") {
		if (!typeIs(raw, "number")) fail(`${label} is a ${controlType} control; pass a number.`);
		return checkRange(raw, definition, label);
	}
	if (controlType === "Boolean") {
		if (!typeIs(raw, "boolean")) fail(`${label} is a Boolean control; pass true or false.`);
		return raw;
	}
	if (controlType === "Color3") return parseColor(raw, label);
	if (controlType === "RGBA") {
		const rgba = (typeIs(raw, "table") ? raw : {}) as { color?: unknown; transparency?: unknown };
		const transparency = rgba.transparency ?? 0;
		if (!typeIs(transparency, "number") || transparency < 0 || transparency > 1) {
			fail(`${label} is an RGBA control; pass { "color": "#RRGGBB", "transparency": 0-1 }.`);
		}
		return { Color: parseColor(rgba.color, `${label}.color`), Transparency: transparency };
	}
	if (controlType === "Choose") {
		const list = (typeIs(definition.List, "table") ? definition.List : []) as defined[];
		for (const item of list) {
			if (item === raw || encodeValue(item) === raw) return item;
		}
		fail(`${label} must be one of: ${list.map((item) => tostring(encodeValue(item))).join(", ")}.`);
	}
	if (controlType === "EnumList") {
		const list = (typeIs(definition.List, "table") ? definition.List : {}) as Record<string, unknown>;
		const keys: string[] = [];
		for (const [key, item] of pairs(list)) {
			if (key === raw || item === raw) return item;
			keys.push(key);
		}
		keys.sort();
		fail(`${label} must be one of: ${keys.join(", ")}.`);
	}
	if (controlType === "Object") {
		if (raw === "") return undefined;
		if (!typeIs(raw, "string")) fail(`${label} is an Object control; pass an instance path, or "" to clear it.`);
		const instance = Utils.getInstanceByPath(raw);
		if (instance === undefined) fail(`${label}: no instance at ${raw}.`);
		const className = definition.ClassName ?? "Instance";
		const actualClass = instance.ClassName;
		if (!instance.IsA(className as keyof Instances)) fail(`${label} needs a ${className}; ${raw} is a ${actualClass}.`);
		const predicate = definition.Predicator;
		if (predicate !== undefined) {
			const [ok, accepted] = pcall(() => predicate(instance));
			if (!ok || accepted !== true) fail(`${label}: the story's predicate rejected ${raw}.`);
		}
		return instance;
	}
	fail(`${label} has unsupported control type ${tostring(controlType)}.`);
}

function mergeControls(
	controls: Record<string, ControlDefinition>,
	values: Record<string, unknown>,
	overrides: Record<string, unknown>,
	prefix: string,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const [name, value] of pairs(values)) merged[name] = value;
	for (const [name, raw] of pairs(overrides)) {
		const label = `${prefix}${name}`;
		const definition = controls[name];
		if (definition === undefined) {
			const names = sortedEntries(controls).map(([controlName]) => `${prefix}${controlName}`);
			fail(`Unknown control "${label}". Controls: ${names.size() > 0 ? names.join(", ") : "(none)"}.`);
		}
		if (definition.EntryType === "ControlGroup") {
			if (!typeIs(raw, "table")) fail(`${label} is a control group; pass an object of its controls.`);
			const groupValues = (typeIs(values[name], "table") ? values[name] : {}) as Record<string, unknown>;
			merged[name] = mergeControls(definition.Controls ?? {}, groupValues, raw as Record<string, unknown>, `${label}.`);
		} else {
			merged[name] = decodeControl(definition, raw, label);
		}
	}
	return merged;
}

function storyControls(story: RendererHandle): defined[] {
	const snapshot = story.GetControls();
	if (snapshot === undefined) return [];
	return describeControls(snapshot.Controls as Record<string, ControlDefinition>, snapshot.Values);
}

// Remembers raw overrides by name; control groups merge per child so later partial updates keep earlier ones.
function recordOverrides(
	stored: Record<string, unknown>,
	overrides: Record<string, unknown>,
	controls: Record<string, ControlDefinition>,
): void {
	for (const [name, raw] of pairs(overrides)) {
		const definition = controls[name];
		if (definition?.EntryType === "ControlGroup" && typeIs(raw, "table")) {
			const group = (typeIs(stored[name], "table") ? stored[name] : {}) as Record<string, unknown>;
			recordOverrides(group, raw as Record<string, unknown>, definition.Controls ?? {});
			stored[name] = group;
		} else {
			stored[name] = raw;
		}
	}
}

function applyControls(preview: Preview, story: RendererHandle, overrides: unknown): void {
	if (!typeIs(overrides, "table")) fail("controls must be an object of { controlName: value }.");
	const snapshot = story.GetControls();
	if (snapshot === undefined) fail("This story declares no controls.");
	const controls = snapshot.Controls as Record<string, ControlDefinition>;
	const merged = mergeControls(controls, snapshot.Values, overrides as Record<string, unknown>, "");
	story.SetControls(merged);
	recordOverrides(preview.overrides, overrides as Record<string, unknown>, controls);
	// Let the mounter re-render and publish the new values.
	task.wait();
	task.wait();
}

// A reloaded generation starts from the story's own defaults. Re-apply each remembered override that still
// fits the reloaded controls; drop (and report) ones whose control was removed or changed type.
function reapplyOverrides(preview: Preview, story: RendererHandle): void {
	if (next(preview.overrides)[0] === undefined) return;
	let snapshot = story.GetControls();
	const deadline = os.clock() + CONTROLS_WAIT;
	while (snapshot === undefined && os.clock() < deadline) {
		task.wait();
		snapshot = story.GetControls();
	}
	if (snapshot === undefined) {
		for (const [name] of pairs(preview.overrides)) {
			preview.pendingDropped.push({ name: tostring(name), reason: "The reloaded story declares no controls." });
		}
		preview.overrides = {};
		return;
	}
	const controls = snapshot.Controls as Record<string, ControlDefinition>;
	const values = snapshot.Values;
	const kept: Record<string, unknown> = {};
	for (const [name, raw] of pairs(preview.overrides)) {
		const [ok, err] = pcall(() => mergeControls(controls, values, { [name]: raw }, ""));
		if (ok) kept[name] = raw;
		else preview.pendingDropped.push({ name: tostring(name), reason: tostring(err) });
	}
	preview.overrides = kept;
	if (next(kept)[0] === undefined) return;
	story.SetControls(mergeControls(controls, values, kept, ""));
	const names: string[] = [];
	for (const [name] of pairs(kept)) names.push(tostring(name));
	names.sort();
	preview.pendingReapplied = names;
	task.wait();
	task.wait();
}

// Brings the agent's controls onto the latest settled generation. With waitForReload, first waits (bounded) for a
// queued or loading reload so the caller acts on the reloaded story rather than the previous one.
function syncStory(preview: Preview, waitForReload: boolean): void {
	const story = preview.story;
	if (story === undefined) return;
	if (preview.syncing) {
		if (!waitForReload) return;
		const deadline = os.clock() + RELOAD_WAIT;
		while (preview.syncing && os.clock() < deadline) task.wait(RELOAD_POLL);
	}
	preview.syncing = true;
	const [ok, err] = pcall(() => {
		let status = story.GetReload();
		if (waitForReload) {
			const deadline = os.clock() + RELOAD_WAIT;
			while (status.State === "loading" && os.clock() < deadline) {
				task.wait(RELOAD_POLL);
				status = story.GetReload();
			}
		}
		// A reload can land while overrides are re-applied; loop until the applied generation is the latest.
		while (status.State === "ready" && status.Generation !== preview.appliedGeneration) {
			preview.appliedGeneration = status.Generation;
			reapplyOverrides(preview, story);
			status = story.GetReload();
		}
	});
	preview.syncing = false;
	if (!ok) error(err, 0);
}

function truncate(text: string): string {
	return text.size() > ERROR_LIMIT ? `${text.sub(1, ERROR_LIMIT)}...` : text;
}

// Reload activity since the previous action, or undefined when nothing happened.
function takeReloadReport(preview: Preview, story: RendererHandle): Record<string, unknown> | undefined {
	const status = story.GetReload();
	const report: Record<string, unknown> = { status: status.State, generation: status.Generation };
	let notable = status.State !== "ready" || status.State !== preview.reportedState;
	preview.reportedState = status.State;
	if (status.Generation !== preview.reportedGeneration) {
		report.reloads = status.Generation - preview.reportedGeneration;
		preview.reportedGeneration = status.Generation;
		notable = true;
	}
	if (status.State === "failed") report.error = truncate(status.Error ?? "unknown error");
	if (status.State === "loading") {
		report.note = `The story was still reloading after ${RELOAD_WAIT}s; this result may show the previous load.`;
	}
	if (preview.pendingReapplied !== undefined) {
		report.controlsReapplied = preview.pendingReapplied;
		preview.pendingReapplied = undefined;
		notable = true;
	}
	if (preview.pendingDropped.size() > 0) {
		report.controlsDropped = preview.pendingDropped;
		preview.pendingDropped = [];
		notable = true;
	}
	const errors = story.GetErrors();
	if (errors.size() > preview.reportedErrors) {
		const fresh: string[] = [];
		for (let i = math.max(preview.reportedErrors, errors.size() - MAX_REPORTED_ERRORS); i < errors.size(); i++) {
			fresh.push(truncate(errors[i]));
		}
		report.storyErrors = fresh;
		const omitted = errors.size() - preview.reportedErrors - fresh.size();
		if (omitted > 0) report.storyErrorsOmitted = omitted;
		preview.reportedErrors = errors.size();
		notable = true;
	}
	return notable ? report : undefined;
}

// ---------------------------------------------------------------------------
// Actions

function summary(preview: Preview): Record<string, unknown> {
	const size = game.Workspace.CurrentCamera?.ViewportSize ?? Vector2.zero;
	const result: Record<string, unknown> = {
		kind: preview.kind,
		target: preview.target,
		root: Utils.getInstancePath(previewRoot(preview)),
		viewport: [math.round(size.X), math.round(size.Y)],
	};
	if (preview.story !== undefined) result.storyType = preview.story.GetStoryType();
	return result;
}

function createHost(backdrop: boolean): [ScreenGui, Frame] {
	const host = new Instance("ScreenGui");
	host.Name = `${HOST_PREFIX}${HttpService.GenerateGUID(false)}`;
	host.Archivable = false;
	host.IgnoreGuiInset = true;
	host.ResetOnSpawn = false;
	host.DisplayOrder = HOST_DISPLAY_ORDER;
	host.ZIndexBehavior = Enum.ZIndexBehavior.Sibling;
	if (backdrop) {
		const fill = new Instance("Frame");
		fill.Name = "Backdrop";
		fill.Size = UDim2.fromScale(1, 1);
		fill.BackgroundColor3 = BACKDROP_COLOR;
		fill.BorderSizePixel = 0;
		fill.ZIndex = 0;
		fill.Parent = host;
	}
	const content = new Instance("Frame");
	content.Name = "Content";
	content.Size = UDim2.fromScale(1, 1);
	content.BackgroundTransparency = 1;
	content.ZIndex = 1;
	content.Parent = host;
	return [host, content];
}

function countScripts(root: Instance): number {
	let count = 0;
	for (const descendant of root.GetDescendants()) {
		if (descendant.IsA("BaseScript")) count += 1;
	}
	return count;
}

function mountPreview(data: Record<string, unknown>): Record<string, unknown> {
	if (!typeIs(data.target, "string") || data.target === "") fail("target is required: the canonical path of a story module, ScreenGui, or GuiObject.");
	const source = Utils.getInstanceByPath(data.target);
	if (source === undefined) fail(`No instance at ${data.target}.`);
	let ancestor: Instance | undefined = source;
	while (ancestor !== undefined) {
		if (ancestor.Name.sub(1, HOST_PREFIX.size()) === HOST_PREFIX) fail("target is part of a UI preview; pass the original instance.");
		ancestor = ancestor.Parent;
	}
	let kind: PreviewKind;
	if (source.IsA("ModuleScript")) kind = "story";
	else if (source.IsA("ScreenGui")) kind = "screengui";
	else if (source.IsA("GuiObject")) kind = "guiobject";
	else fail(`target must be a story module (*.story ModuleScript), a ScreenGui, or a GuiObject; ${data.target} is a ${source.ClassName}.`);
	if (data.controls !== undefined && kind !== "story") fail("controls apply only to story modules.");

	let renderer: Renderer | undefined;
	if (kind === "story") {
		const adapter = script.FindFirstAncestorWhichIsA("Script")?.FindFirstChild("UIRenderer")?.FindFirstChild("McpPreview");
		if (adapter === undefined || !adapter.IsA("ModuleScript")) {
			fail("The bundled story renderer is missing from this plugin build. Rebuild and install the main MCP plugin.");
		}
		renderer = require(adapter) as Renderer;
	}

	const previous = active;
	const replaced = previous?.target;
	// A replacement keeps ownership of ShowDevelopmentGui. Restoring false then
	// enabling true in the same resume races Studio's deferred GUI state update
	// and can leave the newly mounted preview hidden. Restore only when the
	// preview session actually ends, not when its content changes.
	const restoreDevGui = previous?.restoreDevGui ?? false;
	if (previous !== undefined) {
		const failure = finish(previous, true);
		if (failure !== undefined) {
			const restoreFailure = restoreDevelopmentGui(previous);
			fail(`Unmounting the previous preview failed: ${failure}${restoreFailure !== undefined ? `; ${restoreFailure}` : ""}`);
		}
	}

	const [host, content] = createHost(data.backdrop !== false);
	const preview: Preview = {
		kind,
		target: Utils.getInstancePath(source),
		host,
		content,
		overrides: {},
		appliedGeneration: 0,
		reportedGeneration: 0,
		reportedErrors: 0,
		reportedState: "ready",
		pendingDropped: [],
		syncing: false,
		lastUsed: os.clock(),
		restoreDevGui,
		finishing: false,
	};
	active = preview;
	const notes: string[] = [];
	const [ok, err] = pcall(() => {
		if (!StarterGui.ShowDevelopmentGui) {
			StarterGui.ShowDevelopmentGui = true;
			preview.restoreDevGui = true;
		}
		host.Parent = StarterGui;
		if (kind === "story") {
			const story = renderer!.mount(source as ModuleScript, content, owner!);
			preview.story = story;
			const status = story.GetReload();
			preview.appliedGeneration = status.Generation;
			preview.reportedGeneration = status.Generation;
			preview.reportedErrors = story.GetErrors().size();
			if (data.controls !== undefined) applyControls(preview, story, data.controls);
			notes.push(STORY_RELOAD_NOTE);
			return;
		}
		const clone = source.Clone() as GuiObject | ScreenGui | undefined;
		if (clone === undefined) fail(`${data.target} is not Archivable, so it cannot be cloned for preview.`);
		clone.Archivable = false;
		preview.clone = clone;
		if (clone.IsA("ScreenGui")) {
			clone.Name = `${HOST_PREFIX}${clone.Name}`;
			clone.DisplayOrder = HOST_DISPLAY_ORDER + 1;
			if (!clone.Enabled) {
				clone.Enabled = true;
				notes.push("The source ScreenGui is disabled; the preview enables its clone.");
			}
			clone.Parent = StarterGui;
		} else {
			if (!clone.Visible) notes.push("The source GuiObject has Visible=false; it stays hidden in the preview.");
			clone.Parent = content;
		}
		const scripts = countScripts(clone);
		notes.push(scripts > 0 ? `${NATIVE_SCRIPT_NOTE} (${scripts} script${scripts === 1 ? "" : "s"} inside.)` : NATIVE_SCRIPT_NOTE);
		notes.push(NATIVE_RELOAD_NOTE);
	});
	if (!ok) {
		const cleanupFailure = finish(preview);
		fail(`UI preview mount failed: ${tostring(err)}${cleanupFailure !== undefined ? `; cleanup failed: ${cleanupFailure}` : ""}`);
	}
	startMonitor();
	const result = summary(preview);
	if (preview.story !== undefined) result.controls = storyControls(preview.story);
	if (replaced !== undefined) result.replaced = replaced;
	if (notes.size() > 0) result.notes = notes;
	return result;
}

function sendClick(vi: VirtualInput, position: Vector2): void {
	vi.SendMouseButton(position, Enum.UserInputType.MouseButton1, true);
	task.wait(CLICK_HOLD);
	vi.SendMouseButton(position, Enum.UserInputType.MouseButton1, false);
}

// Topmost preview GuiObject at the point, and the topmost GuiButton there (the
// likely receiver of the click). Hits outside the preview root, such as the
// renderer's transparent input listener, are skipped.
function hitAt(preview: Preview, position: Vector2): Record<string, unknown> | undefined {
	const [inset] = GuiService.GetGuiInset();
	const guiPosition = position.sub(inset);
	const [ok, hits] = pcall(() => StarterGui.GetGuiObjectsAtPosition(guiPosition.X, guiPosition.Y));
	if (!ok) return undefined;
	const root = previewRoot(preview);
	let top: Instance | undefined;
	for (const hit of hits) {
		if (hit !== root && !hit.IsDescendantOf(root)) continue;
		top ??= hit;
		if (hit.IsA("GuiButton")) {
			return { top: relativePath(root, top), button: relativePath(root, hit), buttonClass: hit.ClassName };
		}
	}
	return top === undefined ? undefined : { top: relativePath(root, top) };
}

function elementCenter(element: Instance, root: Instance): Vector2 {
	if (!element.IsA("GuiObject")) fail(`${relativePath(root, element)} is a ${element.ClassName}, not a GuiObject.`);
	if (!shown(element)) fail(`${relativePath(root, element)} is not visible (it or an ancestor has Visible=false).`);
	const [x, y, w, h] = screenRect(element);
	if (w <= 0 || h <= 0) fail(`${relativePath(root, element)} has zero size on screen.`);
	const size = game.Workspace.CurrentCamera?.ViewportSize ?? Vector2.zero;
	const center = new Vector2(math.floor(x + w / 2), math.floor(y + h / 2));
	if (center.X < 0 || center.Y < 0 || center.X >= size.X || center.Y >= size.Y) {
		fail(`${relativePath(root, element)} is centred off-screen at (${center.X}, ${center.Y}); viewport is ${size.X}x${size.Y}.`);
	}
	return center;
}

function clickPreview(preview: Preview, data: Record<string, unknown>): Record<string, unknown> {
	const root = previewRoot(preview);
	let position: Vector2;
	let element: Instance | undefined;
	if (data.element !== undefined) {
		element = resolveElement(root, data.element);
		position = elementCenter(element, root);
	} else if (typeIs(data.x, "number") && typeIs(data.y, "number")) {
		position = new Vector2(math.round(data.x), math.round(data.y));
	} else {
		fail("click needs element (a path relative to the preview root) or x and y.");
	}
	const vi = readyVirtualInput();
	if (typeIs(vi, "string")) fail(vi);
	const hit = hitAt(preview, position);
	const [ok, err] = pcall(() => sendClick(vi, position));
	if (!ok) fail(`Click failed: ${tostring(err)}`);
	const result = summary(preview);
	result.clicked = { x: position.X, y: position.Y };
	if (element !== undefined) {
		result.element = { path: relativePath(root, element), className: element.ClassName, isButton: element.IsA("GuiButton") };
	}
	result.hit = hit ?? "no preview GuiObject at that point";
	return result;
}

function typePreview(preview: Preview, data: Record<string, unknown>): Record<string, unknown> {
	if (!typeIs(data.text, "string")) fail("type needs text.");
	const root = previewRoot(preview);
	const element = resolveElement(root, data.element);
	if (!element.IsA("TextBox")) fail(`${relativePath(root, element)} is a ${element.ClassName}, not a TextBox.`);
	const position = elementCenter(element, root);
	const vi = readyVirtualInput();
	if (typeIs(vi, "string")) fail(vi);
	const [ok, err] = pcall(() => {
		sendClick(vi, position);
		task.wait();
		if (!element.IsFocused()) element.CaptureFocus();
		if (!element.IsFocused()) error("the TextBox did not take focus", 0);
		vi.SendTextInput(data.text as string);
		task.wait();
		if (data.submit === true) {
			vi.SendKey(true, Enum.KeyCode.Return);
			task.wait(CLICK_HOLD);
			vi.SendKey(false, Enum.KeyCode.Return);
			task.wait();
		}
	});
	if (!ok) fail(`Typing failed: ${tostring(err)}`);
	const result = summary(preview);
	result.element = { path: relativePath(root, element), text: element.Text, focused: element.IsFocused() };
	return result;
}

function inspectPreview(preview: Preview): Record<string, unknown> {
	const root = previewRoot(preview);
	const nodes: defined[] = [];
	let total = 0;
	const visit = (instance: Instance) => {
		const isGui = instance.IsA("GuiObject");
		if (isGui || instance === root) {
			total += 1;
			if (nodes.size() < INSPECT_LIMIT) {
				const node: Record<string, unknown> = {
					path: relativePath(root, instance),
					className: instance.ClassName,
					visible: shown(instance),
				};
				if (isGui) node.rect = screenRect(instance);
				if (instance.IsA("TextLabel") || instance.IsA("TextButton") || instance.IsA("TextBox")) {
					node.text = instance.Text.size() > TEXT_LIMIT ? `${instance.Text.sub(1, TEXT_LIMIT)}...` : instance.Text;
				}
				if (instance.IsA("ImageLabel") || instance.IsA("ImageButton")) node.image = instance.Image;
				if (instance.IsA("GuiButton")) node.button = true;
				if (instance.IsA("TextBox")) node.textbox = true;
				nodes.push(node);
			}
		}
		for (const child of instance.GetChildren()) visit(child);
	};
	visit(root);
	const result = summary(preview);
	result.nodes = nodes;
	result.nodeCount = total;
	if (total > nodes.size()) result.truncated = `Showing the first ${nodes.size()} of ${total} nodes.`;
	return result;
}

function previewUi(data: Record<string, unknown>): unknown {
	const action = data.action;
	if (action === "unmount") {
		const preview = active;
		if (preview === undefined) return { error: "No UI preview is mounted; nothing to unmount." };
		const target = preview.target;
		const failure = finish(preview);
		return failure === undefined ? { success: true, unmounted: target } : { error: `UI preview cleanup failed: ${failure}` };
	}
	if (State.PLUGIN_VARIANT !== "main") return { error: "preview_ui requires the main MCP plugin." };
	if (PluginSession.getRole() !== "edit" || playtestActive()) {
		return { error: "preview_ui requires the edit DataModel with no active playtest." };
	}
	if (owner === undefined) return { error: "UI preview handler is not initialized." };
	if (mounting) return { error: "A UI preview is still mounting; retry when it finishes." };

	const [ok, result] = pcall((): Record<string, unknown> => {
		if (action === "mount") {
			mounting = true;
			const [mountOk, mounted] = pcall(() => mountPreview(data));
			mounting = false;
			if (!mountOk) fail(tostring(mounted));
			return mounted as Record<string, unknown>;
		}
		const preview = active;
		if (preview === undefined) fail("No UI preview is mounted. Call preview_ui with action=mount first.");
		preview.lastUsed = os.clock();
		const story = preview.story;
		let reload: Record<string, unknown> | undefined;
		if (story !== undefined) {
			syncStory(preview, true);
			if (active !== preview) fail("The UI preview was unmounted while waiting for a hot reload.");
			reload = takeReloadReport(preview, story);
			const status = story.GetReload();
			if (INTERACTIVE_ACTIONS[action as string] === true && status.State !== "ready") {
				fail(
					status.State === "failed"
						? `The story failed to hot-reload, so there is nothing to ${action}: ${truncate(status.Error ?? "unknown error")}. Fix the source; the preview reloads automatically when it changes.`
						: `The story is still hot-reloading after ${RELOAD_WAIT}s; retry ${action} when it settles.`,
				);
			}
		}
		let result: Record<string, unknown>;
		if (action === "set_controls") {
			if (story === undefined) fail("set_controls applies only to story previews.");
			applyControls(preview, story, data.controls);
			result = summary(preview);
			result.controls = storyControls(story);
		} else if (action === "click") result = clickPreview(preview, data);
		else if (action === "type") result = typePreview(preview, data);
		else if (action === "inspect") result = inspectPreview(preview);
		else if (action === "screenshot") result = summary(preview);
		else fail(`Unknown preview_ui action ${tostring(action)}.`);
		if (reload !== undefined) result.reload = reload;
		return result;
	});
	if (!ok) return { error: tostring(result) };
	return { success: true, ...result };
}

export = { init, endForPlaytest, previewUi };

// MCP preview adapter for the bundled story renderer (GPL-3.0, compiled as src/McpPreview.tsx).
// Mounts one story into a caller-owned Frame through the real upstream PreviewController, HotReloader
// sandbox and mounters, using this plugin's own bundled RootProducer (never a separately installed
// renderer plugin). Each mount builds a fresh HotReloader, so the story's current source is required.
//
// Hot reloading is on: editing the story or any module it requires schedules a reload through the
// renderer's own HotReloader, which destroys the previous environment (running its unmount and cleanup
// paths), requires fresh source and remounts into the same holder. Every reload is one McpLifecycle
// generation; GetReload reports whether the latest one is queued/loading, mounted or failed.
//
// Lifecycle contract (reported by upstream.patch into McpLifecycle):
// - mount() returns only after the story mounted: non-React mounters after their render/effects
//   committed, React stories after the story root committed under an error boundary.
// - Require rejection, nil module, invalid story, story errors/yields, renderer errors and React errors
//   fail the mount; the preview is then disposed and mount() throws with the failure and cleanup errors.
// - The returned handle's Cleanup unmounts the root, waits until every HotReloader environment is destroyed
//   and all unmount handlers, FastSpawn story cleanups and the story Janitor finished, resets the bundled
//   store, and throws the aggregated late/cleanup errors. It is idempotent.
// - Mount and cleanup each wait at most TIMEOUT seconds and fail explicitly on timeout.
//
// Controls: every mounter publishes its controls through setActionComponent(key, "ControlsTab", ...), the
// same element the renderer's Controls panel draws. Its props carry the converted control definitions,
// the current values and the mounter's own state setter, so the handle reads and drives exactly that state.

import React from "@rbxts/react";
import { ReflexProvider, useSelector } from "@rbxts/react-reflex";
import { createLegacyRoot, createPortal, Root } from "@rbxts/react-roblox";
import { CreateBoundary, Describe, Lifecycle, ReportError, Track, Untrack } from "McpLifecycle";
import { RootProducer } from "Reflex";
import { GetEntryByKey, selectStoryPreviews } from "Reflex/StoryPreview";
import PreviewController from "UI/StoryPreview/PreviewController";

const TIMEOUT = 20;
const CONTROLS_TAB = "ControlsTab";

const PreviewBoundary = CreateBoundary(React, "McpPreviewBoundary");

let mounted = false;

function WaitUntil(condition: () => boolean, timeout: number) {
	const deadline = os.clock() + timeout;
	while (!condition()) {
		if (os.clock() >= deadline) return false;
		task.wait();
	}
	return true;
}

function PreviewHost(props: { EntryKey: string }) {
	const entry = GetEntryByKey(useSelector(selectStoryPreviews), props.EntryKey);
	return entry ? <PreviewController PreviewEntry={entry} /> : <></>;
}

interface OwnedPreview {
	Key?: string;
	Lifecycle?: Lifecycle;
	Root?: Root;
}

export interface ControlsSnapshot {
	/** Converted control definitions keyed by control name (ControlGroup entries nest their Controls). */
	Controls: Record<string, unknown>;
	/** Current values keyed by control name (ControlGroup values are nested tables). */
	Values: Record<string, unknown>;
}

export interface ReloadStatus {
	/** Load generation: 1 for the initial mount, +1 per hot reload. */
	readonly Generation: number;
	/** "loading" while a reload is queued or has not mounted yet; "failed" when it errored. */
	readonly State: "loading" | "ready" | "failed";
	readonly Error?: string;
}

export interface PreviewHandle {
	/** Mounter the renderer picked for the latest load of the story. */
	readonly GetStoryType: () => string | undefined;
	/** The Frame the story renders into, or undefined once cleaned up. */
	readonly GetRoot: () => Frame | undefined;
	/** Current controls, or undefined when the story declares none. */
	readonly GetControls: () => ControlsSnapshot | undefined;
	/** Replaces the story's control values (pass a complete, new values table). */
	readonly SetControls: (values: Record<string, unknown>) => void;
	readonly GetReload: () => ReloadStatus;
	/** Errors reported after a load mounted or failed (late story, unmount and cleanup errors), oldest first. */
	readonly GetErrors: () => readonly string[];
	readonly Cleanup: () => void;
}

interface ControlsTabProps {
	Controls: Record<string, unknown>;
	ControlValues: Record<string, unknown>;
	SetControlValues: (values: Record<string, unknown>) => void;
}

function GetControlsTab(key: string): ControlsTabProps | undefined {
	const tab = GetEntryByKey(RootProducer.getState(selectStoryPreviews), key)?.ActionComponents.get(CONTROLS_TAB);
	if (tab === undefined) return undefined;
	// React-Lua elements keep their props table on `props`; the ControlsTab element is always <Controls ...>.
	const element = tab.Render as unknown as { props: ControlsTabProps };
	return element.props;
}

function Dispose(preview: OwnedPreview) {
	const { Key: key, Lifecycle: lifecycle, Root: root } = preview;
	const errors: string[] = [];
	if (root) {
		const [unmounted, unmountErr] = pcall(() => root.unmount());
		if (!unmounted) errors.push(Describe(unmountErr));
	}
	if (lifecycle) {
		const finished = WaitUntil(() => lifecycle.LiveEnvironments <= 0 && lifecycle.Pending <= 0, TIMEOUT);
		if (!finished) {
			errors.push(
				`Story preview cleanup timed out after ${TIMEOUT}s (${lifecycle.LiveEnvironments} environments, ${lifecycle.Pending} cleanups pending)`
			);
		}
		for (const err of lifecycle.Errors) errors.push(err);
	}
	if (key !== undefined) Untrack(key);
	const [reset, resetErr] = pcall(() => RootProducer.resetState());
	if (!reset) errors.push(Describe(resetErr));
	mounted = false;
	return errors;
}

export function mount(story: ModuleScript, target: Frame, owner: Plugin): PreviewHandle {
	if (mounted) error("A story preview is already mounted", 2);
	mounted = true;

	const preview: OwnedPreview = {};

	const [started, startErr] = pcall(() => {
		RootProducer.resetState();
		RootProducer.setPlugin(owner);

		const unknownNode: UnknownNode = { Type: "Unknown", Instance: story.Parent ?? story, Children: [] };
		const storyNode: StoryNode = { Type: "Story", Name: story.Name, Module: story, Parent: unknownNode };
		unknownNode.Children.push(storyNode);
		RootProducer.setNodeList([], [unknownNode], new Map([[story, storyNode]]));

		RootProducer.mountOnTop(story);
		RootProducer.getState(selectStoryPreviews).forEach((entry) => {
			if (entry.Module === story) preview.Key = entry.Key;
		});
		const entryKey = preview.Key;
		if (entryKey === undefined) error("The story renderer did not create a preview entry for the story");
		// RecoverControls would snapshot every control after any change and restore all of them on reload,
		// freezing defaults the agent never touched. Reloads start from the story's current defaults instead;
		// the MCP handler re-applies only the controls the agent set.
		RootProducer.setMountData(entryKey, { AutoReload: true, RecoverControls: false });
		preview.Lifecycle = Track(entryKey);

		const root = createLegacyRoot(new Instance("Folder"));
		preview.Root = root;
		root.render(
			createPortal(
				<ReflexProvider producer={RootProducer}>
					<PreviewBoundary OnError={(err: unknown) => ReportError(entryKey, err)}>
						<PreviewHost EntryKey={entryKey} />
					</PreviewBoundary>
				</ReflexProvider>,
				target
			)
		);
	});

	let failure: string | undefined;
	if (!started) {
		failure = Describe(startErr);
	} else if (preview.Lifecycle) {
		const tracked = preview.Lifecycle;
		const settled = WaitUntil(() => tracked.Mounted || tracked.Failure !== undefined, TIMEOUT);
		if (tracked.Failure !== undefined) failure = tracked.Failure;
		else if (!settled) failure = `Story did not mount within ${TIMEOUT}s`;
	}

	if (failure !== undefined) {
		const cleanupErrors = Dispose(preview);
		const details = cleanupErrors.size() > 0 ? `\n\nCleanup errors:\n${cleanupErrors.join("\n")}` : "";
		error(`Story preview mount failed: ${failure}${details}`, 0);
	}

	const key = preview.Key!;
	const tracked = preview.Lifecycle!;
	let disposed = false;
	return {
		GetStoryType: () => tracked.MountType,
		GetRoot: () => (disposed ? undefined : GetEntryByKey(RootProducer.getState(selectStoryPreviews), key)?.Holder),
		GetControls: () => {
			if (disposed) return undefined;
			const tab = GetControlsTab(key);
			if (tab === undefined) return undefined;
			return { Controls: tab.Controls, Values: tab.ControlValues };
		},
		SetControls: (values) => {
			if (disposed) error("The story preview was cleaned up", 2);
			const tab = GetControlsTab(key);
			if (tab === undefined) error("The story declares no controls", 2);
			tab.SetControlValues(values);
		},
		GetReload: () => {
			// A queued reload supersedes the current generation's outcome, including a failure being fixed.
			if (tracked.ReloadQueued) return { Generation: tracked.Generation, State: "loading" };
			if (tracked.Failure !== undefined) {
				return { Generation: tracked.Generation, State: "failed", Error: tracked.Failure };
			}
			return { Generation: tracked.Generation, State: tracked.Mounted ? "ready" : "loading" };
		},
		GetErrors: () => tracked.Errors,
		Cleanup: () => {
			if (disposed) return;
			disposed = true;
			const errors = Dispose(preview);
			if (errors.size() > 0) error(`Story preview cleanup failed:\n${errors.join("\n")}`, 0);
		},
	};
}

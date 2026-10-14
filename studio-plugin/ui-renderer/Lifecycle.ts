// MCP preview lifecycle registry (GPL-3.0, compiled into the bundled story renderer as src/McpLifecycle.ts).
// upstream.patch reports into this module from the renderer's real require/mount/cleanup paths.
// Keys are PreviewEntry.Key values; untracked keys are ignored.

import type React from "@rbxts/react";
import type { ComponentClass, FunctionComponent, ReactNode } from "@rbxts/react";

export interface Lifecycle {
	/** The story module resolved to a value. */
	Loaded: boolean;
	/** Mounter the renderer picked for the story (Functional, ReactLib, RoactLib, VideLib, FusionLib, IrisLib, Generic). */
	MountType?: string;
	/** The story reached its mounted point (non-React: mounter effects committed; React: story root committed). */
	Mounted: boolean;
	/** First error reported before Mounted; the mount failed. */
	Failure?: string;
	/** Errors reported after Mounted or Failure (late story errors, unmount and cleanup errors). */
	Errors: string[];
	/** Started cleanup work that has not finished yet (unmount handlers, FastSpawn story cleanups, Janitor). */
	Pending: number;
	/** HotReloader environments created and not yet fully destroyed. */
	LiveEnvironments: number;
}

const registry = new Map<string, Lifecycle>();

export function Track(key: string): Lifecycle {
	const lifecycle: Lifecycle = { Loaded: false, Mounted: false, Errors: [], Pending: 0, LiveEnvironments: 0 };
	registry.set(key, lifecycle);
	return lifecycle;
}

export function Untrack(key: string) {
	registry.delete(key);
}

export function Describe(err: unknown): string {
	if (Promise.Error.is(err)) return err.trace ?? tostring(err.error);
	if (typeIs(err, "table")) {
		// React-Lua and LuauPolyfill errors are tables with a string `message`; roblox-ts has no `in` narrowing.
		const luaError = err as { message?: unknown };
		if (typeIs(luaError.message, "string")) return luaError.message;
	}
	return tostring(err);
}

export function ReportLoaded(key: string) {
	const lifecycle = registry.get(key);
	if (lifecycle) lifecycle.Loaded = true;
}

export function ReportMountType(key: string, mountType: string) {
	const lifecycle = registry.get(key);
	if (lifecycle) lifecycle.MountType = mountType;
}

export function ReportMounted(key: string) {
	const lifecycle = registry.get(key);
	if (lifecycle && lifecycle.Failure === undefined) lifecycle.Mounted = true;
}

export function ReportError(key: string, err: unknown) {
	const lifecycle = registry.get(key);
	if (!lifecycle) return;
	if (!lifecycle.Mounted && lifecycle.Failure === undefined) {
		lifecycle.Failure = Describe(err);
	} else {
		lifecycle.Errors.push(Describe(err));
	}
}

export function ReportEnvironmentCreated(key: string) {
	const lifecycle = registry.get(key);
	if (lifecycle) lifecycle.LiveEnvironments += 1;
}

export function ReportEnvironmentDestroyed(key: string) {
	const lifecycle = registry.get(key);
	if (lifecycle) lifecycle.LiveEnvironments -= 1;
}

/** Marks cleanup work as started; the returned release (idempotent) finishes it, recording `err` if given. */
export function HoldCleanup(key: string): (err?: unknown) => void {
	const lifecycle = registry.get(key);
	if (!lifecycle) return () => {};
	lifecycle.Pending += 1;
	let released = false;
	return (err?: unknown) => {
		if (released) return;
		released = true;
		lifecycle.Pending -= 1;
		if (err !== undefined) lifecycle.Errors.push(Describe(err));
	};
}

export interface BoundaryProps {
	OnError: (err: unknown) => void;
	OnMount?: () => void;
	OnUnmount?: () => void;
	children?: ReactNode;
}

interface BoundaryInstance {
	props: BoundaryProps;
	state?: { McpError?: string };
}

interface BoundaryClass {
	init?: (this: BoundaryInstance) => void;
	render?: (this: BoundaryInstance) => unknown;
	componentDidMount?: (this: BoundaryInstance) => void;
	componentDidCatch?: (this: BoundaryInstance, err: unknown) => void;
	componentWillUnmount?: (this: BoundaryInstance) => void;
	getDerivedStateFromError?: (this: void, err: unknown) => { McpError: string };
}

interface ReactWithComponent {
	Component: { extend(name: string): BoundaryClass };
}

/**
 * Error boundary built from the given React module's own Component (the bundled React, or a story's React copy).
 * OnMount fires when the boundary itself committed (so OnUnmount is guaranteed later); it is not story readiness.
 * React-Lua 17.3.7 calls `class.init(instance, props)`, `ctor.getDerivedStateFromError(err)` (no self) and
 * lifecycle methods as `instance:method(...)`, matching the definitions below.
 */
export function CreateBoundary(react: unknown, name: string): ComponentClass<BoundaryProps> {
	// Every React-Lua module exposes Component:extend; story React copies are untyped here.
	const reactModule = react as ReactWithComponent;
	const component = reactModule.Component.extend(name);
	component.init = function (this: BoundaryInstance) {
		this.state = {};
	};
	component.getDerivedStateFromError = (err: unknown) => ({ McpError: Describe(err) });
	component.render = function (this: BoundaryInstance) {
		if (this.state?.McpError !== undefined) return undefined;
		return this.props.children;
	};
	component.componentDidMount = function (this: BoundaryInstance) {
		this.props.OnMount?.();
	};
	component.componentDidCatch = function (this: BoundaryInstance, err: unknown) {
		this.props.OnError(err);
	};
	component.componentWillUnmount = function (this: BoundaryInstance) {
		this.props.OnUnmount?.();
	};
	// The class is assembled at runtime through Component:extend, so TypeScript cannot see it as a ComponentClass.
	return component as unknown as ComponentClass<BoundaryProps>;
}

export interface CommitBeaconProps {
	OnCommit: () => void;
	children?: ReactNode;
}

/**
 * Function component from the given React whose passive effect runs after its children's passive effects.
 * OnCommit is deferred: an error thrown by a child's effect is captured and rendered into the boundary
 * (componentDidCatch) synchronously at the end of the same passive flush, so ReportError wins over ReportMounted.
 */
export function CreateCommitBeacon(react: typeof React): FunctionComponent<CommitBeaconProps> {
	return (props: CommitBeaconProps) => {
		react.useEffect(() => {
			task.defer(props.OnCommit);
		}, []);
		return react.createElement(react.Fragment, undefined, props.children);
	};
}

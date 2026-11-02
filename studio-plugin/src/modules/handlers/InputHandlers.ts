// Virtual input via UserInputService:CreateVirtualInput().
//
// We deliberately do NOT use VirtualInputManager:Send*Event — those methods
// are gated behind RobloxScriptSecurity ("lacking capability RobloxScript")
// in every context a plugin can reach (edit DM, play server/client DMs), so
// they silently never worked. CreateVirtualInput() is callable without that
// capability and drives the REAL input pipeline: SendKey feeds
// UserInputService.InputBegan/Ended and the control modules (so WASD walks the
// character at full WalkSpeed with controls intact, no Humanoid hijack),
// SendMouseButton feeds UIS and activates GUI buttons, SendMousePosition moves
// the cursor (hover, MouseEnter, InputChanged), SendPointerAction scrolls
// under a position, and SendTextInput types into the focused TextBox. Every method throws when the
// input would hit interactive CoreGui.
//
// Verified live on a play client: move and scroll reach game scripts with
// the device simulator stopped. Under touch device emulation the client has
// no mouse: clicks arrive as Touch, scroll still works, but moves never reach
// the game, so we reject move there instead of returning a false success.
//
// SendMouseDelta is deliberately NOT exposed. It only works while the cursor
// is locked (MouseBehavior.LockCenter), and on desktop Studio holds that lock
// by pinning and hiding the user's real OS cursor — an unacceptable takeover
// of the host's input.
//
// Coordinate space: SendMouseButton coordinates are viewport pixels matching
// what capture_screenshot returns (window space, origin at the top-left of the
// rendered viewport). Pass screenshot pixel coordinates straight through. Note
// that UserInputService reports input positions in GUI space, which is offset
// from this by GuiService:GetGuiInset() (~58px on the Y axis) — irrelevant for
// callers who pick coordinates off a screenshot, which is why we do not
// translate here.

import * as RenderMonitor from "../RenderMonitor";

const UserInputService = game.GetService("UserInputService");

interface VirtualInput {
	SendKey(isDown: boolean, keyCode: Enum.KeyCode): void;
	SendMouseButton(position: Vector2, inputType: Enum.UserInputType, isDown: boolean): void;
	SendMousePosition(position: Vector2): void;
	SendPointerAction(position: Vector2, pointerAction: { Wheel: number }): void;
	SendTextInput(text: string): void;
}

// One VirtualInput per plugin VM, reused across calls so that a key held down
// in one call (action="press") and released in a later call (action="release")
// share the same input source.
let cachedVI: VirtualInput | undefined;

function getVI(): VirtualInput | undefined {
	if (cachedVI) return cachedVI;
	const [ok, vi] = pcall(() => {
		return (UserInputService as unknown as { CreateVirtualInput(): unknown }).CreateVirtualInput();
	});
	if (ok && vi !== undefined) {
		cachedVI = vi as VirtualInput;
		return cachedVI;
	}
	return undefined;
}

const MOUSE_TYPE_MAP: Record<string, Enum.UserInputType> = {
	Left: Enum.UserInputType.MouseButton1,
	Right: Enum.UserInputType.MouseButton2,
	Middle: Enum.UserInputType.MouseButton3,
};

const NO_MOUSE_ERROR =
	"This client has no mouse (touch device emulation is active), so cursor movement never reaches the game. " +
	"Stop it with set_device_simulator stopSimulation=true, then retry.";

const RELEASE_RETRY_NOTE = " The release will be re-sent when the window renders again.";

// Releases that may not have reached the engine (sent while the window wasn't
// rendering, or the up event threw). Re-sent on the next stale→fresh frame.
// Mouse entries keep the position the release should be sent at.
const pendingKeyReleases = new Set<Enum.KeyCode>();
const pendingButtonReleases = new Map<Enum.UserInputType, Vector2>();

function flushPendingReleases(): void {
	const vi = cachedVI;
	if (vi) {
		for (const keyCode of pendingKeyReleases) {
			pcall(() => vi.SendKey(false, keyCode));
		}
		for (const [inputType, pos] of pendingButtonReleases) {
			pcall(() => vi.SendMouseButton(pos, inputType, false));
		}
	}
	pendingKeyReleases.clear();
	pendingButtonReleases.clear();
}

RenderMonitor.onRenderResumed(flushPendingReleases);

const MOUSE_ACTIONS = new Set(["click", "mouseDown", "mouseUp", "move", "scroll"]);
const KEY_ACTIONS = new Set(["press", "release", "tap"]);

function simulateMouseInput(requestData: Record<string, unknown>) {
	const action = requestData.action as string;
	const x = requestData.x as number | undefined;
	const y = requestData.y as number | undefined;
	const button = (requestData.button as string) ?? "Left";
	const wheel = requestData.wheel as number | undefined;

	if (!action) return { error: "action is required" };
	if (x === undefined || y === undefined) {
		return { error: "x and y are required" };
	}
	if (!MOUSE_ACTIONS.has(action)) {
		return { error: `Unsupported action "${action}". Use click, mouseDown, mouseUp, move, or scroll.` };
	}
	if (action === "scroll" && (!typeIs(wheel, "number") || wheel === 0)) {
		return { error: "wheel must be a non-zero number for scroll" };
	}

	// Input is silently dropped by the engine when the window isn't rendering
	// (e.g. minimized). Surface that instead of returning a false success.
	// mouseUp is exempt: a held button must always be releasable.
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined && action !== "mouseUp") return { error: notRendering };

	if (action === "move" && !UserInputService.MouseEnabled) {
		return { error: NO_MOUSE_ERROR };
	}

	const vi = getVI();
	if (!vi) {
		return { error: "UserInputService:CreateVirtualInput() is not available in this context" };
	}

	const inputType = MOUSE_TYPE_MAP[button] ?? Enum.UserInputType.MouseButton1;
	const pos = new Vector2(x, y);
	const result: Record<string, unknown> = { success: true, action, x, y };
	if (action === "scroll") result.wheel = wheel;
	else if (action !== "move") result.button = button;

	if (action === "mouseUp") {
		const [ok, err] = pcall(() => vi.SendMouseButton(pos, inputType, false));
		if (notRendering !== undefined) {
			// The engine may drop this while not rendering; never report it as delivered.
			pendingButtonReleases.set(inputType, pos);
			result.deliveryConfirmed = false;
			result.warning = ok
				? notRendering + RELEASE_RETRY_NOTE
				: `${notRendering} Sending the release failed: ${err}.${RELEASE_RETRY_NOTE}`;
			return result;
		}
		if (!ok) {
			pendingButtonReleases.set(inputType, pos);
			return { error: `Failed to simulate mouse input: ${err}. The ${button} button may still be held.` };
		}
		pendingButtonReleases.delete(inputType);
		return result;
	}

	if (action === "click" || action === "mouseDown") {
		const [downOk, downErr] = pcall(() => vi.SendMouseButton(pos, inputType, true));
		if (!downOk) return { error: `Failed to simulate mouse input: ${downErr}` };
		pendingButtonReleases.delete(inputType);
		if (action === "mouseDown") return result;

		// Down landed, so the up must run even if something fails in between.
		task.wait(0.05);
		const [upOk, upErr] = pcall(() => vi.SendMouseButton(pos, inputType, false));
		if (!upOk) {
			pendingButtonReleases.set(inputType, pos);
			return {
				error:
					`Click pressed ${button} but releasing it failed: ${upErr}. ` +
					`The ${button} button may still be held; call simulate_mouse_input with action="mouseUp" to release it.`,
			};
		}
		const staleAfter = RenderMonitor.notRenderingReason();
		if (staleAfter !== undefined) {
			// The window stopped rendering during the hold; the up may have been dropped.
			pendingButtonReleases.set(inputType, pos);
			result.deliveryConfirmed = false;
			result.warning = staleAfter + RELEASE_RETRY_NOTE;
		}
		return result;
	}

	const [success, err] = pcall(() => {
		if (action === "move") {
			vi.SendMousePosition(pos);
		} else {
			vi.SendPointerAction(pos, { Wheel: wheel as number });
		}
	});

	if (success) return result;
	return { error: `Failed to simulate mouse input: ${err}` };
}

function simulateKeyboardInput(requestData: Record<string, unknown>) {
	const text = requestData.text as string | undefined;
	const keyCodeName = requestData.keyCode as string;
	const action = (requestData.action as string) ?? "tap";
	const duration = (requestData.duration as number) ?? 0.1;

	// Validate before the render gate so bad arguments report themselves.
	let keyCode: Enum.KeyCode | undefined;
	if (text === undefined) {
		if (!keyCodeName) return { error: "keyCode (or text) is required" };
		const [enumOk, found] = pcall(() => {
			return (Enum.KeyCode as unknown as Record<string, Enum.KeyCode>)[keyCodeName];
		});
		if (!enumOk || !found) {
			return {
				error: `Unknown keyCode: ${keyCodeName}. Use Enum.KeyCode names like "W", "Space", "E", "LeftShift", etc.`,
			};
		}
		keyCode = found;
		if (!KEY_ACTIONS.has(action)) return { error: `Unknown action: ${action}. Use press, release, or tap.` };
	}

	// release is exempt: a held key must always be releasable.
	const notRendering = RenderMonitor.notRenderingReason();
	const isRelease = text === undefined && action === "release";
	if (notRendering !== undefined && !isRelease) return { error: notRendering };

	const vi = getVI();
	if (!vi) {
		return { error: "UserInputService:CreateVirtualInput() is not available in this context" };
	}

	// Text mode: type a string into the focused TextBox.
	if (text !== undefined) {
		const [ok, err] = pcall(() => vi.SendTextInput(text));
		if (ok) return { success: true, text };
		return { error: `Failed to send text input: ${err}` };
	}

	const key = keyCode as Enum.KeyCode;
	const result: Record<string, unknown> = { success: true, keyCode: keyCodeName, action };

	if (action === "release") {
		const [ok, err] = pcall(() => vi.SendKey(false, key));
		if (notRendering !== undefined) {
			// The engine may drop this while not rendering; never report it as delivered.
			pendingKeyReleases.add(key);
			result.deliveryConfirmed = false;
			result.warning = ok
				? notRendering + RELEASE_RETRY_NOTE
				: `${notRendering} Sending the release failed: ${err}.${RELEASE_RETRY_NOTE}`;
			return result;
		}
		if (!ok) {
			pendingKeyReleases.add(key);
			return { error: `Failed to simulate keyboard input: ${err}. Key ${keyCodeName} may still be held.` };
		}
		pendingKeyReleases.delete(key);
		return result;
	}

	const [downOk, downErr] = pcall(() => vi.SendKey(true, key));
	if (!downOk) return { error: `Failed to simulate keyboard input: ${downErr}` };
	pendingKeyReleases.delete(key);
	if (action === "press") return result;

	// tap: the down landed, so the up must run even if something fails in between.
	task.wait(duration);
	const [upOk, upErr] = pcall(() => vi.SendKey(false, key));
	if (!upOk) {
		pendingKeyReleases.add(key);
		return {
			error:
				`Tap pressed ${keyCodeName} but releasing it failed: ${upErr}. ` +
				`Key ${keyCodeName} may still be held; call simulate_keyboard_input with action="release" to release it.`,
		};
	}
	const staleAfter = RenderMonitor.notRenderingReason();
	if (staleAfter !== undefined) {
		// The window stopped rendering during the hold; the up may have been dropped.
		pendingKeyReleases.add(key);
		result.deliveryConfirmed = false;
		result.warning = staleAfter + RELEASE_RETRY_NOTE;
	}
	return result;
}

export = {
	simulateMouseInput,
	simulateKeyboardInput,
};

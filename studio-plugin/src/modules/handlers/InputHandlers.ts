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
	if (action === "scroll" && (!typeIs(wheel, "number") || wheel === 0)) {
		return { error: "wheel must be a non-zero number for scroll" };
	}

	// Input is silently dropped by the engine when the window isn't rendering
	// (e.g. minimized). Surface that instead of returning a false success.
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined) return { error: notRendering };

	if (action === "move" && !UserInputService.MouseEnabled) {
		return { error: NO_MOUSE_ERROR };
	}

	const vi = getVI();
	if (!vi) {
		return { error: "UserInputService:CreateVirtualInput() is not available in this context" };
	}

	const inputType = MOUSE_TYPE_MAP[button] ?? Enum.UserInputType.MouseButton1;
	const pos = new Vector2(x, y);

	const [success, err] = pcall(() => {
		if (action === "click") {
			vi.SendMouseButton(pos, inputType, true);
			task.wait(0.05);
			vi.SendMouseButton(pos, inputType, false);
		} else if (action === "mouseDown") {
			vi.SendMouseButton(pos, inputType, true);
		} else if (action === "mouseUp") {
			vi.SendMouseButton(pos, inputType, false);
		} else if (action === "move") {
			vi.SendMousePosition(pos);
		} else if (action === "scroll") {
			vi.SendPointerAction(pos, { Wheel: wheel as number });
		} else {
			error(
				`Unsupported action "${action}". Use click, mouseDown, mouseUp, move, or scroll.`,
			);
		}
	});

	if (success) {
		const result: Record<string, unknown> = { success: true, action, x, y };
		if (action === "scroll") result.wheel = wheel;
		else if (action !== "move") result.button = button;
		return result;
	}
	return { error: `Failed to simulate mouse input: ${err}` };
}

function simulateKeyboardInput(requestData: Record<string, unknown>) {
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined) return { error: notRendering };

	const vi = getVI();
	if (!vi) {
		return { error: "UserInputService:CreateVirtualInput() is not available in this context" };
	}

	// Text mode: type a string into the focused TextBox.
	const text = requestData.text as string | undefined;
	if (text !== undefined) {
		const [ok, err] = pcall(() => vi.SendTextInput(text));
		if (ok) return { success: true, text };
		return { error: `Failed to send text input: ${err}` };
	}

	const keyCodeName = requestData.keyCode as string;
	if (!keyCodeName) return { error: "keyCode (or text) is required" };

	const action = (requestData.action as string) ?? "tap";
	const duration = (requestData.duration as number) ?? 0.1;

	const [enumOk, keyCode] = pcall(() => {
		return (Enum.KeyCode as unknown as Record<string, Enum.KeyCode>)[keyCodeName];
	});
	if (!enumOk || !keyCode) {
		return {
			error: `Unknown keyCode: ${keyCodeName}. Use Enum.KeyCode names like "W", "Space", "E", "LeftShift", etc.`,
		};
	}

	const [success, err] = pcall(() => {
		if (action === "press") {
			vi.SendKey(true, keyCode);
		} else if (action === "release") {
			vi.SendKey(false, keyCode);
		} else if (action === "tap") {
			vi.SendKey(true, keyCode);
			task.wait(duration);
			vi.SendKey(false, keyCode);
		} else {
			error(`Unknown action: ${action}`);
		}
	});

	if (success) {
		return { success: true, keyCode: keyCodeName, action };
	}
	return { error: `Failed to simulate keyboard input: ${err}` };
}

export = {
	simulateMouseInput,
	simulateKeyboardInput,
};

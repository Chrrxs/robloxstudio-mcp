// Virtual input via UserInputService:CreateVirtualInput().
//
// We deliberately do NOT use VirtualInputManager:Send*Event — those methods
// are gated behind RobloxScriptSecurity ("lacking capability RobloxScript")
// in every context a plugin can reach (edit DM, play server/client DMs), so
// they silently never worked. CreateVirtualInput() is callable without that
// capability and drives the REAL input pipeline: SendKey feeds
// UserInputService.InputBegan/Ended and the control modules (so WASD walks the
// character at full WalkSpeed with controls intact, no Humanoid hijack),
// SendMouseButton feeds UIS and activates GUI buttons, in the edit DataModel
// too (StarterGui UI shown through ShowDevelopmentGui), but rejects positions
// over CoreGui UI ("position hits CoreGUI"); SendTextInput types into the
// focused TextBox.
//
// Method set on the VirtualInput object (verified live):
//   SendKey(isDown: boolean, keyCode: Enum.KeyCode)
//   SendMouseButton(position: Vector2, inputType: Enum.UserInputType, isDown: boolean)
//   SendTextInput(text: string)
// There is NO SendMouseMove / SendMouseWheel / SendKeyEvent — so "move" and
// "scroll" mouse actions are not supported.
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

export interface VirtualInput {
	SendKey(isDown: boolean, keyCode: Enum.KeyCode): void;
	SendMouseButton(position: Vector2, inputType: Enum.UserInputType, isDown: boolean): void;
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

// Input is silently dropped by the engine when the window isn't rendering
// (e.g. minimized), so callers get that reason instead of a false success.
export function readyVirtualInput(): VirtualInput | string {
	const notRendering = RenderMonitor.notRenderingReason();
	if (notRendering !== undefined) return notRendering;
	return getVI() ?? "UserInputService:CreateVirtualInput() is not available in this context";
}

const MOUSE_TYPE_MAP: Record<string, Enum.UserInputType> = {
	Left: Enum.UserInputType.MouseButton1,
	Right: Enum.UserInputType.MouseButton2,
	Middle: Enum.UserInputType.MouseButton3,
};

function simulateMouseInput(requestData: Record<string, unknown>) {
	const action = requestData.action as string;
	const x = requestData.x as number | undefined;
	const y = requestData.y as number | undefined;
	const button = (requestData.button as string) ?? "Left";

	if (!action) return { error: "action is required" };
	if (x === undefined || y === undefined) {
		return { error: "x and y are required" };
	}

	const vi = readyVirtualInput();
	if (typeIs(vi, "string")) return { error: vi };

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
		} else {
			error(
				`Unsupported action "${action}". CreateVirtualInput supports click, mouseDown, mouseUp ` +
					`(no move/scroll — those methods don't exist on VirtualInput).`,
			);
		}
	});

	if (success) {
		return { success: true, action, x, y, button };
	}
	return { error: `Failed to simulate mouse input: ${err}` };
}

function simulateKeyboardInput(requestData: Record<string, unknown>) {
	const vi = readyVirtualInput();
	if (typeIs(vi, "string")) return { error: vi };

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

export default {
	simulateMouseInput,
	simulateKeyboardInput,
};

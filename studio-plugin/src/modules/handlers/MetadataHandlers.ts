import Utils from "../Utils";
import LuauExec from "../LuauExec";

const Selection = game.GetService("Selection");

const { getInstancePath, getInstanceByPath } = Utils;

function serializeValue(value: unknown): unknown {
	const vType = typeOf(value);
	if (vType === "Vector3") {
		const v = value as Vector3;
		return { X: v.X, Y: v.Y, Z: v.Z, _type: "Vector3" };
	} else if (vType === "Color3") {
		const v = value as Color3;
		return { R: v.R, G: v.G, B: v.B, _type: "Color3" };
	} else if (vType === "CFrame") {
		const v = value as CFrame;
		return { Position: { X: v.Position.X, Y: v.Position.Y, Z: v.Position.Z }, _type: "CFrame" };
	} else if (vType === "UDim2") {
		const v = value as UDim2;
		return {
			X: { Scale: v.X.Scale, Offset: v.X.Offset },
			Y: { Scale: v.Y.Scale, Offset: v.Y.Offset },
			_type: "UDim2",
		};
	} else if (vType === "BrickColor") {
		const v = value as BrickColor;
		return { Name: v.Name, _type: "BrickColor" };
	}
	return value;
}

function getAttributes(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	if (!instancePath) return { error: "Instance path is required" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const [success, result] = pcall(() => {
		const attributes = instance.GetAttributes();
		const serializedAttributes: Record<string, { value: unknown; type: string }> = {};
		let count = 0;

		for (const [name, value] of pairs(attributes)) {
			serializedAttributes[name as string] = {
				value: serializeValue(value),
				type: typeOf(value),
			};
			count++;
		}

		return { instancePath, attributes: serializedAttributes, count };
	});

	if (success) return result;
	return { error: `Failed to get attributes: ${result}` };
}

function getSelection(_requestData: Record<string, unknown>) {
	const selection = Selection.Get();

	if (selection.size() === 0) {
		return { success: true, selection: [], count: 0, message: "No objects selected" };
	}

	const selectedObjects = selection.map((instance: Instance) => ({
		name: instance.Name,
		className: instance.ClassName,
		path: getInstancePath(instance),
		parent: instance.Parent ? getInstancePath(instance.Parent) : undefined,
	}));

	return {
		success: true,
		selection: selectedObjects,
		count: selection.size(),
		message: `${selection.size()} object(s) selected`,
	};
}

// The counterpart to getSelection: this sets it. Selecting what the agent just
// built shows the user the result and puts the instance under Studio's own
// move/scale handles, which is why it is a tool and not left to execute_luau.
function setSelection(requestData: Record<string, unknown>) {
	const rawPaths = requestData.paths;
	if (!typeIs(rawPaths, "table")) {
		return { error: "paths is required (array of instance paths; empty array clears the selection)" };
	}

	const mode = (requestData.mode as string) ?? "set";
	if (mode !== "set" && mode !== "add" && mode !== "remove") {
		return { error: `mode must be "set", "add" or "remove" (got: ${mode})` };
	}

	const targets: Instance[] = [];
	const missing: string[] = [];
	for (const entry of rawPaths as unknown[]) {
		const path = tostring(entry);
		const instance = getInstanceByPath(path);
		if (instance) {
			targets.push(instance);
		} else {
			missing.push(path);
		}
	}

	if (targets.size() === 0) {
		return { error: "No matching instances found for any path", missingPaths: missing };
	}

	const [ok, err] = pcall(() => {
		if (mode === "add") {
			Selection.Add(targets);
		} else if (mode === "remove") {
			Selection.Remove(targets);
		} else {
			Selection.Set(targets);
		}
	});

	if (!ok) return { error: `Selection.${mode} failed: ${tostring(err)}` };

	return {
		success: true,
		mode,
		selected: targets.size(),
		missingPaths: missing,
		message:
			mode === "remove"
				? `Deselected ${targets.size()} object(s)`
				: `${targets.size()} object(s) ${mode === "add" ? "added to" : "in"} the selection`,
	};
}

// Aims the Studio camera at an instance and frames it from a sensible angle.
// This completes the screenshot loop capture_screenshot documents: build,
// focus, screenshot. Framing distance comes from the bounding box and the
// camera's own field of view so any subject fills a similar share of frame.
function focusViewport(requestData: Record<string, unknown>) {
	const instancePath = requestData.path as string;
	if (!instancePath) return { error: "path is required (the instance to frame)" };

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const workspace = game.GetService("Workspace");
	// CurrentCamera is nil in rare windows (headless edit sessions, mid-swap);
	// better a clear error than a nil deref inside the pcall.
	const camera = workspace.CurrentCamera;
	if (!camera) return { error: "Workspace.CurrentCamera is unavailable right now" };

	const padding = tonumber(requestData.padding as number) ?? 1;
	if (padding <= 0 || padding > 10) {
		return { error: "padding must be between 0 (exclusive) and 10" };
	}

	// Where we view from. Default elevation keeps most subjects readable
	// (straight-on hides the top face); `from` picks the compass direction.
	let angleY = tonumber(requestData.angleY as number) ?? 20;
	if (angleY > 89) angleY = 89;
	if (angleY < -89) angleY = -89;
	const compassDeg = tonumber(requestData.from as number) ?? 215;

	const [ok, err] = pcall(() => {
		// Only parts and models have a 3D extent; folders and scripts don't.
		// Report that as a readable message instead of a raw API error.
		let boundsCF: CFrame;
		let boundsSize: Vector3;
		if (instance.IsA("Model")) {
			[boundsCF, boundsSize] = instance.GetBoundingBox();
		} else if (instance.IsA("BasePart")) {
			boundsCF = instance.CFrame;
			boundsSize = instance.Size;
		} else {
			return error(
				`Cannot frame a ${instance.ClassName}: it has no 3D bounding box. Frame a part or model instead.`
			);
		}
		const radius = math.max(boundsSize.X, math.max(boundsSize.Y, boundsSize.Z)) / 2;

		// Half the vertical FOV plus half the horizontal FOV (via aspect ratio)
		// must both cover the subject; solve for distance with a little margin.
		const fovY = math.rad(camera.FieldOfView);
		const viewport = camera.ViewportSize;
		const fovX = 2 * math.atan(math.tan(fovY / 2) * (viewport.X / math.max(viewport.Y, 1)));
		const fitDistance = radius / math.sin(math.min(fovY, fovX) / 2);

		const yaw = math.rad(compassDeg);
		const pitch = math.rad(angleY);
		const direction = new Vector3(math.cos(pitch) * math.cos(yaw), math.sin(pitch), math.cos(pitch) * math.sin(yaw));
		const eye = boundsCF.Position.add(direction.Unit.mul(fitDistance * padding));

		camera.CFrame = CFrame.lookAt(eye, boundsCF.Position);

		// In edit mode the camera can be re-owned by Studio's camera scripts on
		// the next input; setting CameraType pins our shot until the user moves.
		camera.CameraType = Enum.CameraType.Scriptable;
	});

	if (!ok) return { error: `focus failed: ${tostring(err)}` };

	return {
		success: true,
		path: getInstancePath(instance),
		cameraPosition: {
			X: camera.CFrame.Position.X,
			Y: camera.CFrame.Position.Y,
			Z: camera.CFrame.Position.Z,
		},
		message: "Camera framed on target. Take capture_screenshot now.",
	};
}

function executeLuau(requestData: Record<string, unknown>) {
	const code = requestData.code as string;
	if (!code || code === "") return { error: "Code is required" };
	// All wrapping, print/warn capture, loadstring fallback, JSON-encoding
	// of table returns, and parse-error recovery live in LuauExec so the
	// edit/server (this handler) and the play-client (ClientBroker) take
	// the same code path and produce identical output shapes.
	return LuauExec.execute(code);
}

export = {
	getAttributes,
	getSelection,
	setSelection,
	focusViewport,
	executeLuau,
};

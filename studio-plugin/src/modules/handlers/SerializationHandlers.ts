import PeerRole from "../PeerRole";
import Utils from "../Utils";
import Recording from "../Recording";

// SerializationService:SerializeInstancesAsync / DeserializeInstancesAsync were
// added in engine v668 and are PluginSecurity. They are not in @rbxts/types yet,
// so we resolve the service through an untyped GetService cast and treat the
// methods as opaque (buffer in / buffer out).
type SerializationServiceShape = {
	SerializeInstancesAsync(this: SerializationServiceShape, instances: Instance[]): buffer;
	DeserializeInstancesAsync(this: SerializationServiceShape, b: buffer): Instance[];
};

const SerializationService = (game as unknown as {
	GetService(name: string): SerializationServiceShape;
}).GetService("SerializationService");

// EncodingService:Base64Encode / Base64Decode take and return `buffer` (not
// `string`). The signature is in @rbxts/types under None.d.ts so a normal
// GetService("EncodingService") would already give correct types, but @rbxts
// generates a per-service nominal interface and roblox.d.ts doesn't re-export
// EncodingService from the services barrel module - so the typed cast below
// matches what GetService would give us if it did.
type EncodingServiceShape = {
	Base64Encode(this: EncodingServiceShape, input: buffer): buffer;
	Base64Decode(this: EncodingServiceShape, input: buffer): buffer;
};

const EncodingService = (game as unknown as {
	GetService(name: string): EncodingServiceShape;
}).GetService("EncodingService");

const { getInstanceByPath, getInstancePath } = Utils;
const { beginRecording, finishRecording } = Recording;

function subtreeSize(inst: Instance): number {
	return inst.GetDescendants().size() + 1;
}

function isServiceClass(inst: Instance): boolean {
	const [ok, service] = pcall(() => game.GetService(inst.ClassName as keyof Services));
	return ok && service !== undefined;
}

function isLockedParentError(message: string): boolean {
	const lower = string.lower(message);
	return (
		string.find(lower, "cannot change parent", 1, true)[0] !== undefined ||
		string.find(lower, "locked", 1, true)[0] !== undefined
	);
}

function exportRbxm(requestData: Record<string, unknown>): unknown {
	const instancePaths = requestData.instance_paths as string[] | undefined;
	if (!instancePaths || !typeIs(instancePaths, "table") || instancePaths.size() === 0) {
		return { error: "instance_paths must be a non-empty array" };
	}

	const instances: Instance[] = [];
	for (const p of instancePaths) {
		const inst = getInstanceByPath(p);
		if (!inst) {
			return { error: `instance not found: ${p}` };
		}
		instances.push(inst);
	}

	const [serializeOk, serializeResult] = pcall(() => {
		return SerializationService.SerializeInstancesAsync(instances);
	});
	if (!serializeOk) {
		return { error: `SerializeInstancesAsync failed: ${tostring(serializeResult)}` };
	}

	const buf = serializeResult as buffer;
	const [encodeOk, encodeResult] = pcall(() => EncodingService.Base64Encode(buf));
	if (!encodeOk) {
		return { error: `EncodingService:Base64Encode failed: ${tostring(encodeResult)}` };
	}
	// Base64Encode returns a buffer of ASCII bytes; convert to a Lua string so
	// HttpService:JSONEncode (called by the harness in Communication.ts) accepts
	// it. Base64 is by definition pure ASCII so this round-trips cleanly.
	const base64Str = buffer.tostring(encodeResult as buffer);

	let instanceCount = 0;
	const rootClasses: string[] = [];
	const rootNames: string[] = [];
	for (const inst of instances) {
		instanceCount += subtreeSize(inst);
		rootClasses.push(inst.ClassName);
		rootNames.push(inst.Name);
	}

	return {
		base64: base64Str,
		instance_count: instances.size(),
		bytes: buffer.len(buf),
		instanceCount,
		rootClass: rootClasses[0],
		rootName: rootNames[0],
		rootClasses,
		rootNames,
	};
}

function importRbxm(requestData: Record<string, unknown>): unknown {
	const b64 = requestData.base64 as string | undefined;
	const parentPath = requestData.parent_path as string | undefined;
	const sourceLabel = (requestData.source_label as string | undefined) ?? "unknown";

	if (!b64 || !typeIs(b64, "string")) {
		return { error: "base64 payload is required" };
	}
	if (!parentPath || !typeIs(parentPath, "string")) {
		return { error: "parent_path is required" };
	}

	const parentInstance = getInstanceByPath(parentPath);
	if (!parentInstance) {
		return { error: `parent instance not found: ${parentPath}` };
	}

	// b64 is an ASCII-only Lua string from the wire; lift it into a buffer for
	// EncodingService:Base64Decode, which returns a buffer of raw rbxm bytes
	// ready for DeserializeInstancesAsync.
	const [b64BufOk, b64BufResult] = pcall(() => buffer.fromstring(b64));
	if (!b64BufOk) {
		return { error: `buffer.fromstring(base64) failed: ${tostring(b64BufResult)}` };
	}
	const [decodeOk, decodeResult] = pcall(() => EncodingService.Base64Decode(b64BufResult as buffer));
	if (!decodeOk) {
		return { error: `EncodingService:Base64Decode failed: ${tostring(decodeResult)}` };
	}
	const buf = decodeResult as buffer;

	const [deserOk, deserResult] = pcall(() => {
		return SerializationService.DeserializeInstancesAsync(buf);
	});
	if (!deserOk) {
		return { error: `DeserializeInstancesAsync failed: ${tostring(deserResult)}` };
	}
	const deserializedRoots = deserResult as Instance[];

	// All-or-nothing parenting. Track every instance we've attached and roll back
	// (unparent + Destroy) if any later one fails - partial imports leave the DM
	// in a worse state than failing cleanly.
	const isEdit = PeerRole.detect() === "edit";
	const recordingId = isEdit ? beginRecording(`Import rbxm`) : undefined;

	const attached: Instance[] = [];
	const unwrappedServiceRoots: string[] = [];
	let failureMessage: string | undefined;
	const attach = (inst: Instance): string | undefined => {
		const [parentOk, parentErr] = pcall(() => {
			inst.Parent = parentInstance;
		});
		if (parentOk) {
			attached.push(inst);
			return undefined;
		}
		return tostring(parentErr);
	};
	const describeFailure = (inst: Instance, message: string) =>
		`failed to parent ${inst.Name} (${inst.ClassName}) under ${parentPath}: ${message}`;
	for (const root of deserializedRoots) {
		if (!isServiceClass(root)) {
			const rootError = attach(root);
			if (rootError === undefined) continue;
			if (!isLockedParentError(rootError)) {
				failureMessage = describeFailure(root, rootError);
				break;
			}
		}
		unwrappedServiceRoots.push(root.ClassName);
		for (const child of root.GetChildren()) {
			const childError = attach(child);
			if (childError !== undefined) {
				failureMessage = describeFailure(child, childError);
				break;
			}
		}
		if (failureMessage !== undefined) break;
	}

	if (failureMessage !== undefined) {
		for (const inst of attached) {
			pcall(() => {
				inst.Parent = undefined;
				inst.Destroy();
			});
		}
		// Also destroy any unparented deserialized instances so they don't leak.
		for (const inst of deserializedRoots) {
			pcall(() => inst.Destroy());
		}
		finishRecording(recordingId, false);
		return { error: failureMessage };
	}

	for (const root of deserializedRoots) {
		if (root.Parent === undefined) {
			pcall(() => root.Destroy());
		}
	}

	const names: string[] = [];
	const paths: string[] = [];
	const rootClasses: string[] = [];
	let instanceCount = 0;
	for (const inst of attached) {
		names.push(inst.Name);
		paths.push(getInstancePath(inst));
		rootClasses.push(inst.ClassName);
		instanceCount += subtreeSize(inst);
	}

	// The recording shows "MCP: Import rbxm" in Studio's undo stack -
	// ChangeHistoryService doesn't expose a way to set a richer displayName
	// after TryBeginRecording, so the count/source only land in the JSON response.
	finishRecording(recordingId, true);

	return {
		instance_count: attached.size(),
		instance_names: names,
		instance_paths: paths,
		parent_path: parentPath,
		source: sourceLabel,
		instanceCount,
		rootNames: names,
		rootClasses,
		...(unwrappedServiceRoots.size() > 0
			? { unwrappedServiceRoot: unwrappedServiceRoots[0], unwrappedServiceRoots }
			: {}),
	};
}

export = {
	exportRbxm,
	importRbxm,
};

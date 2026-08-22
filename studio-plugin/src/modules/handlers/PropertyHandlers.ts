import Utils from "../Utils";
import Recording from "../Recording";

const { getInstanceByPath, convertPropertyValue } = Utils;
const { beginRecording, finishRecording } = Recording;

function setProperties(requestData: Record<string, unknown>) {
	const instancePath = requestData.instancePath as string;
	const properties = requestData.properties as Record<string, unknown>;

	if (!instancePath || !properties || !typeIs(properties, "table")) {
		return { error: "Instance path and properties object are required" };
	}

	const instance = getInstanceByPath(instancePath);
	if (!instance) return { error: `Instance not found: ${instancePath}` };

	const recordingId = beginRecording("Set multiple properties");
	const inst = instance as unknown as Record<string, unknown>;
	const results: Record<string, unknown>[] = [];
	let successCount = 0;
	let failureCount = 0;

	for (const [propName, propValue] of pairs(properties)) {
		const [success, err] = pcall(() => {
			if (propName === "Parent" || propName === "PrimaryPart") {
				if (typeIs(propValue, "string")) {
					const refInstance = getInstanceByPath(propValue as string);
					if (!refInstance) error(`${propName} reference not found: ${propValue}`);
					inst[propName as string] = refInstance;
				}
			} else if (propName === "Name") {
				instance.Name = tostring(propValue);
			} else if (propName === "Source" && instance.IsA("LuaSourceContainer")) {
				(instance as unknown as { Source: string }).Source = tostring(propValue);
			} else {
				const converted = convertPropertyValue(instance, propName as string, propValue);
				inst[propName as string] = converted !== undefined ? converted : propValue;
			}
		});

		if (success) {
			successCount++;
			results.push({ property: propName, success: true });
		} else {
			failureCount++;
			results.push({ property: propName, success: false, error: tostring(err) });
		}
	}

	finishRecording(recordingId, successCount > 0);

	return {
		instancePath,
		summary: { total: successCount + failureCount, succeeded: successCount, failed: failureCount },
		results,
	};
}

export = {
    setProperties,
};

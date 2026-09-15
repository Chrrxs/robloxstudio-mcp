type InaccessibleReason = "not_scriptable" | "security" | "not_a_member";

const NOT_SCRIPTABLE_PROPERTIES: Record<string, string[]> = {
	Workspace: [
		"StreamingMinRadius",
		"StreamingTargetRadius",
		"StreamingIntegrityMode",
		"ModelStreamingBehavior",
		"PredictiveStreamingMode",
		"MeshStreamingAndImprovedLods",
		"StreamingPauseMode",
	],
};

function listInaccessibleProperties(instance: Instance): string[] {
	const names: string[] = [];
	for (const [className, props] of pairs(NOT_SCRIPTABLE_PROPERTIES)) {
		if (instance.IsA(className as keyof Instances)) {
			for (const prop of props) names.push(prop);
		}
	}
	return names;
}

function containsPlain(haystack: string, needle: string): boolean {
	return string.find(haystack, needle, 1, true)[0] !== undefined;
}

function classifyPropertyFailure(
	instance: Instance,
	propName: string,
	rawMessage: string,
): { reason?: InaccessibleReason; error: string } {
	const target = `${instance.ClassName}.${propName}`;
	if (listInaccessibleProperties(instance).includes(propName)) {
		return {
			reason: "not_scriptable",
			error: `${target} is tagged NotScriptable: it cannot be read or written from a plugin (plugin security); set it from Studio's Properties panel. Roblox: ${rawMessage}`,
		};
	}
	const lower = string.lower(rawMessage);
	if (
		containsPlain(lower, "lacking capability") ||
		containsPlain(lower, "cannot access") ||
		containsPlain(lower, "current identity")
	) {
		return {
			reason: "security",
			error: `${target} is protected by a security level the plugin does not have; set it from Studio's Properties panel. Roblox: ${rawMessage}`,
		};
	}
	if (containsPlain(lower, "is not a valid member")) {
		return {
			reason: "not_a_member",
			error: `${target} is inaccessible from a plugin or does not exist (NotScriptable properties and unknown names raise the same error; if it shows in the Properties panel, set it there). Roblox: ${rawMessage}`,
		};
	}
	return { error: rawMessage };
}

export = {
	listInaccessibleProperties,
	classifyPropertyFailure,
};

import { RunService } from "@rbxts/services";

type PeerRole = "edit" | "server" | "client";

function detect(): PeerRole {
	if (RunService.IsEdit()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
}

export = { detect };

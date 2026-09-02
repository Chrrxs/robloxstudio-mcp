import { HttpService } from "@rbxts/services";

const BASE36_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const TOKEN_LENGTH = 6;
const TOKEN_MODULUS = 2_176_782_336; // 36^6

type TopologyIdKind = "instance" | "peer";

function tokenFromNumber(value: number): string {
	let remaining = math.floor(math.abs(value)) % TOKEN_MODULUS;
	let token = "";
	for (let index = 0; index < TOKEN_LENGTH; index++) {
		const digit = remaining % 36;
		token = BASE36_DIGITS.sub(digit + 1, digit + 1) + token;
		remaining = math.floor(remaining / 36);
	}
	return `${token.sub(1, 3)}-${token.sub(4, 6)}`;
}

function formatId(kind: TopologyIdKind, value: number): string {
	return `${kind}:${tokenFromNumber(value)}`;
}

function randomValue(): number {
	const guidPrefix = HttpService.GenerateGUID(false).sub(1, 8);
	return tonumber(guidPrefix, 16) ?? 0;
}

function createPeerId(): string {
	return formatId("peer", randomValue());
}

function createInstanceId(): string {
	return formatId("instance", randomValue());
}

function currentProcessInstanceId(): string {
	// Roblox exposes process uptime through os.clock(). Quantizing the recovered
	// launch wall-clock to 10 ms gives every VM in one Studio process the same ID.
	const launchTick = math.round((DateTime.now().UnixTimestampMillis - os.clock() * 1000) / 10);
	return formatId("instance", launchTick);
}

export = {
	createPeerId,
	createInstanceId,
	currentProcessInstanceId,
};

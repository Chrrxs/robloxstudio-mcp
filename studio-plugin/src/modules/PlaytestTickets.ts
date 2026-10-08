import { HttpService } from "@rbxts/services";

// Hands topology from an edit DataModel to the runtime DataModels of its
// playtest through plugin settings, so nothing MCP-owned has to be saved into
// the place that Studio copies. Plugin settings are one store shared by every
// Studio window running this plugin, and a window can silently overwrite
// another window's write. Tickets are therefore re-published on a heartbeat and
// ignored once that heartbeat stops.

export interface SettingsStore {
	GetSetting(key: string): unknown;
	SetSetting(key: string, value: unknown): void;
}

export interface PlaytestTicket {
	id: string;
	instanceId?: string;
	groupId?: string;
	placeId: number;
	placeKey: string;
	dataModelName: string;
	serverUrl?: string;
	postedAt: number;
	heartbeatAt: number;
}

const BOARD_KEY = "MCP_PLAYTEST_TICKETS_V1";
const CLAIM_KEY_PREFIX = "MCP_PLAYTEST_CLAIM_V1_";
const STALE_AFTER_MS = 5_000;

export function nowMs(): number {
	return DateTime.now().UnixTimestampMillis;
}

function readSetting(store: SettingsStore, key: string): unknown {
	const [ok, value] = pcall(() => store.GetSetting(key));
	return ok ? value : undefined;
}

function writeSetting(store: SettingsStore, key: string, value: unknown): void {
	pcall(() => store.SetSetting(key, value));
}

function optionalString(value: unknown): string | undefined {
	return typeIs(value, "string") && value !== "" ? value : undefined;
}

export function decodeTicket(value: unknown): PlaytestTicket | undefined {
	if (!typeIs(value, "table")) return undefined;
	const data = value as Record<string, unknown>;
	const id = data.id;
	const placeId = data.placeId;
	const placeKey = data.placeKey;
	const dataModelName = data.dataModelName;
	const postedAt = data.postedAt;
	const heartbeatAt = data.heartbeatAt;
	if (!typeIs(id, "string") || id === "") return undefined;
	if (!typeIs(placeId, "number") || !typeIs(placeKey, "string") || !typeIs(dataModelName, "string")) return undefined;
	if (!typeIs(postedAt, "number") || !typeIs(heartbeatAt, "number")) return undefined;
	const instanceId = optionalString(data.instanceId);
	const groupId = optionalString(data.groupId);
	if (instanceId === undefined && groupId === undefined) return undefined;
	return {
		id,
		instanceId,
		groupId,
		placeId,
		placeKey,
		dataModelName,
		serverUrl: optionalString(data.serverUrl),
		postedAt,
		heartbeatAt,
	};
}

function isFresh(ticket: PlaytestTicket, now: number): boolean {
	return math.abs(now - ticket.heartbeatAt) <= STALE_AFTER_MS;
}

function readBoard(store: SettingsStore): PlaytestTicket[] {
	const raw = readSetting(store, BOARD_KEY);
	if (!typeIs(raw, "string")) return [];
	const [ok, tickets] = pcall(() => {
		const decoded = HttpService.JSONDecode(raw);
		const valid: PlaytestTicket[] = [];
		if (!typeIs(decoded, "table")) return valid;
		for (const entry of decoded as unknown[]) {
			const ticket = decodeTicket(entry);
			if (ticket !== undefined) valid.push(ticket);
		}
		return valid;
	});
	return ok ? tickets : [];
}

function writeBoard(store: SettingsStore, tickets: PlaytestTicket[]): void {
	if (tickets[0] === undefined) {
		writeSetting(store, BOARD_KEY, undefined);
		return;
	}
	const [ok, encoded] = pcall(() => HttpService.JSONEncode(tickets));
	if (ok && typeIs(encoded, "string")) writeSetting(store, BOARD_KEY, encoded);
}

/** Publishes or refreshes a ticket and prunes tickets whose owners stopped refreshing them. */
export function publish(store: SettingsStore, ticket: PlaytestTicket): void {
	const now = nowMs();
	const board: PlaytestTicket[] = [];
	for (const existing of readBoard(store)) {
		if (existing.id !== ticket.id && isFresh(existing, now)) board.push(existing);
	}
	board.push({ ...ticket, heartbeatAt: now });
	writeBoard(store, board);
}

export function withdraw(store: SettingsStore, ticketId: string): void {
	const now = nowMs();
	const board: PlaytestTicket[] = [];
	let changed = false;
	for (const existing of readBoard(store)) {
		if (existing.id === ticketId || !isFresh(existing, now)) changed = true;
		else board.push(existing);
	}
	if (changed) writeBoard(store, board);
}

export function liveTickets(store: SettingsStore): PlaytestTicket[] {
	const now = nowMs();
	return readBoard(store).filter((ticket) => isFresh(ticket, now));
}

export function readClaim(store: SettingsStore, ticketId: string): string | undefined {
	return optionalString(readSetting(store, CLAIM_KEY_PREFIX + ticketId));
}

export function writeClaim(store: SettingsStore, ticketId: string, claimant: string): void {
	writeSetting(store, CLAIM_KEY_PREFIX + ticketId, claimant);
}

export function clearClaim(store: SettingsStore, ticketId: string): void {
	writeSetting(store, CLAIM_KEY_PREFIX + ticketId, undefined);
}

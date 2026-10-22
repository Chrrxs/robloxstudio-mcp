// Luau run in the game VM by run_scenario's spawn and move steps. Every wait
// is bounded, and failures call error(message, 0) so the step line shows
// the message without a script position.

export type Place = string | { x: number; y: number; z: number };

/** A Luau string literal for any JS string. */
export function luaString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (code < 32 || code === 127) out += `\\${code}`;
    else out += char;
  }
  return `${out}"`;
}

function luaNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  return String(value);
}

// Dot-separated paths from game, e.g. Workspace.Map.SpawnA. The first segment
// may be a service that is not a child by name.
const RESOLVER = `local function __resolve(path)
	local inst = game
	for seg in string.gmatch(path, "[^%.]+") do
		local found = inst:FindFirstChild(seg)
		if found == nil and inst == game then
			local ok, service = pcall(game.GetService, game, seg)
			if ok then found = service end
		end
		if found == nil then error("no instance at " .. path, 0) end
		inst = found
	end
	return inst
end`;

function placeCFrame(place: Place): string {
  return typeof place === 'string'
    ? `__resolve(${luaString(place)}):GetPivot()`
    : `CFrame.new(${luaNumber(place.x)}, ${luaNumber(place.y)}, ${luaNumber(place.z)})`;
}

export function describePlace(place: Place): string {
  return typeof place === 'string' ? place : `${place.x},${place.y},${place.z}`;
}

/** Client: the local player's UserId, used to find the same player on the server. */
export const USER_ID_CODE = 'return game:GetService("Players").LocalPlayer.UserId';

/** Server: wait for the player's character, then move it 3 studs above `at`. */
export function spawnCode(userId: number, playerIndex: number, at: Place, timeoutSeconds: number): string {
  return `${RESOLVER}
local player = game:GetService("Players"):GetPlayerByUserId(${luaNumber(userId)})
if player == nil then error("player ${playerIndex} is not in the game", 0) end
local deadline = os.clock() + ${luaNumber(timeoutSeconds)}
while not (player.Character and player.Character:FindFirstChild("HumanoidRootPart")) do
	if os.clock() > deadline then error("player ${playerIndex} has no character after ${timeoutSeconds}s", 0) end
	task.wait(0.1)
end
player.Character:PivotTo(${placeCFrame(at)} + Vector3.new(0, 3, 0))
return true`;
}

/** Client: walk the local character to `to` with Humanoid:MoveTo and wait for it to arrive. */
export function moveCode(to: Place, timeoutSeconds: number): string {
  return `${RESOLVER}
local character = game:GetService("Players").LocalPlayer.Character
local humanoid = character and character:FindFirstChildOfClass("Humanoid")
if humanoid == nil then error("the player has no Humanoid", 0) end
local goal = (${placeCFrame(to)}).Position
local done, reached = false, false
local connection = humanoid.MoveToFinished:Connect(function(ok)
	done = true
	reached = ok
end)
humanoid:MoveTo(goal)
local deadline = os.clock() + ${luaNumber(timeoutSeconds)}
while not done and os.clock() < deadline do task.wait(0.05) end
connection:Disconnect()
local distance = (character:GetPivot().Position - goal).Magnitude
if not done then error(string.format("still %.1f studs away after ${timeoutSeconds}s", distance), 0) end
if not reached then error(string.format("MoveTo gave up %.1f studs away", distance), 0) end
return string.format("%.1f", distance)`;
}

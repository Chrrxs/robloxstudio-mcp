import { RunService } from "@rbxts/services";

const ServerScriptService = game.GetService("ServerScriptService");

export const NAV_SIGNAL = "__MCP_NAV__";
export const NAV_RESULT = "__MCP_NAV_RESULT__";
const COMMAND_LISTENER_NAME = "__MCP_CommandListener";

let installedListener: Script | undefined;

function buildCommandListenerSource(): string {
	return `local LogService = game:GetService("LogService")
local PathfindingService = game:GetService("PathfindingService")
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local NAV_SIG = "${NAV_SIGNAL}"
local NAV_RES = "${NAV_RESULT}"
LogService.MessageOut:Connect(function(msg)
	if string.sub(msg, 1, #NAV_SIG + 1) == NAV_SIG .. ":" then
		local json = string.sub(msg, #NAV_SIG + 2)
		task.spawn(function()
			local ok, d = pcall(function() return HttpService:JSONDecode(json) end)
			if not ok or not d then
				print(NAV_RES .. ':{"success":false,"error":"parse_error"}')
				return
			end
			local ps = Players:GetPlayers()
			if #ps == 0 then
				print(NAV_RES .. ':{"success":false,"error":"no_players"}')
				return
			end
			local char = ps[1].Character or ps[1].CharacterAdded:Wait()
			local hum = char:FindFirstChildOfClass("Humanoid")
			local root = char:FindFirstChild("HumanoidRootPart")
			if not hum or not root then
				print(NAV_RES .. ':{"success":false,"error":"no_humanoid"}')
				return
			end
			local target
			if d.instancePath then
				local parts = string.split(d.instancePath, ".")
				local cur = game
				for i = 2, #parts do
					cur = cur:FindFirstChild(parts[i])
					if not cur then
						print(NAV_RES .. ':{"success":false,"error":"instance_not_found"}')
						return
					end
				end
				if cur:IsA("BasePart") then target = cur.Position
				elseif cur:IsA("Model") and cur.PrimaryPart then target = cur.PrimaryPart.Position
				else target = cur:GetPivot().Position end
			else
				target = Vector3.new(d.x or 0, d.y or 0, d.z or 0)
			end
			local path = PathfindingService:CreatePath({AgentRadius=2,AgentHeight=5,AgentCanJump=true})
			local pok = pcall(function() path:ComputeAsync(root.Position, target) end)
			local method = "direct"
			if pok and path.Status == Enum.PathStatus.Success then
				method = "pathfinding"
				for _, wp in ipairs(path:GetWaypoints()) do
					hum:MoveTo(wp.Position)
					if wp.Action == Enum.PathWaypointAction.Jump then hum.Jump = true end
					hum.MoveToFinished:Wait()
				end
			else
				hum:MoveTo(target)
				hum.MoveToFinished:Wait()
			end
			local fp = root.Position
			print(NAV_RES .. ':{"success":true,"method":"' .. method .. '","position":[' .. fp.X .. ',' .. fp.Y .. ',' .. fp.Z .. ']}')
		end)
	end
end)`;
}

// Install only in the play-server DataModel. Creating this script in edit mode
// registers a Drafts-mode row even after Destroy(); the play DM is torn down
// with the session so nothing lingers in the user's draft list.
export function ensureNavCommandListener(): boolean {
	if (!RunService.IsRunning() || !RunService.IsServer()) {
		return false;
	}

	if (installedListener && installedListener.Parent) {
		return true;
	}

	const existing = ServerScriptService.FindFirstChild(COMMAND_LISTENER_NAME);
	if (existing && existing.IsA("Script")) {
		installedListener = existing;
		return true;
	}

	const listener = new Instance("Script");
	listener.Name = COMMAND_LISTENER_NAME;
	listener.Parent = ServerScriptService;
	(listener as unknown as { Source: string }).Source = buildCommandListenerSource();
	installedListener = listener;
	return true;
}

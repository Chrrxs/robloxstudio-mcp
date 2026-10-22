-- Smoke: a one-player scenario that runs on Studio's default Baseplate.
-- Sync it into ServerStorage.Scenarios (Rojo maps Smoke.luau to a ModuleScript
-- named Smoke), then call run_scenario with name = "Smoke".
-- Format reference: docs/scenarios.md.
return {
	players = 1,
	steps = {
		{ "spawn", player = 1, at = "Workspace.SpawnLocation" },
		{ "wait_for", target = "client-1", expr = "game.Players.LocalPlayer.Character:FindFirstChild('Humanoid') ~= nil", timeout = 10 },
		{ "move", player = 1, to = Vector3.new(20, 3, 0) },
		{ "press", player = 1, key = "Space" },
		{ "wait", seconds = 0.5 },
		{ "assert", target = "server", expr = "#game:GetService('Players'):GetPlayers() == 1" },
		{ "screenshot", target = "client-1", label = "after jump" },
	},
}

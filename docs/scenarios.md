# Scenarios

`run_scenario` runs a scripted playtest in one tool call and returns one line
per step, then `PASS` or `FAIL`. It starts the playtest, runs the steps, and
always stops the playtest, including when a step fails or throws.

```text
scenario Smoke (1 player)
start solo play ok 4.1s
1 spawn player=1 at=Workspace.SpawnLocation ok 0.3s
2 wait_for client-1 `game.Players.LocalPlayer.Character:FindFirstChild('Hum…` ok 0.1s value=true
3 move player=1 to=20,3,0 ok 2.6s within 2.9 studs
4 press player=1 key=Space ok 0.2s
5 wait 0.5s ok 0.5s
6 assert server `#game:GetService('Players'):GetPlayers() == 1` ok 0.1s value=true
7 screenshot client-1 "after jump" ok 0.9s image 1 512x288 scale=0.2667 origin=0,0
stop ok 1.2s
PASS 7/7 in 10.6s
```

When a step fails, the run stops there. The report then shows:

- the failing step, with its reason;
- `stop ok`;
- `FAIL at step N (type) in …s`;
- up to five warning or error log lines from the failing peer, logged since the
  run began (at most 1 KB).

## Running a scenario

| Argument | Meaning |
| --- | --- |
| `name` | A ModuleScript in the scenario container. |
| `source` | Inline module source, instead of `name`. |
| `params` | An object passed to a scenario that returns a function. |
| `timeout` | Whole-run limit in seconds (default 120, up to 600). Checked between steps; every step also has its own limit. |

The scenario container is `ServerStorage.Scenarios` unless
`MCP_SCENARIO_CONTAINER` names another path. To keep scenarios in your game's
repository, map a folder to it with Rojo:

```json
"ServerStorage": {
  "$className": "ServerStorage",
  "Scenarios": { "$path": "tests/scenarios" }
}
```

Each run requires a fresh clone of the module, so edits are picked up without
restarting Studio. Requires relative to `script.Parent` keep working.

## Format

A scenario is a ModuleScript that returns a table, or a function that takes
`params` and returns one:

```lua
return function(params)
	return {
		players = params.players or 2,
		steps = {
			{ "spawn", player = 1, at = "Workspace.Lobby.SpawnA" },
			{ "spawn", player = 2, at = "Workspace.Lobby.SpawnB" },
			{ "press", player = 1, key = "E" },
			{ "wait_for", expr = "workspace.Door:GetAttribute('Open') == true", timeout = 5 },
			{ "assert", target = "client-2", expr = "workspace.Door.Transparency > 0.5" },
		},
	}
end
```

- `players` is 0 to 8 (default 1):
  - **0** starts a server-only `run` playtest.
  - **1** starts a solo `play` playtest.
  - **2 or more** start a multiplayer playtest.
- Player *n* is client peer `client-n`. The runner finds the same player on the
  server by `UserId`.
- A step names its type first (`{ "press", ... }`) or with `type = "press"`.
- Step values can be strings, numbers, booleans, `Vector3`s or Instances.
  Instances are sent as their path.
- Instance paths are dot-separated from `game`, for example
  `Workspace.Map.Door`. The first segment may be a service name.
- The loader validates every step before the playtest starts, and stops at the
  first invalid one.

## Steps

| Step | Fields | What it does |
| --- | --- | --- |
| `spawn` | `player` (default 1), `at` = path or `Vector3` | On the server, waits up to 15 s for the player's character, then moves it 3 studs above `at`. |
| `press` | `player`, `key` = `Enum.KeyCode` name, `hold` = seconds | Taps the key on that player's client. |
| `move` | `player`, `to` = path or `Vector3`, `timeout` (default 10) | Walks the character there with `Humanoid:MoveTo` and waits until it arrives. |
| `wait_for` | `expr`, `target` (default `server`), `timeout` (default 5, up to 120) | Polls the Luau expression in that peer's game VM every 0.1 s until it is truthy. |
| `assert` | `expr`, `target` (default `server`) | Evaluates the expression once and fails unless it is truthy. |
| `wait` | `seconds` (up to 60) | Pauses. |
| `screenshot` | `target` (default `client-1`), `crop` = path or `"x,y,w,h"`, `max_px`, `label` | Adds an image to the result, at most 4 per run. Later screenshot steps are skipped. |

`target` is `edit`, `server` or `client-N`. Expressions run like
`eval_server_runtime` and `eval_client_runtime`: in the game VM, with the same
`require` cache as your scripts. In edit mode they run like `execute_luau`.

An example that runs on the default Baseplate is in
[`examples/scenarios/Smoke.luau`](../examples/scenarios/Smoke.luau).

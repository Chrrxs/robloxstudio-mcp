#!/usr/bin/env node
// Verifies simulate_mouse_input move and scroll reach game
// scripts on a live client, that touch device emulation is rejected for
// cursor movement instead of reporting a false success, and that the
// documented execute_luau recipe (VirtualInput + GuiInset) drives a GUI
// element by path as a multi-step sequence with held-key cleanup.

import { McpClient, runTest, assert, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

const GUI = '__RSMCP_VirtualInputTest';

// Game LocalScript VM: the observers a game would actually use.
const SETUP = String.raw`
local UIS = game:GetService("UserInputService")
local Players = game:GetService("Players")
local pg = Players.LocalPlayer:WaitForChild("PlayerGui")
local old = pg:FindFirstChild("${GUI}")
if old then old:Destroy() end
local gui = Instance.new("ScreenGui")
gui.Name = "${GUI}"
gui.ResetOnSpawn = false
gui.DisplayOrder = 1000
local hover = Instance.new("TextButton")
hover.Name = "Hover"
hover.Position = UDim2.fromOffset(100, 100)
hover.Size = UDim2.fromOffset(240, 120)
hover.Parent = gui
local scroller = Instance.new("ScrollingFrame")
scroller.Name = "Scroller"
scroller.Position = UDim2.fromOffset(400, 100)
scroller.Size = UDim2.fromOffset(200, 200)
scroller.CanvasSize = UDim2.fromOffset(0, 3000)
scroller.Parent = gui
local play = Instance.new("TextButton")
play.Name = "Play"
play.Position = UDim2.fromOffset(100, 300)
play.Size = UDim2.fromOffset(200, 40)
play.Parent = gui
gui.Parent = pg
local function bump(n) gui:SetAttribute(n, (gui:GetAttribute(n) or 0) + 1) end
hover.MouseEnter:Connect(function() bump("enter") end)
play.Activated:Connect(function() bump("activated") end)
UIS.InputChanged:Connect(function(input)
  if input.UserInputType == Enum.UserInputType.MouseMovement then
    bump("moves")
  elseif input.UserInputType == Enum.UserInputType.MouseWheel then
    bump("wheels")
  end
end)
task.wait(0.2)
local inset = game:GetService("GuiService"):GetGuiInset()
local function center(g)
  local p = g.AbsolutePosition + g.AbsoluteSize / 2 + inset
  return { math.round(p.X), math.round(p.Y) }
end
return { hover = center(hover), scroller = center(scroller) }
`;

const READ = String.raw`
task.wait(0.2)
local UIS = game:GetService("UserInputService")
local gui = game:GetService("Players").LocalPlayer.PlayerGui.${GUI}
local loc = UIS:GetMouseLocation()
return {
  enter = gui:GetAttribute("enter") or 0,
  moves = gui:GetAttribute("moves") or 0,
  wheels = gui:GetAttribute("wheels") or 0,
  activated = gui:GetAttribute("activated") or 0,
  hoverState = tostring(gui.Hover.GuiState),
  canvasY = gui.Scroller.CanvasPosition.Y,
  mouse = { loc.X, loc.Y },
}
`;

const CLEANUP = String.raw`
local gui = game:GetService("Players").LocalPlayer.PlayerGui:FindFirstChild("${GUI}")
if gui then gui:Destroy() end
return true
`;

// The recipe documented in the tool guide: chain inputs in one execute_luau
// call, target a GUI element by path, and release held input on failure.
const RECIPE = String.raw`
local UIS = game:GetService("UserInputService")
local GuiService = game:GetService("GuiService")
local vi = UIS:CreateVirtualInput()
local button = game:GetService("Players").LocalPlayer.PlayerGui.${GUI}.Play
local pos = button.AbsolutePosition + button.AbsoluteSize / 2 + GuiService:GetGuiInset()
local held, step = {}, 0
local ok, err = pcall(function()
  step = 1
  vi:SendMouseButton(pos, Enum.UserInputType.MouseButton1, true)
  task.wait(0.05)
  vi:SendMouseButton(pos, Enum.UserInputType.MouseButton1, false)
  step = 2
  vi:SendKey(true, Enum.KeyCode.W)
  held[Enum.KeyCode.W] = true
  task.wait(0.2)
  step = 3
  error("deliberate failure", 0)
end)
local heldMidway = UIS:IsKeyDown(Enum.KeyCode.W)
for key in held do pcall(function() vi:SendKey(false, key) end) end
task.wait(0.1)
return { ok = ok, step = step, err = err, heldMidway = heldMidway, heldAfter = UIS:IsKeyDown(Enum.KeyCode.W) }
`;

function parsed(value, label) {
  if (typeof value !== 'string') throw new Error(`${label}: expected a JSON string, got ${JSON.stringify(value)}`);
  return JSON.parse(value);
}

await runTest('simulate_mouse_input move and scroll reach the game', async ({ track }) => {
  const client = track(new McpClient('A'));
  await client.start();
  await client.initialize();
  await startPlaytestAndWait(client);

  const evalClient = async (code, label) => {
    const res = await client.callTool('eval_client_runtime', { target: 'client-1', code });
    assert(res.ok === true, `${label} runs in the client VM`);
    return res.result;
  };
  const read = async (label) => parsed(await evalClient(READ, label), label);
  const mouse = (args) => client.callTool('simulate_mouse_input', { target: 'client-1', ...args });

  try {
    // Device emulation can persist across sessions; cursor movement needs a mouse.
    await client.callTool('set_device_simulator', { target: 'client-1', stopSimulation: true });
    const centers = parsed(await evalClient(SETUP, 'setup'), 'setup');

    const before = await read('read before move');
    assert(before.enter === 0, 'hover target starts without MouseEnter');
    const [hx, hy] = centers.hover;
    await mouse({ action: 'move', x: hx, y: hy });
    const afterMove = await read('read after move');
    assert(afterMove.enter >= 1, `move fires MouseEnter (got ${afterMove.enter})`);
    assert(afterMove.moves >= 1, `move fires InputChanged MouseMovement (got ${afterMove.moves})`);
    assert(afterMove.hoverState === 'Enum.GuiState.Hover', `move hovers the GUI target (got ${afterMove.hoverState})`);
    assert(afterMove.mouse[0] === hx && afterMove.mouse[1] === hy,
      `cursor lands on the viewport coordinates (${afterMove.mouse} vs ${hx},${hy})`);

    const [sx, sy] = centers.scroller;
    await mouse({ action: 'scroll', x: sx, y: sy, wheel: -3 });
    const afterDown = await read('read after scroll down');
    assert(afterDown.canvasY > 0, `negative wheel scrolls down (canvasY ${afterDown.canvasY})`);
    assert(afterDown.wheels >= 1, `scroll fires InputChanged MouseWheel (got ${afterDown.wheels})`);
    await mouse({ action: 'scroll', x: sx, y: sy, wheel: 1 });
    const afterUp = await read('read after scroll up');
    assert(afterUp.canvasY < afterDown.canvasY, `positive wheel scrolls up (${afterDown.canvasY} -> ${afterUp.canvasY})`);

    const missingWheel = await client.callToolError('simulate_mouse_input', { target: 'client-1', action: 'scroll', x: sx, y: sy });
    assert(JSON.stringify(missingWheel).includes('wheel must be a non-zero number'), 'scroll without wheel is rejected');

    const recipe = parsed((await client.callTool('execute_luau', { target: 'client-1', code: RECIPE })).returnValue, 'recipe');
    assert(recipe.ok === false && recipe.step === 3 && recipe.err === 'deliberate failure', 'recipe reports the failing step');
    assert(recipe.heldMidway === true && recipe.heldAfter === false, 'recipe holds W, then releases it after the failure');
    const afterRecipe = await read('read after recipe');
    assert(afterRecipe.activated === 1, `recipe clicks the GUI button found by path with the inset (activated ${afterRecipe.activated})`);

    await client.callTool('set_device_simulator', { target: 'client-1', deviceId: 'iphone_XR' });
    try {
      const touch = await client.callToolError('simulate_mouse_input', { target: 'client-1', action: 'move', x: hx, y: hy });
      assert(JSON.stringify(touch).includes('touch device emulation'), 'move under touch emulation is rejected, not a false success');
    } finally {
      await client.callTool('set_device_simulator', { target: 'client-1', stopSimulation: true });
    }
  } finally {
    await client.callTool('eval_client_runtime', { target: 'client-1', code: CLEANUP }).catch(() => {});
    await safeStopPlaytest(client);
  }
});

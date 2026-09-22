#!/usr/bin/env node
// Compile and exercise the shipped Swift title matcher without accessing windows.
// Run after npm run build on macOS with Xcode Command Line Tools installed.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACOS_CAPTURE_SOURCE, runBoundedCaptureProcess } from '../packages/core/dist/host-capture-macos.js';

assert.equal(process.platform, 'darwin', 'This native helper test requires macOS');
const directory = mkdtempSync(join(tmpdir(), 'rsmcp-macos-capture-test-'));
try {
  const main = MACOS_CAPTURE_SOURCE.indexOf('@main struct Main');
  assert.ok(main > 0);
  const source = MACOS_CAPTURE_SOURCE.slice(0, main) + `
@main struct Test {
    static func main() {
        let cases: [(String, String, Bool)] = [
            ("Place - Roblox Studio", "Place", true),
            ("Place", "Place", true),
            ("/tmp/project/Baseplate.rbxl - Roblox Studio", "Baseplate.rbxl", true),
            ("/tmp/project/雪.rbxlx - Roblox Studio", "雪.rbxlx", true),
            ("/tmp/project/Other.rbxl - Roblox Studio", "Baseplate.rbxl", false),
            ("/tmp/Baseplate.rbxl.backup - Roblox Studio", "Baseplate.rbxl", false),
            ("/tmp/Baseplate.rbxl - Another App", "Baseplate.rbxl", false),
            ("relative/Baseplate.rbxl - Roblox Studio", "Baseplate.rbxl", false),
            ("/tmp/Baseplate.rbxl - Roblox Studio", "", true)
        ]
        for (title, hint, expected) in cases {
            precondition(matchesStudioTitle(title, hint: hint) == expected, title)
        }
        print("macOS capture title matching: 9 cases passed")
    }
}
`;
  const sourcePath = join(directory, 'capture-test.swift');
  const executable = join(directory, 'capture-test');
  writeFileSync(sourcePath, source);
  await runBoundedCaptureProcess('/usr/bin/xcrun', ['swiftc', '-parse-as-library', sourcePath,
    '-o', executable, '-module-cache-path', join(directory, 'modules')], 60000);
  console.log((await runBoundedCaptureProcess(executable, [], 5000)).trim());
} finally {
  rmSync(directory, { recursive: true, force: true });
}

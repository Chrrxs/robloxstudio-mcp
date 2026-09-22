import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostCaptureResult, HostWindowIdentity } from './host-capture.js';

const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const STUDIO_BUNDLE_ID = 'com.Roblox.RobloxStudio';

// Kept inline so npm bundles need no separately installed native resources.
// This helper is only executed by captureStudioWindow's Darwin backend.
export const MACOS_CAPTURE_SOURCE = String.raw`
import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit

struct CaptureFailure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw CaptureFailure(message: message) }
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

// Local files can use their absolute path in the macOS window title while
// Studio reports only the basename as DataModel.Name. Match that basename
// after removing Studio's exact title suffix; retain ambiguity checks below.
func matchesStudioTitle(_ title: String, hint: String) -> Bool {
    if hint.isEmpty || title == hint || title.hasPrefix(hint) { return true }
    let suffix = " - Roblox Studio"
    guard title.hasSuffix(suffix) else { return false }
    let place = String(title.dropLast(suffix.count))
    return place.hasPrefix("/") && (place as NSString).lastPathComponent == hint
}

@available(macOS 14.0, *)
@MainActor
func capture() async throws {
    // Never request or bypass Screen Recording permission from an MCP call.
    guard CGPreflightScreenCaptureAccess() else {
        try fail("macOS Screen Recording permission is not granted to the MCP host. Enable it in System Settings > Privacy & Security > Screen Recording, then restart the MCP host.")
    }
    // A command-line helper must establish its WindowServer connection before
    // ScreenCaptureKit uses Core Graphics. Do not activate or create any UI.
    NSApplication.shared.setActivationPolicy(.prohibited)
    let env = ProcessInfo.processInfo.environment
    let hint = env["MCP_CAPTURE_TITLE_HINT"] ?? ""
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let candidates = content.windows.filter { window in
        window.owningApplication?.bundleIdentifier == "com.Roblox.RobloxStudio" &&
        window.windowLayer == 0 && window.isOnScreen &&
        window.frame.width > 0 && window.frame.height > 0 &&
        matchesStudioTitle(window.title ?? "", hint: hint)
    }
    guard candidates.count == 1, let window = candidates.first, let app = window.owningApplication else {
        try fail(candidates.isEmpty ? "no visible Roblox Studio window matches the requested place title" : "multiple Roblox Studio windows match the requested place title; the capture is ambiguous")
    }
    if let expected = env["MCP_CAPTURE_EXPECTED_IDENTITY"], !expected.isEmpty {
        guard let data = expected.data(using: .utf8),
              let identity = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              (identity["windowId"] as? NSNumber)?.uint32Value == window.windowID,
              (identity["processId"] as? NSNumber)?.int32Value == app.processID,
              identity["bundleIdentifier"] as? String == app.bundleIdentifier else {
            try fail("the selected Roblox Studio window identity changed between captures")
        }
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let scale = CGFloat(filter.pointPixelScale)
    let pixelWidth = filter.contentRect.width * scale
    let pixelHeight = filter.contentRect.height * scale
    guard pixelWidth.isFinite, pixelHeight.isFinite, pixelWidth > 0, pixelHeight > 0,
          pixelWidth <= 16384, pixelHeight <= 16384 else { try fail("invalid Studio window capture dimensions") }
    let width = Int(pixelWidth.rounded(.up))
    let height = Int(pixelHeight.rounded(.up))
    guard width * height * 4 <= 134217728 else { try fail("Studio window capture exceeds the image byte limit") }
    let config = SCStreamConfiguration()
    config.width = width
    config.height = height
    config.showsCursor = false
    config.ignoreShadowsSingleWindow = true
    config.ignoreGlobalClipSingleWindow = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    guard image.width == width, image.height == height else { try fail("Studio window capture returned unexpected dimensions") }
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    try bytes.withUnsafeMutableBytes { raw in
        guard let context = CGContext(data: raw.baseAddress, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            try fail("could not allocate the RGBA capture context")
        }
        // Quartz draws the image upright into row-major top-to-bottom bitmap storage.
        context.setBlendMode(.copy)
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    guard let output = env["MCP_CAPTURE_OUT"] else { try fail("missing capture output path") }
    try Data(bytes).write(to: URL(fileURLWithPath: output), options: .atomic)
    emit(["ok": true, "width": width, "height": height, "title": String((window.title ?? "").prefix(2048)),
          "identity": ["windowId": window.windowID, "processId": app.processID, "bundleIdentifier": app.bundleIdentifier]])
}

@main struct Main {
    @MainActor
    static func main() async {
        do {
            if #available(macOS 14.0, *) { try await capture() }
            else { try fail("macOS host window capture requires macOS 14 or newer") }
        } catch {
            emit(["ok": false, "error": String(((error as? CaptureFailure)?.message ?? error.localizedDescription).prefix(2048))])
        }
    }
}
`;

// Both the compiler and native capture are bounded; arguments never pass through a shell.
export function runBoundedCaptureProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== 'win32';
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: processGroup });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      // xcrun/swiftc may launch compiler children; kill the private process group too.
      try {
        if (processGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => stop(`macOS host capture helper timed out after ${timeoutMs}ms`), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk: string, isError: boolean) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) { stop('macOS host capture helper exceeded its output byte limit'); return; }
      if (isError) stderr += chunk;
      else stdout += chunk;
    };
    child.stdout.on('data', (chunk: string) => collect(chunk, false));
    child.stderr.on('data', (chunk: string) => collect(chunk, true));
    child.on('error', (error) => { failure ??= error; });
    // Wait for close after SIGKILL before callers remove files used by the child.
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`macOS host capture helper exited with code ${code}: ${stderr.trim().slice(0, 600)}`));
      else resolve(stdout);
    });
  });
}

let compiledHelper: Promise<string> | undefined;
async function getHelper(): Promise<string> {
  if (!compiledHelper) {
    compiledHelper = (async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-macos-helper-'));
      const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
      try {
        const source = path.join(directory, 'capture.swift');
        const executable = path.join(directory, 'capture');
        fs.writeFileSync(source, MACOS_CAPTURE_SOURCE, { mode: 0o600 });
        await runBoundedCaptureProcess('/usr/bin/xcrun', ['swiftc', '-parse-as-library', source, '-o', executable,
          '-module-cache-path', path.join(directory, 'modules')], 60_000);
        process.once('exit', cleanup);
        return executable;
      } catch (error) {
        cleanup();
        throw error;
      }
    })();
    compiledHelper.catch(() => { compiledHelper = undefined; });
  }
  return compiledHelper;
}

// Compile before the marker transaction so a cold compiler cannot outlive the markers.
// This does not inspect windows or invoke the native capture executable.
export async function prepareMacHostCapture(): Promise<void> {
  await getHelper();
}

function validIdentity(value: unknown): value is HostWindowIdentity {
  if (!value || typeof value !== 'object') return false;
  const id = value as HostWindowIdentity;
  return Number.isSafeInteger(id.windowId) && id.windowId > 0 && id.windowId <= 0xffffffff &&
    Number.isSafeInteger(id.processId) && id.processId > 0 && id.processId <= 0x7fffffff &&
    id.bundleIdentifier === STUDIO_BUNDLE_ID;
}

export function parseMacCaptureReport(stdout: string, expectedIdentity?: HostWindowIdentity):
  { ok: false; error: string } | { ok: true; width: number; height: number; title: string; identity: HostWindowIdentity } {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) throw new Error('macOS capture report exceeds its byte limit');
  const value = JSON.parse(stdout.trim());
  if (!value || typeof value !== 'object') throw new Error('invalid macOS capture report');
  if (value.ok === false && typeof value.error === 'string') return { ok: false, error: value.error.slice(0, 2048) };
  const { width, height, title, identity } = value;
  if (value.ok !== true || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height * 4 > MAX_IMAGE_BYTES ||
      typeof title !== 'string' || title.length > 2048 || !validIdentity(identity)) {
    throw new Error('invalid macOS capture dimensions or window identity');
  }
  if (expectedIdentity && (identity.windowId !== expectedIdentity.windowId || identity.processId !== expectedIdentity.processId ||
      identity.bundleIdentifier !== expectedIdentity.bundleIdentifier)) {
    throw new Error('the selected Roblox Studio window identity changed between captures');
  }
  return { ok: true, width, height, title, identity };
}

async function runMacCapture(output: string, titleHint?: string, expectedIdentity?: HostWindowIdentity): Promise<string> {
  const executable = await getHelper();
  return runBoundedCaptureProcess(executable, [], 20_000, {
    ...process.env, MCP_CAPTURE_TITLE_HINT: titleHint ?? '', MCP_CAPTURE_OUT: output,
    MCP_CAPTURE_EXPECTED_IDENTITY: expectedIdentity ? JSON.stringify(expectedIdentity) : '',
  });
}

export async function captureMacStudioWindow(
  titleHint?: string,
  expectedIdentity?: HostWindowIdentity,
  runCapture: typeof runMacCapture = runMacCapture,
): Promise<HostCaptureResult> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robloxstudio-mcp-macos-capture-'));
  try {
    const output = path.join(directory, 'capture.rgba');
    const stdout = await runCapture(output, titleHint, expectedIdentity);
    const report = parseMacCaptureReport(stdout, expectedIdentity);
    if (!report.ok) return report;
    const expectedBytes = report.width * report.height * 4;
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.size !== expectedBytes) throw new Error('macOS capture returned an invalid RGBA byte count');
    const rgba = fs.readFileSync(output);
    if (rgba.length !== expectedBytes) throw new Error('macOS capture RGBA byte count changed during read');
    return { ok: true, capture: { width: report.width, height: report.height, title: report.title, identity: report.identity, rgba } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

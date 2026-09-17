#!/usr/bin/env node
// Windows only. Launches Node fixtures, never Studio or a real installer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { scheduler } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildWindowsStudioStartScript } from '../packages/core/dist/studio-instance-manager.js';
import { createIsolatedStudioDirectory } from '../scripts/studio-lifecycle.mjs';
import { createStudioWorkerJob, launchInStudioWorkerJob, STUDIO_WORKER_JOB_ENV } from '../scripts/studio-worker-job.mjs';
assert.equal(process.platform, 'win32', 'Run this fixture with Windows node.exe');
const self = fileURLToPath(import.meta.url);
const host = fileURLToPath(new URL('./studio-worker-lifetime-native.ps1', import.meta.url));
const mode = process.argv[2];
const options = { env: process.env, cwd: process.cwd(), toWindowsPath: value => value };

async function marker(filename) {
  if (!existsSync(filename)) {
    const watcher = watch(path.dirname(filename));
    try {
      while (!existsSync(filename)) await once(watcher, 'change', { signal: AbortSignal.timeout(30000) });
    } finally { watcher.close(); }
  }
  return JSON.parse(readFileSync(filename, 'utf8'));
}
async function waitForDiagnostic(filename) {
  const watcher = watch(path.dirname(filename));
  try {
    while (!existsSync(filename) || readFileSync(filename, 'utf8').length === 0) {
      await once(watcher, 'change', { signal: AbortSignal.timeout(30000) });
    }
  } finally { watcher.close(); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function gone(pid) {
  const deadline = performance.now() + 15000;
  while (alive(pid)) {
    assert.ok(performance.now() < deadline, `Owned fixture ${pid} did not exit`);
    await scheduler.yield();
  }
}
async function finishChild(info, token) {
  const socket = net.connect(info.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.end(token);
  await once(socket, 'close');
}
function channel(args) {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    child, closed,
    send: value => child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`),
    async receive() {
      const next = await lines.next();
      assert.equal(next.done, false, `Native fixture closed without response: ${stderr}`);
      return next.value;
    },
    async finish() {
      child.stdin.end();
      const [code, signal] = await closed;
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
    },
  };
}

if (mode === '--hold' || mode === '--installer') {
  const [markerPath, token, finished] = process.argv.slice(3);
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => { input += chunk; });
    socket.on('end', () => {
      if (input !== token) return;
      if (finished) writeFileSync(finished, 'natural installer exit');
      server.close();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const temporaryMarker = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporaryMarker, JSON.stringify({ pid: process.pid, port: server.address().port }));
  renameSync(temporaryMarker, markerPath);
  process.send?.('ready');
  process.disconnect?.();
} else if (mode === '--root') {
  const [worker, markerPath] = process.argv.slice(3);
  const child = spawn(process.execPath, [self, '--hold', markerPath, 'owned-child'], { cwd: worker, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message');
  child.unref();
  process.exit(0);
} else if (mode === '--broker-parent') {
  const [worker, executable, parentMarker, installerMarker, finished, diagnostic] = process.argv.slice(3);
  const lifetime = await createStudioWorkerJob({
    ...options,
    spawnProcess(command, args, spawnOptions) {
      // Keep the real broker's diagnostic file readable after this parent exits.
      // Its stdin/stdout still use the production protocol and lifetime path.
      const descriptor = openSync(diagnostic, 'a');
      let child;
      try {
        child = spawn(command, args, { ...spawnOptions, stdio: ['pipe', 'pipe', descriptor] });
      } finally { closeSync(descriptor); }
      child.stderr = new PassThrough();
      return child;
    },
  });
  await launchInStudioWorkerJob(executable, [self, '--installer', installerMarker, 'finish-eof', finished], worker, {
    ...options, env: { ...process.env, ...lifetime.environment },
  });
  await marker(installerMarker);
  const temporaryMarker = `${parentMarker}.${process.pid}.tmp`;
  writeFileSync(temporaryMarker, JSON.stringify(lifetime.environment));
  renameSync(temporaryMarker, parentMarker);
  process.exit(0);
} else if (mode === '--inside') {
  const resultPath = process.argv[3];
  const root = path.dirname(resultPath);
  const sibling = spawn(process.execPath, [self, '--hold', path.join(root, 'sibling.json'), 'unrelated-sibling'], { cwd: root, stdio: 'ignore' });
  const siblingClosed = once(sibling, 'close');
  const siblingInfo = await marker(path.join(root, 'sibling.json'));
  const observations = [];
  try {
    const unknownMarker = path.join(root, 'must-not-launch.json');
    await assert.rejects(launchInStudioWorkerJob(process.execPath, [self, '--hold', unknownMarker, 'not-owned'], root, {
      ...options, env: { ...process.env, [STUDIO_WORKER_JOB_ENV]: 'Local\\RsmcpStudioWorker-00000000000000000000000000000000' },
    }), /Opening Studio worker job/);
    assert.equal(existsSync(unknownMarker), false, 'An unknown job must reject before the process executes');
    observations.push('unknown worker job: rejected before process execution');
    for (const launchKind of ['direct', 'core-complete']) {
      const worker = await createIsolatedStudioDirectory({ prefix: `native-${launchKind}` });
      const markerPath = path.join(root, `${launchKind}.json`);
      let childInfo;
      try {
        const env = { ...process.env, ...worker.environment };
        let rootPid;
        if (launchKind === 'direct') {
          rootPid = await launchInStudioWorkerJob(process.execPath, [self, '--root', worker.workingDirectory, markerPath], worker.workingDirectory, { ...options, env });
        } else {
          const script = buildWindowsStudioStartScript(process.execPath, [self, '--root', worker.workingDirectory, markerPath], undefined, worker.workingDirectory, env[STUDIO_WORKER_JOB_ENV]);
          const native = channel(['-Command', script]);
          const identity = JSON.parse(await native.receive());
          rootPid = identity.pid;
          native.send('MCP_STUDIO_LAUNCH_ACCEPT');
          assert.equal(await native.receive(), 'MCP_STUDIO_LAUNCH_RESUMED');
          native.send('MCP_STUDIO_LAUNCH_COMPLETE');
          await native.finish();
        }
        childInfo = await marker(markerPath);
        await gone(rootPid);
        assert.ok(alive(childInfo.pid), 'Descendant must survive root exit and core COMPLETE');
        // Exercise historical Win32 removal semantics without Node's synchronous
        // Unicode error-path abort.
        const rootOnlyDelete = channel(['-ExecutionPolicy', 'Bypass', '-File', host, '-Mode', 'Delete']);
        rootOnlyDelete.send({ directory: worker.workingDirectory });
        const deletion = JSON.parse(await rootOnlyDelete.receive());
        await rootOnlyDelete.finish();
        assert.equal(deletion.removed, false, `Root-only cleanup must reject a live child CWD: ${JSON.stringify(deletion)}`);
        assert.ok([5, 32].includes(deletion.hresult & 0xffff), `Expected Win32 access/sharing failure: ${JSON.stringify(deletion)}`);
        await worker.cleanup();
        assert.equal(alive(childInfo.pid), false, 'Cleanup must observe descendant exit before returning');
        assert.equal(existsSync(worker.workingDirectory), false, 'Cleanup must remove the drained worker');
        assert.equal(alive(siblingInfo.pid), true, 'A sibling outside the worker job must survive');
        observations.push(`${launchKind}: root exited, child retained, Win32 root-only deletion rejected, job drained, directory removed, sibling alive`);
      } finally {
        await worker.cleanup();
      }
    }

    // Controlled basename injection exercises the real native drain policy, not a real installer.
    const executable = path.join(root, 'RsmcpFixtureInstaller.exe');
    copyFileSync(process.execPath, executable);
    for (const deadline of [false, true]) {
      const readyPath = path.join(root, `installer-${deadline}.json`);
      const finished = path.join(root, `installer-finished-${deadline}`);
      const native = channel(['-ExecutionPolicy', 'Bypass', '-File', host, '-Mode', 'Grace']);
      native.send({ executable, args: [self, '--installer', readyPath, 'finish-installer', finished], cwd: root });
      const identity = JSON.parse(await native.receive());
      const info = await marker(readyPath);
      assert.equal(identity.pid, info.pid);
      native.send({ graceMs: deadline ? 0 : 5000 });
      assert.equal(JSON.parse(await native.receive()).draining, true);
      if (deadline) {
        const refusal = JSON.parse(await native.receive());
        assert.match(refusal.error, /installer did not finish/);
        assert.equal(refusal.processAlive, true, 'Grace failure must not terminate the installer');
        native.send({ graceMs: 5000 });
        assert.equal(JSON.parse(await native.receive()).draining, true);
      }
      await finishChild(info, 'finish-installer');
      const drainResult = JSON.parse(await native.receive());
      assert.equal(drainResult.drained, true, JSON.stringify(drainResult));
      await native.finish();
      assert.equal(readFileSync(finished, 'utf8'), 'natural installer exit', 'Owned installer must finish before job termination');
      assert.equal(alive(info.pid), false);
      assert.equal(alive(siblingInfo.pid), true);
      observations.push(`installer grace${deadline ? ' deadline/recovery' : ''}: natural finish, drained, sibling alive`);
    }

    // The broker must survive an actual Node-parent exit, not only stdin.end().
    // This is a renamed Node fixture, never a real Roblox installer.
    const eofExecutable = path.join(root, 'RobloxStudioInstaller.exe');
    copyFileSync(process.execPath, eofExecutable);
    const eofWorker = path.join(root, 'worker-eof');
    mkdirSync(eofWorker);
    const eofParentMarker = path.join(root, 'eof-parent.json');
    const eofInstallerMarker = path.join(root, 'eof-installer.json');
    const eofFinished = path.join(root, 'eof-installer-finished');
    const eofDiagnostic = path.join(root, 'eof-broker.log');
    const parent = spawn(process.execPath, [self, '--broker-parent', eofWorker, eofExecutable,
      eofParentMarker, eofInstallerMarker, eofFinished, eofDiagnostic], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let parentError = '';
    parent.stderr.on('data', chunk => { parentError += chunk; });
    const [parentCode] = await once(parent, 'close');
    assert.equal(parentCode, 0, parentError);
    const eofEnvironment = await marker(eofParentMarker);
    const eofInstaller = await marker(eofInstallerMarker);
    // This output is the real broker entering grace after EOF, so the process
    // exit checks below cannot race a broker that has not handled EOF yet.
    await waitForDiagnostic(eofDiagnostic);
    assert.equal(alive(eofInstaller.pid), true, 'Installer must survive Node-parent exit and broker EOF');
    const eofHelperMarker = path.join(root, 'eof-helper.json');
    await launchInStudioWorkerJob(process.execPath, [self, '--hold', eofHelperMarker, 'owned-eof-helper'], eofWorker, {
      ...options, env: { ...process.env, ...eofEnvironment },
    });
    const eofHelper = await marker(eofHelperMarker);
    await finishChild(eofInstaller, 'finish-eof');
    await gone(eofInstaller.pid);
    await gone(eofHelper.pid);
    const eofFinishedValue = readFileSync(eofFinished, 'utf8');
    assert.equal(eofFinishedValue, 'natural installer exit');
    const eofSiblingAlive = alive(siblingInfo.pid);
    assert.equal(eofSiblingAlive, true);
    await rm(eofWorker, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    observations.push('broker parent exit: EOF grace retained installer, natural finish, owned helper drained, sibling alive');
    writeFileSync(resultPath, JSON.stringify(observations));
  } catch (error) {
    writeFileSync(resultPath, JSON.stringify({ error: error.stack }));
    throw error;
  } finally {
    await finishChild(siblingInfo, 'unrelated-sibling');
    await siblingClosed;
  }
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-worker-native-\u96ea-'));
  const resultPath = path.join(root, 'result.json');
  try {
    const outer = channel(['-ExecutionPolicy', 'Bypass', '-File', host]);
    outer.send({ executable: process.execPath, args: [self, '--inside', resultPath], cwd: process.cwd() });
    try { await outer.finish(); }
    catch (error) {
      if (existsSync(resultPath)) console.error(readFileSync(resultPath, 'utf8'));
      throw error;
    }
    const observations = JSON.parse(readFileSync(resultPath, 'utf8'));
    if (!Array.isArray(observations)) {
      throw new Error(typeof observations?.error === 'string' ? observations.error : `Invalid native fixture result: ${JSON.stringify(observations)}`);
    }
    assert.equal(observations.length, 6);
    console.log(observations.join('\n'));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const STUDIO_WORKER_JOB_ENV = 'RSMCP_STUDIO_TEST_WORKER_JOB';
const JOB_NAME = /^Local\\RsmcpStudioWorker-[a-f0-9]{32}$/u;

export function validateStudioWorkerJobName(name) {
  if (typeof name !== 'string' || !JOB_NAME.test(name)) {
    throw new Error('Invalid Studio test worker job name');
  }
  return name;
}

// The fixed helper accepts data over stdin, never interpolated PowerShell commands.
function connect(mode, configuration, { env, cwd, toWindowsPath, spawnProcess = spawn }) {
  const helper = toWindowsPath(fileURLToPath(new URL('./studio-worker-job.ps1', import.meta.url)));
  const invocation = `& '${helper.replaceAll("'", "''")}' -Mode '${mode}'`;
  const encoded = Buffer.from(invocation, 'utf16le').toString('base64');
  // libuv's private job has SILENT_BREAKAWAY_OK: only the directly spawned
  // cmd belongs to it. PowerShell is a grandchild, retaining the outer harness
  // job but not dying with this Node process. DETACHED_PROCESS cannot be used
  // for Windows PowerShell 5: it exits before running scripts without a console.
  // Only a fixed command and base64 data cross cmd's parser.
  const child = spawnProcess('cmd.exe', ['/d', '/s', '/c',
    `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`], {
    cwd: process.platform === 'win32'
      ? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? cwd
      : cwd,
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending;
  let failure;
  let stdout = '';
  let stderr = '';
  let reportedInstallerWait = false;
  let closed = false;
  const completion = Promise.withResolvers();
  const unref = () => {
    child.unref();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
  };
  const fail = (error) => {
    failure ??= error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    unref();
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16384);
    if (mode === 'Broker' && !reportedInstallerWait &&
        stderr.includes('for owned Studio installer processes before worker cleanup.')) {
      reportedInstallerWait = true;
      process.stderr.write("Waiting for this worker's Studio update to finish before cleanup (up to 10 minutes). Do not cancel a healthy update.\n");
    }
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 65536) { fail(new Error('Oversized Studio worker broker response')); return; }
    let newline;
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); }
      catch { fail(new Error(`Invalid Studio worker broker response: ${line}`)); return; }
      if (!pending) { fail(new Error('Unexpected Studio worker broker response')); return; }
      const request = pending;
      pending = undefined;
      clearTimeout(request.timer);
      if (response?.error) request.reject(new Error(`Studio worker broker failed: ${response.error}`));
      else request.resolve(response);
      unref();
    }
  });
  child.on('close', (code, signal) => {
    closed = true;
    const error = failure ?? (signal || code !== 0 ? new Error(`Studio worker broker exited ${signal ?? code}: ${stderr}`) : undefined);
    if (pending) fail(error ?? new Error(`Studio worker broker closed without acknowledgment: ${stderr}`));
    failure ??= error;
    completion.resolve(error);
  });
  function request(value, timeoutMs) {
    if (failure || closed) return Promise.reject(failure ?? new Error('Studio worker broker is closed'));
    if (pending) return Promise.reject(new Error('Studio worker broker already has a pending request'));
    const result = Promise.withResolvers();
    child.ref();
    child.stdin.ref?.();
    child.stdout.ref?.();
    child.stderr.ref?.();
    const timer = setTimeout(() => {
      fail(new Error('Timed out waiting for Studio worker broker; retaining worker directory'));
      child.stdin.end();
    }, timeoutMs);
    pending = { ...result, timer };
    child.stdin.write(`${JSON.stringify(value)}\n`);
    return result.promise;
  }
  async function finish() {
    child.stdin.end();
    child.ref();
    child.stdout.ref?.();
    child.stderr.ref?.();
    const deadline = Promise.withResolvers();
    const timeout = setTimeout(() => deadline.resolve(
      new Error('Studio worker broker did not exit; retaining worker directory'),
    ), 15000);
    const error = await Promise.race([completion.promise, deadline.promise]);
    clearTimeout(timeout);
    unref();
    if (error) throw error;
  }
  return { ready: request(configuration, 30000), request, finish };
}

export async function createStudioWorkerJob(options) {
  const name = `Local\\RsmcpStudioWorker-${randomBytes(16).toString('hex')}`;
  const connection = connect('Broker', { name }, options);
  let ready;
  try {
    ready = await connection.ready;
    if (ready?.ready !== true || ready.name !== name) throw new Error('Studio worker broker did not establish the requested job');
  } catch (error) {
    await connection.finish().catch(() => {});
    throw error;
  }
  let drained = false;
  return {
    environment: { [STUDIO_WORKER_JOB_ENV]: name },
    async drain() {
      if (drained) return;
      const result = await connection.request({ op: 'drain' }, 645000);
      if (result?.drained !== true) throw new Error('Studio worker job drain was not confirmed; retaining worker directory');
      await connection.finish();
      drained = true;
    },
  };
}

export async function launchInStudioWorkerJob(executable, args, workingDirectory, options) {
  const name = validateStudioWorkerJobName(options.env[STUDIO_WORKER_JOB_ENV]);
  const connection = connect('Launch', {
    name, executable: options.toWindowsPath(executable), args, cwd: options.toWindowsPath(workingDirectory),
    environment: Object.fromEntries(Object.entries(options.env).filter(([key]) =>
      process.platform === 'win32' || !/^(?:PATH|HOME|SHELL|PWD|OLDPWD|WSLENV|PSModulePath|WinPSModulePath)$/iu.test(key))),
  }, options);
  let result;
  try { result = await connection.ready; }
  catch (error) {
    await connection.finish().catch(() => {});
    throw error;
  }
  await connection.finish();
  if (!Number.isSafeInteger(result?.pid) || result.pid <= 0) throw new Error('Studio worker launch did not return a process identity');
  return result.pid;
}

import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, REPO_ROOT } from './mcp-client.mjs';
import { callMcpHttpTool } from './mcp-http-client.mjs';
import {
  closeStudioProcess,
  assertStudioDirectoryIsolation,
  assertStudioTestProfile,
} from '../../scripts/studio-lifecycle.mjs';

const DEFAULT_LAUNCH_TIMEOUT_MS = 120000;
const TOOL_TIMEOUT_MS = 30000;
const CONNECTION_POLL_MS = 500;
const RECOVERY_POLL_MS = 100;
const RECOVERY_TIMEOUT_MS = 2000;
const SUCCESSFUL_CLOSE_STATUSES = new Set(['closed', 'already_closed']);

function stageRunnerBaseplate() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-runner-'));
  const placePath = path.join(directory, `RunnerBaseplate-${randomBytes(16).toString('hex')}.rbxl`);
  try {
    copyFileSync(path.join(REPO_ROOT, 'packages/core/assets/Baseplate.rbxl'), placePath);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: placePath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createManagedInstanceRegistry() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'rsmcp-registry-'));
  return {
    directory,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const defaultAdapters = {
  createControl(env) {
    return new McpClient('run-all-studio-manager', {
      env,
      startupTimeoutMs: 10000,
    });
  },
  callTool: callMcpHttpTool,
  closeProcessIdentity: closeStudioProcess,
  assertDirectoryIsolation: assertStudioDirectoryIsolation,
  assertTestProfile: assertStudioTestProfile,
  createRegistry: createManagedInstanceRegistry,
  stagePlace: stageRunnerBaseplate,
  delay,
};

function existingSession(instanceId, env) {
  return {
    instanceId,
    managed: false,
    env,
    async close() {},
  };
}


function controlEnvironment(runtimeEnv, port, authToken) {
  const env = {
    ...runtimeEnv,
    ROBLOX_STUDIO_AUTH_TOKEN: authToken,
    ROBLOX_STUDIO_PORT: String(port),
    ROBLOX_STUDIO_REQUIRE_PRIMARY: '1',
    RSMCP_AUTO_ASSIGNED_PORT: '0',
  };
  return env;
}

function managedEntries(status) {
  if (!Array.isArray(status?.managed)) {
    throw new Error('manage_instance status did not return a managed array');
  }
  return status.managed;
}

function launchIdOf(value) {
  return typeof value?.launch_id === 'string' && value.launch_id
    ? value.launch_id
    : undefined;
}

function cleanupError(primary, cleanupErrors) {
  if (cleanupErrors.length === 0) return primary;
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const combined = new AggregateError(
    [primaryError, ...cleanupErrors],
    `${primaryError.message} Cleanup also failed: ${cleanupErrors.map((error) => error.message).join('; ')}`,
    { cause: primaryError },
  );
  if ([primaryError, ...cleanupErrors].some((error) => error.retainedStudioResources)) {
    combined.retainedStudioResources = true;
  }
  return combined;
}

function assertCloseSucceeded(result, launchId) {
  if (!SUCCESSFUL_CLOSE_STATUSES.has(result?.close_status)) {
    throw new Error(
      `manage_instance did not confirm launch ${launchId} was closed ` +
      `(close_status=${JSON.stringify(result?.close_status)})`,
    );
  }
}

async function closeLaunch(adapters, port, env, launchId) {
  const result = await adapters.callTool(
    'manage_instance',
    { action: 'close', launch_id: launchId },
    { port, env, timeoutMs: TOOL_TIMEOUT_MS },
  );
  assertCloseSucceeded(result, launchId);
}

async function recoverIndeterminateLaunch({
  adapters,
  port,
  env,
  placePath,
  baselineLaunchIds,
  responseReceived,
}) {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  let attempted = false;
  let lastStatusError;
  while (!attempted || (!responseReceived && Date.now() < deadline)) {
    attempted = true;
    try {
      const status = await adapters.callTool(
        'manage_instance',
        { action: 'status' },
        {
          port,
          env,
          timeoutMs: Math.max(1, Math.min(TOOL_TIMEOUT_MS, deadline - Date.now())),
        },
      );
      const matching = managedEntries(status)
        .filter((entry) => entry?.local_place_file === placePath)
        .map(launchIdOf)
        .filter((launchId) => launchId && !baselineLaunchIds.has(launchId));
      if (matching.length > 0) return [...new Set(matching)];
      lastStatusError = undefined;
    } catch (error) {
      lastStatusError = error instanceof Error ? error : new Error(String(error));
    }
    if (responseReceived) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await adapters.delay(Math.min(RECOVERY_POLL_MS, remainingMs));
  }
  if (lastStatusError) throw lastStatusError;
  return [];
}

async function waitForEditConnection({
  adapters,
  port,
  env,
  launchId,
  launchTimeoutMs,
}) {
  const deadline = Date.now() + launchTimeoutMs;
  let attempted = false;
  let lastStatus;
  while (!attempted || Date.now() < deadline) {
    attempted = true;
    lastStatus = await adapters.callTool(
      'manage_instance',
      { action: 'status', launch_id: launchId },
      {
        port,
        env,
        timeoutMs: Math.max(1, Math.min(TOOL_TIMEOUT_MS, deadline - Date.now())),
      },
    );
    const hasEditRole = Array.isArray(lastStatus?.roles) && lastStatus.roles.includes('edit');
    if (
      typeof lastStatus?.instance_id === 'string' &&
      lastStatus.instance_id &&
      lastStatus.connected === true &&
      hasEditRole
    ) {
      return lastStatus.instance_id;
    }
    if (lastStatus?.state === 'failed' || lastStatus?.state === 'exited') {
      throw new Error(
        `Managed Studio launch ${launchId} entered state ${lastStatus.state}: ` +
        (lastStatus.failure_reason ?? 'Studio did not connect'),
      );
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await adapters.delay(Math.min(CONNECTION_POLL_MS, remainingMs));
  }
  throw new Error(
    `Managed Studio launch ${launchId} did not establish an edit connection within ` +
    `${launchTimeoutMs}ms (last state=${JSON.stringify(lastStatus?.state)})`,
  );
}

export async function openManagedStudioSession(
  {
    port,
    existingInstanceId,
    launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
    env: runtimeEnv = process.env,
  },
  injectedAdapters = {},
) {
  const suppliedInstanceId = typeof existingInstanceId === 'string'
    ? existingInstanceId.trim()
    : '';
  if (suppliedInstanceId) return existingSession(suppliedInstanceId, runtimeEnv);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP HTTP port ${port}`);
  }
  if (!Number.isInteger(launchTimeoutMs) || launchTimeoutMs < 1) {
    throw new Error(`Invalid managed Studio launch timeout ${launchTimeoutMs}`);
  }
  const studioWorkingDirectory = typeof runtimeEnv.RSMCP_STUDIO_WORKING_DIRECTORY === 'string'
    && runtimeEnv.RSMCP_STUDIO_WORKING_DIRECTORY.trim()
    ? runtimeEnv.RSMCP_STUDIO_WORKING_DIRECTORY
    : undefined;

  const adapters = { ...defaultAdapters, ...injectedAdapters };
  const authToken = randomBytes(32).toString('hex');
  const sessionEnv = {
    ...runtimeEnv,
    ROBLOX_STUDIO_AUTH_TOKEN: authToken,
    ROBLOX_STUDIO_PORT: String(port),
    RSMCP_AUTO_ASSIGNED_PORT: '0',
    ROBLOX_STUDIO_NO_AUTH: '0',
    ROBLOX_STUDIO_REQUIRE_PRIMARY: '0',
    MCP_INSTANCE_ID: '',
  };
  let ownedEnvironment;
  let registry;
  let control;
  let controlStarted = false;
  let stagedPlace;
  let launchId;
  let launchProcessIdentity;
  let launchMayBeLive = false;

  async function release({ close = true } = {}) {
    const errors = [];
    let managedCloseConfirmed = false;
    if (close && launchMayBeLive && launchId) {
      try {
        await closeLaunch(adapters, port, ownedEnvironment, launchId);
        managedCloseConfirmed = true;
        launchMayBeLive = false;
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (
      close &&
      launchMayBeLive &&
      !managedCloseConfirmed &&
      launchProcessIdentity &&
      typeof adapters.closeProcessIdentity === 'function'
    ) {
      try {
        await adapters.closeProcessIdentity(launchProcessIdentity);
        launchMayBeLive = false;
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (controlStarted) {
      try {
        await control.stop();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      controlStarted = false;
    }
    if (launchMayBeLive) {
      const retained = new Error(
        'Studio close could not be confirmed; retained staged place ' +
        `${stagedPlace?.path ?? '(none)'} and registry ` +
        `${sessionEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR} for exact-identity recovery.`,
      );
      retained.retainedStudioResources = true;
      errors.push(retained);
      return errors;
    }
    if (stagedPlace) {
      try {
        await stagedPlace.cleanup();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      stagedPlace = undefined;
    }
    if (registry) {
      try {
        await registry.cleanup();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      registry = undefined;
    }
    return errors;
  }

  try {
    await adapters.assertTestProfile();
    await adapters.assertDirectoryIsolation();
    if (!sessionEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR?.trim()) {
      registry = await adapters.createRegistry();
      if (typeof registry?.directory !== 'string' || !registry.directory.trim()) {
        throw new Error('The managed Studio runner did not allocate a private registry directory');
      }
      sessionEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR = registry.directory;
    }
    ownedEnvironment = controlEnvironment(sessionEnv, port, authToken);
    control = adapters.createControl(ownedEnvironment);
    controlStarted = true;
    await control.start();
    stagedPlace = await adapters.stagePlace();
    if (typeof stagedPlace?.path !== 'string' || !stagedPlace.path) {
      throw new Error('The managed Studio runner did not stage a local place file');
    }

    const baselineStatus = await adapters.callTool(
      'manage_instance',
      { action: 'status' },
      { port, env: ownedEnvironment, timeoutMs: TOOL_TIMEOUT_MS },
    );
    const baselineLaunchIds = new Set(managedEntries(baselineStatus).map(launchIdOf).filter(Boolean));

    let launch;
    try {
      launchMayBeLive = true;
      launch = await adapters.callTool(
        'manage_instance',
        {
          action: 'launch',
          source: 'local_file',
          local_place_file: stagedPlace.path,
          require_process_identity: true,
          timeout_ms: launchTimeoutMs,
          ...(studioWorkingDirectory ? { studio_working_directory: studioWorkingDirectory } : {}),
        },
        { port, env: ownedEnvironment, timeoutMs: TOOL_TIMEOUT_MS },
      );
      if (
        Number.isSafeInteger(launch?.pid) &&
        launch.pid > 0 &&
        typeof launch?.process_started_at_file_time === 'string' &&
        /^[1-9]\d*$/u.test(launch.process_started_at_file_time)
      ) {
        launchProcessIdentity = {
          processId: launch.pid,
          startedAtFileTime: launch.process_started_at_file_time,
        };
      }
      launchId = launchIdOf(launch);
      if (!launchId) {
        const malformedResponse = new Error('manage_instance launch did not return a launch_id');
        malformedResponse.responseReceived = true;
        throw malformedResponse;
      }
    } catch (error) {
      const responseLaunchId = launchIdOf(error?.body);
      if (responseLaunchId) launchId = responseLaunchId;
      if (
        Number.isSafeInteger(error?.body?.pid) &&
        error.body.pid > 0 &&
        typeof error?.body?.process_started_at_file_time === 'string' &&
        /^[1-9]\d*$/u.test(error.body.process_started_at_file_time)
      ) {
        launchProcessIdentity = {
          processId: error.body.pid,
          startedAtFileTime: error.body.process_started_at_file_time,
        };
      }
      const recoveredLaunchIds = responseLaunchId
        ? [responseLaunchId]
        : await recoverIndeterminateLaunch({
          adapters,
          port,
          env: ownedEnvironment,
          placePath: stagedPlace.path,
          baselineLaunchIds,
          responseReceived: error?.responseReceived === true,
        });
      const recoveryErrors = [];
      for (const recoveredLaunchId of recoveredLaunchIds) {
        try {
          await closeLaunch(adapters, port, ownedEnvironment, recoveredLaunchId);
        } catch (closeError) {
          recoveryErrors.push(closeError instanceof Error ? closeError : new Error(String(closeError)));
        }
      }
      if (recoveredLaunchIds.length > 0 && recoveryErrors.length === 0) launchMayBeLive = false;
      throw cleanupError(error, recoveryErrors);
    }

    const authorized = await adapters.callTool(
      'manage_instance',
      { action: 'authorize', launch_id: launchId },
      { port, env: ownedEnvironment, timeoutMs: TOOL_TIMEOUT_MS },
    );
    if (authorized?.process_authorized !== true) {
      throw new Error(`manage_instance did not confirm launch ${launchId} was authorized`);
    }
    const completed = await adapters.callTool(
      'manage_instance',
      { action: 'complete', launch_id: launchId },
      { port, env: ownedEnvironment, timeoutMs: TOOL_TIMEOUT_MS },
    );
    if (completed?.process_ownership_released !== true) {
      throw new Error(`manage_instance did not confirm launch ${launchId} released process ownership`);
    }

    const instanceId = await waitForEditConnection({
      adapters,
      port,
      env: ownedEnvironment,
      launchId,
      launchTimeoutMs,
    });

    let closePromise;
    return {
      instanceId,
      managed: true,
      launchId,
      processIdentity: launchProcessIdentity,
      env: sessionEnv,
      managedInstanceRegistryDirectory: sessionEnv.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR,
      studioWorkingDirectory,
      close() {
        if (!closePromise) {
          closePromise = (async () => {
            const errors = await release();
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
              throw cleanupError(errors[0], errors.slice(1));
            }
          })();
        }
        return closePromise;
      },
    };
  } catch (error) {
    const errors = await release();
    throw cleanupError(error, errors);
  }
}

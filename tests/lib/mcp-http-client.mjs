
export class McpHttpToolError extends Error {
  constructor(message, {
    responseReceived = false,
    status,
    body,
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'McpHttpToolError';
    this.responseReceived = responseReceived;
    this.status = status;
    this.body = body;
  }
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const DEFAULT_TIMEOUT_MS = 30000;

function authToken(env) {
  const noAuth = String(env.ROBLOX_STUDIO_NO_AUTH ?? '').toLowerCase();
  if (noAuth === '1' || noAuth === 'true') return undefined;

  const configured = env.ROBLOX_STUDIO_AUTH_TOKEN?.trim();
  if (configured) return configured;
  throw new Error(
    'MCP HTTP auth requires an explicit ROBLOX_STUDIO_AUTH_TOKEN ' +
    '(or ROBLOX_STUDIO_NO_AUTH=1 for an intentionally unauthenticated test server).',
  );
}

function errorDetail(body, fallback) {
  const text = body?.content?.find?.((entry) => entry?.type === 'text')?.text;
  if (typeof text === 'string' && text) return text;
  if (typeof body?.message === 'string' && body.message) return body.message;
  if (typeof body?.error === 'string' && body.error) return body.error;
  return fallback;
}

export async function callMcpHttpTool(
  toolName,
  args,
  {
    port,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  if (!TOOL_NAME_PATTERN.test(toolName)) {
    throw new Error(`Invalid MCP tool name ${JSON.stringify(toolName)}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP HTTP port ${port}`);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('MCP tool arguments must be an object');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`Invalid MCP HTTP timeout ${timeoutMs}`);
  }


  const token = authToken(env);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/mcp/${toolName}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-mcp-auth': token } : {}),
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new McpHttpToolError(
      `MCP HTTP tool ${toolName} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const rawBody = await response.text();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (cause) {
    throw new McpHttpToolError(
      `MCP HTTP tool ${toolName} returned non-JSON HTTP ${response.status}: ${rawBody.slice(0, 300)}`,
      { responseReceived: true, status: response.status, cause },
    );
  }

  if (!response.ok || body?.isError || (typeof body?.error === 'string' && body.error)) {
    throw new McpHttpToolError(
      `MCP HTTP tool ${toolName} failed (HTTP ${response.status}): ` +
      errorDetail(body, response.statusText || rawBody || 'unknown error'),
      { responseReceived: true, status: response.status, body },
    );
  }
  return body;
}

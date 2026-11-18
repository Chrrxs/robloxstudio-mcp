// Long tool calls (playtest lifecycle, wait_until) answer {state:"pending",
// requestId} once the server's response budget runs out, and keep running.
// The harness collects them with get_request_status so callers keep seeing
// the original result shape.

// get_request_status rejects a larger wait_ms; the server also caps it at its budget.
export const MAX_STATUS_WAIT_MS = 300_000;
// Leaves room for the status reply to arrive before the caller's timeout.
export const PENDING_COLLECT_MARGIN_MS = 2_000;

/** A budgeted call still running. generate_model async statuses carry no `tool`, so they stay as they are. */
export function isPendingToolCall(name, body) {
  return name !== 'get_request_status'
    && body !== null
    && typeof body === 'object'
    && body.state === 'pending'
    && body.tool === name
    && typeof body.requestId === 'string';
}

/** Maps a get_request_status body to the result of the original call: { body, isError }. */
export function collectedToolResult(name, status) {
  const body = status.body;
  if (isPendingToolCall(name, body)) return status;
  if (body?.state === 'settled' && body.outcome === 'result') {
    return { body: body.result, isError: status.isError };
  }
  if (body?.state === 'settled' && body.outcome === 'error') {
    return { body, isError: true };
  }
  throw new Error(`Pending ${name} result could not be collected: ${JSON.stringify(body)}`);
}

/**
 * SSE event formatting utilities for SSEGateway
 *
 * Implements Server-Sent Event formatting following the full SSE specification.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * Two tiers of named events live on this connection:
 *
 * - **Protocol/control signals** (`ready`, `rejected`): emitted as true named
 *   SSE events on the named channel — `event: <name>\ndata: <payload>\n\n` —
 *   so clients consume them via `addEventListener('<name>', ...)` separately
 *   from the application event stream. These are the gateway speaking, not
 *   payloads from the application. `ready` carries no payload (its `data:`
 *   line is empty, a WHATWG-spec workaround so browsers don't discard the
 *   event); `rejected` carries a single-line JSON payload.
 * - **Application/domain events** (everything else with a name): wrapped in an
 *   unnamed envelope `data: {"type":"<name>","payload":<data>}\n\n` so a single
 *   `onmessage` handler handles all domain events without per-event listener
 *   subscription races.
 *
 * If a third protocol event is added, factor out the shared shape rather than
 * adding a third special-case branch.
 */

/**
 * Format an SSE event for the wire.
 *
 * Behaviour:
 * - **`ready` control signal**: named event with empty data line —
 *   `event: ready\ndata:\n\n`. Any `data` argument is ignored. The empty
 *   `data:` line is required because browsers' EventSource discards events
 *   with no data field per the WHATWG HTML spec.
 * - **`rejected` control signal**: named event with a JSON payload —
 *   `event: rejected\ndata: <data>\n\n`. `data` is required and must be a
 *   single-line JSON string (no embedded newlines); throws if missing.
 * - **Unnamed events** (no name or empty name): classic SSE format with
 *   raw `data:` lines only.
 * - **All other named events**: wrapped in an unnamed envelope so the browser
 *   receives them via `EventSource.onmessage`:
 *   `data: {"type":"<name>","payload":<data>}\n\n`
 *
 * @param name - Optional event type name
 * @param data - Event data string (may contain newlines for unnamed/application events).
 *               Required for `rejected`; ignored for `ready`.
 * @returns Formatted SSE event string ready to write to response stream
 *
 * @example
 * ```ts
 * // Named event -> envelope (unnamed)
 * formatSseEvent('version', '{"version":"abc123"}')
 * // Returns: 'data: {"type":"version","payload":{"version":"abc123"}}\n\n'
 *
 * // ready -> named event with empty data line
 * formatSseEvent('ready')
 * // Returns: 'event: ready\ndata:\n\n'
 *
 * // rejected -> named event with JSON payload
 * formatSseEvent('rejected', '{"status":401,"message":"Unauthorized"}')
 * // Returns: 'event: rejected\ndata: {"status":401,"message":"Unauthorized"}\n\n'
 *
 * // No name -> raw data
 * formatSseEvent(undefined, 'Hello')
 * // Returns: 'data: Hello\n\n'
 * ```
 */
export function formatSseEvent(name: string | undefined, data?: string): string {
  // ready is a control-signal named event. Emit with an empty `data:` line
  // because browsers' EventSource discards events that have no data field
  // (per the WHATWG HTML spec for server-sent events).
  if (name === 'ready') {
    return 'event: ready\ndata:\n\n';
  }

  // rejected is a control-signal named event carrying a JSON payload.
  // The payload must be single-line JSON (no embedded newlines) so it fits
  // on one SSE `data:` line.
  if (name === 'rejected') {
    if (data === undefined || data.length === 0) {
      throw new Error('formatSseEvent: rejected event requires a data payload');
    }
    return `event: rejected\ndata: ${data}\n\n`;
  }

  const hasName = name !== undefined && name.length > 0;
  const payload = data ?? '';

  // Named events get wrapped in an envelope on the unnamed channel
  if (hasName) {
    // Build the envelope JSON: {"type":"<name>","payload":<data>}
    // `data` is already a JSON string from the backend, so embed it raw as the payload value.
    const envelope = `{"type":${JSON.stringify(name)},"payload":${payload}}`;
    return `data: ${envelope}\n\n`;
  }

  // Unnamed events use the classic SSE format
  let event = '';

  // Split data on newlines and send each line as a separate data field
  // This handles multi-line data correctly per SSE spec
  const lines = payload.split('\n');
  for (const line of lines) {
    event += `data: ${line}\n`;
  }

  event += '\n';

  return event;
}

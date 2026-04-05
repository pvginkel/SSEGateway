/**
 * SSE event formatting utilities for SSEGateway
 *
 * Implements Server-Sent Event formatting following the full SSE specification.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * Named events (other than the control-signal `ready` event) are wrapped
 * in an unnamed envelope: `data: {"type":"<name>","payload":<data>}\n\n`.
 * This allows consumers to use a single `onmessage` handler instead of
 * registering per-event-type listeners, eliminating subscription race conditions.
 *
 * The `ready` event is a control signal (connection is live and AMQP bindings
 * are established). It is emitted as a named SSE event with an empty data
 * line so clients can listen for it via `addEventListener('ready', ...)`
 * without it appearing in the normal `onmessage` domain-event stream. The
 * empty `data:` line is required because browsers' EventSource silently
 * discards events with no data per the WHATWG HTML spec.
 */

/**
 * Format an SSE event for the wire.
 *
 * Behaviour:
 * - **`ready` control signal**: named event with empty data line —
 *   `event: ready\ndata:\n\n`. Any `data` argument is ignored. The empty
 *   `data:` line is required because browsers' EventSource discards events
 *   with no data field per the WHATWG HTML spec.
 * - **Unnamed events** (no name or empty name): classic SSE format with
 *   raw `data:` lines only.
 * - **All other named events**: wrapped in an unnamed envelope so the browser
 *   receives them via `EventSource.onmessage`:
 *   `data: {"type":"<name>","payload":<data>}\n\n`
 *
 * @param name - Optional event type name
 * @param data - Event data string (may contain newlines). Not used for `ready`.
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

/**
 * SSE event formatting utilities for SSEGateway
 *
 * Implements Server-Sent Event formatting following the full SSE specification.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * Named events (except internal plumbing like `connection_close`) are wrapped
 * in an unnamed envelope: `data: {"type":"<name>","payload":<data>}\n\n`.
 * This allows consumers to use a single `onmessage` handler instead of
 * registering per-event-type listeners, eliminating subscription race conditions.
 */

/** Event names that retain the legacy named-event format (internal plumbing). */
const NAMED_EVENT_PASSTHROUGH = new Set(['connection_close']);

/**
 * Format an SSE event for the wire.
 *
 * Behaviour:
 * - **No name / passthrough name** (`connection_close`): classic SSE format
 *   with optional `event:` line and raw `data:` lines.
 * - **All other named events**: wrapped in an unnamed envelope so the browser
 *   receives them via `EventSource.onmessage`:
 *   `data: {"type":"<name>","payload":<data>}\n\n`
 *
 * @param name - Optional event type name
 * @param data - Event data string (may contain newlines)
 * @returns Formatted SSE event string ready to write to response stream
 *
 * @example
 * ```ts
 * // Named event -> envelope (unnamed)
 * formatSseEvent('version', '{"version":"abc123"}')
 * // Returns: 'data: {"type":"version","payload":{"version":"abc123"}}\n\n'
 *
 * // connection_close stays named (passthrough)
 * formatSseEvent('connection_close', '{"reason":"done"}')
 * // Returns: 'event: connection_close\ndata: {"reason":"done"}\n\n'
 *
 * // No name -> raw data
 * formatSseEvent(undefined, 'Hello')
 * // Returns: 'data: Hello\n\n'
 * ```
 */
export function formatSseEvent(name: string | undefined, data: string): string {
  const hasName = name !== undefined && name.length > 0;

  // Named events that are NOT in the passthrough set get wrapped in an envelope
  if (hasName && !NAMED_EVENT_PASSTHROUGH.has(name)) {
    // Build the envelope JSON: {"type":"<name>","payload":<data>}
    // `data` is already a JSON string from the backend, so embed it raw as the payload value.
    const envelope = `{"type":${JSON.stringify(name)},"payload":${data}}`;
    return `data: ${envelope}\n\n`;
  }

  // Passthrough path: connection_close or unnamed events use the classic format
  let event = '';

  if (hasName) {
    event += `event: ${name}\n`;
  }

  // Split data on newlines and send each line as a separate data field
  // This handles multi-line data correctly per SSE spec
  const lines = data.split('\n');
  for (const line of lines) {
    event += `data: ${line}\n`;
  }

  event += '\n';

  return event;
}

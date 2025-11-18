/**
 * SSE event formatting utilities for SSEGateway
 *
 * Implements Server-Sent Event formatting following the full SSE specification.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

/**
 * Format an SSE event according to the full SSE specification
 *
 * SSE format:
 * - If event name is provided: `event: <name>\n`
 * - For each line in data: `data: <line>\n`
 * - Blank line terminator: `\n`
 *
 * Multi-line data is split on `\n` and sent as separate `data:` lines.
 *
 * @param name - Optional event type name
 * @param data - Event data string (may contain newlines)
 * @returns Formatted SSE event string ready to write to response stream
 *
 * @example
 * ```ts
 * // Simple event with name
 * formatSseEvent('message', 'Hello, world!')
 * // Returns: "event: message\ndata: Hello, world!\n\n"
 *
 * // Event without name
 * formatSseEvent(undefined, 'Hello')
 * // Returns: "data: Hello\n\n"
 *
 * // Multi-line data
 * formatSseEvent('update', 'Line 1\nLine 2\nLine 3')
 * // Returns: "event: update\ndata: Line 1\ndata: Line 2\ndata: Line 3\n\n"
 *
 * // Empty data
 * formatSseEvent(undefined, '')
 * // Returns: "data: \n\n"
 * ```
 */
export function formatSseEvent(name: string | undefined, data: string): string {
  // Build event string following SSE spec
  let event = '';

  // Add event name line if provided (and non-empty)
  if (name && name.length > 0) {
    event += `event: ${name}\n`;
  }

  // Split data on newlines and send each line as a separate data field
  // This handles multi-line data correctly per SSE spec
  const lines = data.split('\n');
  for (const line of lines) {
    event += `data: ${line}\n`;
  }

  // Add blank line to terminate event
  event += '\n';

  return event;
}

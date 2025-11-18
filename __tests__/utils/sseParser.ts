/**
 * SSE event stream parser for testing
 *
 * Parses Server-Sent Event streams to extract events for test assertions.
 */

/**
 * Parsed SSE event
 */
export interface SseEvent {
  /** Event type (if specified) */
  event?: string;
  /** Event data (joined from all data lines) */
  data: string;
  /** Raw event string (for debugging) */
  raw: string;
}

/**
 * Parse SSE event stream into individual events
 *
 * Follows the SSE specification for parsing:
 * - Events are separated by blank lines
 * - Each event can have multiple fields (event, data, id, retry)
 * - Data fields are accumulated and joined with newlines
 *
 * @param stream - Raw SSE stream string
 * @returns Array of parsed events
 *
 * @example
 * ```ts
 * const stream = `event: message\ndata: Hello\n\ndata: World\n\n`;
 * const events = parseSseStream(stream);
 * // [
 * //   { event: 'message', data: 'Hello', raw: 'event: message\ndata: Hello\n\n' },
 * //   { data: 'World', raw: 'data: World\n\n' }
 * // ]
 * ```
 */
export function parseSseStream(stream: string): SseEvent[] {
  const events: SseEvent[] = [];

  // Split stream into raw event chunks (separated by blank lines)
  // Note: SSE spec uses \n\n to separate events
  const rawEvents = stream.split(/\n\n/);

  for (const rawEvent of rawEvents) {
    // Skip empty chunks (trailing blank lines, etc.)
    if (!rawEvent.trim()) {
      continue;
    }

    // Parse individual event
    const event = parseSseEvent(rawEvent);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

/**
 * Parse a single SSE event from its raw string
 *
 * @param rawEvent - Raw event string (without trailing blank line)
 * @returns Parsed event or null if invalid
 */
function parseSseEvent(rawEvent: string): SseEvent | null {
  const lines = rawEvent.split('\n');
  let eventType: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    // Skip empty lines
    if (!line) {
      continue;
    }

    // Skip comments (lines starting with ':')
    if (line.startsWith(':')) {
      continue;
    }

    // Parse field: value format
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      // No colon - invalid line, skip
      continue;
    }

    const field = line.substring(0, colonIndex);
    // Value starts after colon, skip leading space if present (per SSE spec)
    let value = line.substring(colonIndex + 1);
    if (value.startsWith(' ')) {
      value = value.substring(1);
    }

    // Handle field types
    if (field === 'event') {
      eventType = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // Ignore other fields (id, retry) for testing purposes
  }

  // Must have at least one data line to be a valid event
  if (dataLines.length === 0) {
    return null;
  }

  // Join data lines with newlines (per SSE spec)
  const data = dataLines.join('\n');

  return {
    event: eventType,
    data,
    raw: rawEvent + '\n\n', // Include blank line terminator in raw
  };
}

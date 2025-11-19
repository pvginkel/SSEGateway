/**
 * SSE stream reader utility for testing
 *
 * Provides a utility to capture and parse SSE stream output including comments (heartbeats).
 * Used by integration tests to verify heartbeat delivery and timing.
 */

/**
 * SSE stream item - can be an event or a comment
 */
export interface SseStreamItem {
  /** Item type: 'event' or 'comment' */
  type: 'event' | 'comment';
  /** Event data (for events) */
  event?: string;
  /** Event data (for events) */
  data?: string;
  /** Comment text (for comments) */
  comment?: string;
  /** Raw item string (for debugging) */
  raw: string;
  /** Timestamp when item was captured (milliseconds since epoch) */
  timestamp: number;
}

/**
 * SSE Stream Reader
 *
 * Captures and parses SSE stream output including both events and comments.
 * Provides methods to wait for heartbeats, count items, and verify stream content.
 */
export class SseStreamReader {
  private items: SseStreamItem[] = [];
  private buffer = '';
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Add chunk of SSE stream data
   *
   * Accumulates data in internal buffer and parses complete items (separated by blank lines).
   *
   * @param chunk - Raw SSE stream chunk (string or Buffer)
   */
  addChunk(chunk: string | Buffer): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    this.buffer += text;

    // Parse complete items (terminated by blank lines)
    // SSE spec: items are separated by \n\n
    const parts = this.buffer.split(/\n\n/);

    // Last part may be incomplete - keep it in buffer
    this.buffer = parts.pop() || '';

    // Parse complete items
    for (const part of parts) {
      if (!part.trim()) {
        continue;
      }

      const item = this.parseItem(part);
      if (item) {
        this.items.push(item);
      }
    }
  }

  /**
   * Parse a single SSE item (event or comment)
   *
   * @param raw - Raw item string (without trailing blank line)
   * @returns Parsed item or null if invalid
   */
  private parseItem(raw: string): SseStreamItem | null {
    const lines = raw.split('\n');

    // Check if this is a comment (all lines start with ':')
    const isComment = lines.every((line) => !line || line.startsWith(':'));

    if (isComment) {
      // Parse comment
      const commentLines = lines
        .filter((line) => line.startsWith(':'))
        .map((line) => {
          // Remove leading colon and optional space
          const content = line.substring(1);
          return content.startsWith(' ') ? content.substring(1) : content;
        });

      return {
        type: 'comment',
        comment: commentLines.join('\n'),
        raw: raw + '\n\n',
        timestamp: Date.now(),
      };
    } else {
      // Parse event
      let eventType: string | undefined;
      const dataLines: string[] = [];

      for (const line of lines) {
        if (!line) {
          continue;
        }

        // Skip comments within events
        if (line.startsWith(':')) {
          continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) {
          continue;
        }

        const field = line.substring(0, colonIndex);
        let value = line.substring(colonIndex + 1);

        // SSE spec: skip leading space after colon
        if (value.startsWith(' ')) {
          value = value.substring(1);
        }

        if (field === 'event') {
          eventType = value;
        } else if (field === 'data') {
          dataLines.push(value);
        }
        // Ignore other fields (id, retry)
      }

      // Must have at least one data line to be valid
      if (dataLines.length === 0) {
        return null;
      }

      return {
        type: 'event',
        event: eventType,
        data: dataLines.join('\n'),
        raw: raw + '\n\n',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Get all captured items (events and comments)
   *
   * @returns Array of all items in order received
   */
  getItems(): SseStreamItem[] {
    return [...this.items];
  }

  /**
   * Get all events (excluding comments)
   *
   * @returns Array of event items
   */
  getEvents(): SseStreamItem[] {
    return this.items.filter((item) => item.type === 'event');
  }

  /**
   * Get all comments (including heartbeats)
   *
   * @returns Array of comment items
   */
  getComments(): SseStreamItem[] {
    return this.items.filter((item) => item.type === 'comment');
  }

  /**
   * Get all heartbeat comments
   *
   * @returns Array of heartbeat comment items
   */
  getHeartbeats(): SseStreamItem[] {
    return this.items.filter(
      (item) => item.type === 'comment' && item.comment === 'heartbeat'
    );
  }

  /**
   * Wait for at least N heartbeats to be received
   *
   * @param count - Minimum number of heartbeats to wait for
   * @param timeoutMs - Maximum time to wait (milliseconds)
   * @returns Promise that resolves when condition is met or timeout expires
   */
  async waitForHeartbeats(count: number, timeoutMs: number): Promise<boolean> {
    const endTime = Date.now() + timeoutMs;

    while (Date.now() < endTime) {
      if (this.getHeartbeats().length >= count) {
        return true;
      }
      // Poll every 50ms
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return false;
  }

  /**
   * Wait for at least N items (events or comments) to be received
   *
   * @param count - Minimum number of items to wait for
   * @param timeoutMs - Maximum time to wait (milliseconds)
   * @returns Promise that resolves when condition is met or timeout expires
   */
  async waitForItems(count: number, timeoutMs: number): Promise<boolean> {
    const endTime = Date.now() + timeoutMs;

    while (Date.now() < endTime) {
      if (this.items.length >= count) {
        return true;
      }
      // Poll every 50ms
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return false;
  }

  /**
   * Get count of heartbeats received
   *
   * @returns Number of heartbeat comments
   */
  getHeartbeatCount(): number {
    return this.getHeartbeats().length;
  }

  /**
   * Get count of events received (excluding comments)
   *
   * @returns Number of events
   */
  getEventCount(): number {
    return this.getEvents().length;
  }

  /**
   * Clear all captured items and reset buffer
   */
  clear(): void {
    this.items = [];
    this.buffer = '';
    this.startTime = Date.now();
  }

  /**
   * Get elapsed time since reader was created or cleared
   *
   * @returns Elapsed time in milliseconds
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }
}

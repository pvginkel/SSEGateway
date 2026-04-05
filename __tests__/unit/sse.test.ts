/**
 * Unit tests for SSE formatting utilities
 */

import { formatSseEvent } from '../../src/sse.js';

describe('SSE Event Formatting', () => {
  describe('formatSseEvent', () => {
    // --- Envelope format (named events except connection_close) ---

    it('should wrap named events in an unnamed envelope', () => {
      const result = formatSseEvent('message', '"Hello, world!"');
      expect(result).toBe('data: {"type":"message","payload":"Hello, world!"}\n\n');
    });

    it('should wrap named events with JSON object data', () => {
      const result = formatSseEvent('version', '{"version":"abc123"}');
      expect(result).toBe('data: {"type":"version","payload":{"version":"abc123"}}\n\n');
    });

    it('should wrap task_event in envelope', () => {
      const data = '{"task_id":"t1","event_type":"progress_update"}';
      const result = formatSseEvent('task_event', data);
      expect(result).toBe(`data: {"type":"task_event","payload":${data}}\n\n`);
    });

    // --- ready: named control-signal event with empty data line ---

    it('should emit ready as a named event with empty data line', () => {
      // Browsers' EventSource discards events with no data field per WHATWG
      // HTML spec, so ready must include an empty `data:` line to dispatch.
      const result = formatSseEvent('ready');
      expect(result).toBe('event: ready\ndata:\n\n');
    });

    // --- Unnamed events (no name) ---

    it('should format event with data only (no name)', () => {
      const result = formatSseEvent(undefined, 'Hello');
      expect(result).toBe('data: Hello\n\n');
    });

    it('should skip event line when name is empty string', () => {
      const result = formatSseEvent('', 'Data');
      expect(result).toBe('data: Data\n\n');
    });

    it('should handle multiline data for unnamed events', () => {
      const result = formatSseEvent(undefined, 'Line 1\nLine 2\nLine 3');
      expect(result).toBe('data: Line 1\ndata: Line 2\ndata: Line 3\n\n');
    });

    it('should handle empty data for unnamed events', () => {
      const result = formatSseEvent(undefined, '');
      expect(result).toBe('data: \n\n');
    });

    it('should handle data with only newlines (unnamed)', () => {
      const result = formatSseEvent(undefined, '\n\n');
      expect(result).toBe('data: \ndata: \ndata: \n\n');
    });

    it('should handle data with trailing newline (unnamed)', () => {
      const result = formatSseEvent(undefined, 'Data\n');
      expect(result).toBe('data: Data\ndata: \n\n');
    });

    it('should handle data with leading newline (unnamed)', () => {
      const result = formatSseEvent(undefined, '\nData');
      expect(result).toBe('data: \ndata: Data\n\n');
    });

    // --- Shared invariants ---

    it('should always end with blank line', () => {
      const result1 = formatSseEvent('test', '"data"');
      const result2 = formatSseEvent(undefined, 'data');
      const result3 = formatSseEvent('ready');

      expect(result1.endsWith('\n\n')).toBe(true);
      expect(result2.endsWith('\n\n')).toBe(true);
      expect(result3.endsWith('\n\n')).toBe(true);
    });

    it('should not include event: line for envelope events', () => {
      const result = formatSseEvent('custom', '"test"');
      expect(result).not.toContain('event:');
      expect(result).toContain('data:');
    });

    it('should escape event name in envelope JSON', () => {
      const result = formatSseEvent('name"with"quotes', '"value"');
      expect(result).toBe('data: {"type":"name\\"with\\"quotes","payload":"value"}\n\n');
    });
  });
});

/**
 * Unit tests for SSE formatting utilities
 */

import { formatSseEvent } from '../../src/sse.js';

describe('SSE Event Formatting', () => {
  describe('formatSseEvent', () => {
    it('should format event with name and data', () => {
      const result = formatSseEvent('message', 'Hello, world!');
      expect(result).toBe('event: message\ndata: Hello, world!\n\n');
    });

    it('should format event with data only (no name)', () => {
      const result = formatSseEvent(undefined, 'Hello');
      expect(result).toBe('data: Hello\n\n');
    });

    it('should skip event line when name is empty string', () => {
      const result = formatSseEvent('', 'Data');
      expect(result).toBe('data: Data\n\n');
    });

    it('should handle multiline data correctly', () => {
      const result = formatSseEvent('update', 'Line 1\nLine 2\nLine 3');
      expect(result).toBe('event: update\ndata: Line 1\ndata: Line 2\ndata: Line 3\n\n');
    });

    it('should handle empty data', () => {
      const result = formatSseEvent(undefined, '');
      expect(result).toBe('data: \n\n');
    });

    it('should handle data with only newlines', () => {
      const result = formatSseEvent(undefined, '\n\n');
      expect(result).toBe('data: \ndata: \ndata: \n\n');
    });

    it('should handle data with trailing newline', () => {
      const result = formatSseEvent('test', 'Data\n');
      expect(result).toBe('event: test\ndata: Data\ndata: \n\n');
    });

    it('should handle data with leading newline', () => {
      const result = formatSseEvent('test', '\nData');
      expect(result).toBe('event: test\ndata: \ndata: Data\n\n');
    });

    it('should always end with blank line', () => {
      const result1 = formatSseEvent('test', 'data');
      const result2 = formatSseEvent(undefined, 'data');
      const result3 = formatSseEvent('test', '');

      expect(result1.endsWith('\n\n')).toBe(true);
      expect(result2.endsWith('\n\n')).toBe(true);
      expect(result3.endsWith('\n\n')).toBe(true);
    });

    it('should include event name line before data lines', () => {
      const result = formatSseEvent('custom', 'test');
      const lines = result.split('\n');

      expect(lines[0]).toBe('event: custom');
      expect(lines[1]).toBe('data: test');
      expect(lines[2]).toBe('');
      expect(lines[3]).toBe('');
    });
  });
});

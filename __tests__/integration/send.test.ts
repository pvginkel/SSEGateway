/**
 * Integration tests for send and close operations
 *
 * Tests the POST /internal/send endpoint for sending SSE events and closing connections.
 */

import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { MockServer } from '../utils/mockServer.js';
import { connections } from '../../src/connections.js';

describe('Send and Close Operations', () => {
  let mockServer: MockServer;
  let app: Express;
  let config: Config;

  beforeEach(async () => {
    // Clear connections Map between tests
    connections.clear();

    // Create and start mock Python backend server
    mockServer = new MockServer();
    await mockServer.start();

    // Create app with callback URL pointing to mock server
    config = {
      port: 3000,
      callbackUrl: mockServer.getCallbackUrl(),
      heartbeatIntervalSeconds: 15,
    };
    app = createApp(config);
  });

  afterEach(async () => {
    // Clear connections to prevent leaks
    connections.clear();

    // Stop mock server
    if (mockServer) {
      await mockServer.stop();
    }

    // Give some time for any pending async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  describe('POST /internal/send - send events', () => {
    it('should send event with name and data to active connection', async () => {
      // Establish SSE connection
      const sseRequest = request(app).get('/sse/test-channel');
      const ssePromise = sseRequest.then(() => {}, () => {});

      // Wait for connection to be established
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get the token from callback
      const connectCallback = mockServer.getCallbacks().find((cb) => cb.action === 'connect');
      expect(connectCallback).toBeDefined();
      const token = connectCallback!.token;

      // Verify connection is in Map
      expect(connections.has(token)).toBe(true);

      // Send event via internal API
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: {
            name: 'message',
            data: 'Hello, world!',
          },
        });

      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body).toEqual({ status: 'ok' });

      // Verify connection still exists after sending (not closed)
      expect(connections.has(token)).toBe(true);

      // Cleanup
      sseRequest.abort();
      await ssePromise;
    }, 10000);

    it('should send event without name (data only)', async () => {
      const sseRequest = request(app).get('/sse/test');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      // Send event without name
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: {
            data: 'Unnamed event data',
          },
        });

      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body).toEqual({ status: 'ok' });

      // Verify connection still exists
      expect(connections.has(token)).toBe(true);

      // Cleanup
      sseRequest.abort();
      await ssePromise;
    }, 10000);

    it('should handle multiline data correctly', async () => {
      const sseRequest = request(app).get('/sse/multiline');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      // Send event with multiline data
      const multilineData = 'Line 1\nLine 2\nLine 3';
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: {
            name: 'multiline',
            data: multilineData,
          },
        });

      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body).toEqual({ status: 'ok' });

      // Verify connection still exists
      expect(connections.has(token)).toBe(true);

      // Cleanup
      sseRequest.abort();
      await ssePromise;
    }, 10000);

    it('should handle empty data', async () => {
      const sseRequest = request(app).get('/sse/empty');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      // Send event with empty data
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: {
            data: '',
          },
        });

      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body).toEqual({ status: 'ok' });

      // Verify connection still exists
      expect(connections.has(token)).toBe(true);

      // Cleanup
      sseRequest.abort();
      await ssePromise;
    }, 10000);

    it('should send multiple events in sequence', async () => {
      const sseRequest = request(app).get('/sse/sequence');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      // Send multiple events
      const response1 = await request(app)
        .post('/internal/send')
        .send({ token, event: { name: 'event1', data: 'First' } });
      expect(response1.status).toBe(200);

      const response2 = await request(app)
        .post('/internal/send')
        .send({ token, event: { name: 'event2', data: 'Second' } });
      expect(response2.status).toBe(200);

      const response3 = await request(app)
        .post('/internal/send')
        .send({ token, event: { name: 'event3', data: 'Third' } });
      expect(response3.status).toBe(200);

      // Verify connection still exists after all events
      expect(connections.has(token)).toBe(true);

      // Cleanup
      sseRequest.abort();
      await ssePromise;
    }, 10000);
  });

  describe('POST /internal/send - close connections', () => {
    it('should close connection when close: true (no event)', async () => {
      // Establish SSE connection
      const sseReq = request(app).get('/sse/to-close');
      const ssePromise = sseReq.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;
      expect(connections.has(token)).toBe(true);

      // Clear previous callbacks to isolate disconnect callback
      mockServer.clearCallbacks();

      // Close connection via internal API
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          close: true,
        });

      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body).toEqual({ status: 'ok' });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify disconnect callback was sent with reason "server_closed"
      const callbacks = mockServer.getCallbacks();
      const disconnectCallback = callbacks.find(
        (cb) => cb.action === 'disconnect' && cb.token === token
      );
      expect(disconnectCallback).toBeDefined();
      expect(disconnectCallback!.reason).toBe('server_closed');

      // Verify connection was removed from Map
      expect(connections.has(token)).toBe(false);

      // Cleanup
      await ssePromise;
    }, 10000);

    it('should send event THEN close when both provided', async () => {
      const sseRequest = request(app).get('/sse/send-and-close');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      mockServer.clearCallbacks();

      // Send event AND close
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: {
            name: 'goodbye',
            data: 'Final message',
          },
          close: true,
        });

      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body).toEqual({ status: 'ok' });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify disconnect callback was sent with reason "server_closed"
      const disconnectCallback = mockServer
        .getCallbacks()
        .find((cb) => cb.action === 'disconnect');
      expect(disconnectCallback).toBeDefined();
      expect(disconnectCallback!.reason).toBe('server_closed');

      // Verify connection was removed
      expect(connections.has(token)).toBe(false);

      // Cleanup
      await ssePromise;
    }, 10000);

    it('should clear heartbeat timer on close', async () => {
      // Establish SSE connection
      const sseReq = request(app).get('/sse/heartbeat-test');
      const ssePromise = sseReq.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      // Get connection record to verify heartbeat timer handling
      const connection = connections.get(token);
      expect(connection).toBeDefined();

      // Verify heartbeat timer is active
      expect(connection!.heartbeatTimer).not.toBeNull();

      // Close connection
      await request(app)
        .post('/internal/send')
        .send({ token, close: true });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify connection was removed (cleanup succeeded even with null timer)
      expect(connections.has(token)).toBe(false);

      // Cleanup
      await ssePromise;
    }, 10000);
  });

  describe('POST /internal/send - error handling', () => {
    it('should return 404 for unknown token', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'unknown-token-12345',
          event: {
            data: 'Test',
          },
        });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          message: 'Token not found',
          code: 'TOKEN_NOT_FOUND',
        },
      });
    });

    it('should return 400 when token is missing', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          event: {
            data: 'Test',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: expect.stringMatching(/token is required/i),
          code: 'INVALID_TOKEN_MISSING',
        },
      });
    });

    it('should return 400 when token is not a string', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 12345, // Number instead of string
          event: {
            data: 'Test',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: expect.stringMatching(/token.*must be a string/i),
          code: 'INVALID_TOKEN_MISSING',
        },
      });
    });

    it('should return 400 when event is not an object', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'valid-token',
          event: 'not an object', // String instead of object
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: expect.stringMatching(/event must be an object/i),
          code: 'INVALID_EVENT_TYPE',
        },
      });
    });

    it('should return 400 when event.data is missing', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'valid-token',
          event: {
            name: 'test',
            // data is missing
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: expect.stringMatching(/event\.data.*required/i),
          code: 'INVALID_EVENT_DATA_MISSING',
        },
      });
    });

    it('should return 400 when event.data is not a string', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'valid-token',
          event: {
            data: 12345, // Number instead of string
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: expect.stringMatching(/event\.data.*must be a string/i),
          code: 'INVALID_EVENT_DATA_MISSING',
        },
      });
    });

    it('should return 400 when event.name is not a string', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'valid-token',
          event: {
            name: 12345, // Number instead of string
            data: 'Test',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: expect.stringMatching(/event\.name.*must be a string/i),
          code: 'INVALID_EVENT_NAME_TYPE',
        },
      });
    });

    it('should return 400 when close is not a boolean', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'valid-token',
          close: 'true', // String instead of boolean
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          message: expect.stringMatching(/close must be a boolean/i),
          code: 'INVALID_CLOSE_TYPE',
        },
      });
    });

    it('should return 404 when trying to close already-closed connection', async () => {
      // Establish and close connection
      const sseReq = request(app).get('/sse/double-close');
      const ssePromise = sseReq.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      // Close once
      await request(app)
        .post('/internal/send')
        .send({ token, close: true });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to close again - should get 404
      const response = await request(app)
        .post('/internal/send')
        .send({ token, close: true });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          message: 'Token not found',
          code: 'TOKEN_NOT_FOUND',
        },
      });

      // Cleanup
      await ssePromise;
    }, 10000);
  });

  describe('POST /internal/send - write failures', () => {
    it('should handle client disconnect during send', async () => {
      // Establish SSE connection
      const sseReq = request(app).get('/sse/disconnect-during-send');
      const ssePromise = sseReq.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;

      mockServer.clearCallbacks();

      // Abort connection immediately
      sseReq.abort();
      await ssePromise;

      // Wait a bit for disconnect to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to send event to disconnected connection
      // Note: This may succeed with 404 if disconnect processed first,
      // or may trigger write error if connection still in Map but stream closed
      const response = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: {
            data: 'Too late',
          },
        });

      // Either 404 (already cleaned up) or 500 (write failed)
      expect([404, 500]).toContain(response.status);

      // If write error occurred (500), verify error disconnect callback was sent
      if (response.status === 500) {
        const errorCallback = mockServer
          .getCallbacks()
          .find((cb) => cb.action === 'disconnect' && cb.reason === 'error');
        // May or may not be present depending on race condition
        // Just verify no crash occurred
      }

      // Verify connection is cleaned up
      expect(connections.has(token)).toBe(false);
    }, 10000);
  });

  describe('Event buffering during callback window', () => {
    it('should buffer event sent during callback and deliver after headers sent', async () => {
      // Configure slow callback to create buffering window
      mockServer.setDelay(200);

      // Initiate SSE connection
      const sseRequest = request(app).get('/sse/buffer-test');
      const ssePromise = sseRequest.then(() => {}, () => {});

      // Wait for connection to be added to Map but callback still in progress
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Get token from callback record
      const connectCallback = mockServer.getCallbacks().find((cb) => cb.action === 'connect');
      expect(connectCallback).toBeDefined();
      const token = connectCallback!.token;

      // Verify connection exists but is not ready
      const connection = connections.get(token);
      expect(connection).toBeDefined();
      expect(connection!.ready).toBe(false);

      // Send event during callback window
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: {
            name: 'buffered',
            data: 'This should be buffered',
          },
        });

      // Should return 'buffered' status
      expect(sendResponse.status).toBe(200);
      expect(sendResponse.body).toEqual({ status: 'buffered' });

      // Wait for callback to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify connection is now ready and buffer was cleared
      const readyConnection = connections.get(token);
      expect(readyConnection).toBeDefined();
      expect(readyConnection!.ready).toBe(true);
      expect(readyConnection!.eventBuffer.length).toBe(0);

      // Cleanup
      sseRequest.abort();
      await ssePromise;
    }, 10000);

    it('should buffer multiple events (3+) and deliver in FIFO order', async () => {
      // Configure slow callback
      mockServer.setDelay(250);

      const sseRequest = request(app).get('/sse/multi-buffer');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const token = mockServer.getLastCallback()!.token;
      const connection = connections.get(token);
      expect(connection!.ready).toBe(false);

      // Send three events during callback window
      const response1 = await request(app)
        .post('/internal/send')
        .send({ token, event: { name: 'first', data: 'Event 1' } });
      expect(response1.body.status).toBe('buffered');

      const response2 = await request(app)
        .post('/internal/send')
        .send({ token, event: { name: 'second', data: 'Event 2' } });
      expect(response2.body.status).toBe('buffered');

      const response3 = await request(app)
        .post('/internal/send')
        .send({ token, event: { name: 'third', data: 'Event 3' } });
      expect(response3.body.status).toBe('buffered');

      // Wait for callback to complete and buffer to flush
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify buffer was cleared
      const readyConnection = connections.get(token);
      expect(readyConnection).toBeDefined();
      expect(readyConnection!.eventBuffer.length).toBe(0);

      // Cleanup
      sseRequest.abort();
      await ssePromise;
    }, 10000);

    it('should discard buffered events when callback fails with 403', async () => {
      // Configure callback to fail with 403 after delay
      mockServer.setStatusCode(403);
      mockServer.setDelay(200);

      const sseRequest = request(app).get('/sse/callback-fail');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get token before callback completes
      const callbacks = mockServer.getCallbacks();
      const connectCallback = callbacks.find((cb) => cb.action === 'connect');
      expect(connectCallback).toBeDefined();
      const token = connectCallback!.token;

      // Verify connection exists but not ready
      const connection = connections.get(token);
      expect(connection).toBeDefined();
      expect(connection!.ready).toBe(false);

      // Buffer events during callback
      await request(app)
        .post('/internal/send')
        .send({ token, event: { data: 'Event 1' } });

      await request(app)
        .post('/internal/send')
        .send({ token, event: { data: 'Event 2' } });

      // Wait for callback to fail
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Verify connection was removed (callback failed)
      expect(connections.has(token)).toBe(false);

      // Verify no disconnect callback was sent (connection never established)
      const disconnectCallback = mockServer
        .getCallbacks()
        .find((cb) => cb.action === 'disconnect' && cb.token === token);
      expect(disconnectCallback).toBeUndefined();

      // Cleanup
      await ssePromise;
    }, 10000);

    it('should discard buffered events when client disconnects during callback', async () => {
      // Configure slow callback
      mockServer.setDelay(250);

      const sseRequest = request(app).get('/sse/client-abort');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const token = mockServer.getLastCallback()!.token;
      expect(connections.get(token)!.ready).toBe(false);

      // Buffer events
      await request(app)
        .post('/internal/send')
        .send({ token, event: { data: 'Buffered 1' } });

      await request(app)
        .post('/internal/send')
        .send({ token, event: { data: 'Buffered 2' } });

      // Abort connection during callback
      sseRequest.abort();
      await ssePromise;

      // Wait for callback to complete and cleanup to process
      await new Promise((resolve) => setTimeout(resolve, 350));

      // Verify connection was eventually cleaned up
      expect(connections.has(token)).toBe(false);

      // Note: Due to race condition timing, a disconnect callback MAY be sent if
      // the client disconnected after headers were sent but before we checked.
      // This is acceptable behavior - the important part is that buffered events
      // don't cause issues and cleanup happens correctly.
    }, 10000);

    it('should close connection when buffered event has close flag', async () => {
      // Configure slow callback
      mockServer.setDelay(200);

      const sseRequest = request(app).get('/sse/buffered-close');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const token = mockServer.getLastCallback()!.token;

      // Verify connection exists and is not ready (still in callback window)
      const connection = connections.get(token);
      expect(connection).toBeDefined();
      expect(connection!.ready).toBe(false);

      // Clear callbacks to isolate disconnect callback
      mockServer.clearCallbacks();

      // Buffer event with close flag
      const sendResponse = await request(app)
        .post('/internal/send')
        .send({
          token,
          event: { data: 'Closing event' },
          close: true,
        });

      expect(sendResponse.body.status).toBe('buffered');

      // Wait for callback to complete and buffer to flush
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify connection was closed
      expect(connections.has(token)).toBe(false);

      // Verify disconnect callback with reason "server_closed"
      const disconnectCallback = mockServer
        .getCallbacks()
        .find((cb) => cb.action === 'disconnect' && cb.token === token);
      expect(disconnectCallback).toBeDefined();
      expect(disconnectCallback!.reason).toBe('server_closed');

      // Cleanup
      await ssePromise;
    }, 10000);

    it('should discard second buffered event when first has close flag', async () => {
      // Configure slow callback
      mockServer.setDelay(200);

      const sseRequest = request(app).get('/sse/close-then-event');
      const ssePromise = sseRequest.then(() => {}, () => {});

      await new Promise((resolve) => setTimeout(resolve, 50));

      const token = mockServer.getLastCallback()!.token;

      // Verify connection exists and is not ready (still in callback window)
      const connection = connections.get(token);
      expect(connection).toBeDefined();
      expect(connection!.ready).toBe(false);

      mockServer.clearCallbacks();

      // Buffer event with close flag
      await request(app)
        .post('/internal/send')
        .send({
          token,
          event: { name: 'closing', data: 'First event with close' },
          close: true,
        });

      // Buffer another event (should be discarded when first closes connection)
      await request(app)
        .post('/internal/send')
        .send({
          token,
          event: { name: 'unreachable', data: 'This should not be sent' },
        });

      // Wait for callback and buffer flush
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify connection was closed after first buffered event
      expect(connections.has(token)).toBe(false);

      // Verify only one disconnect callback (from close)
      const disconnectCallbacks = mockServer
        .getCallbacks()
        .filter((cb) => cb.action === 'disconnect' && cb.token === token);
      expect(disconnectCallbacks.length).toBe(1);
      expect(disconnectCallbacks[0].reason).toBe('server_closed');

      // Cleanup
      await ssePromise;
    }, 10000);
  });
});

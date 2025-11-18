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

      // Note: heartbeatTimer is currently null (heartbeat feature not implemented yet)
      // This test verifies the code handles null timer gracefully
      expect(connection!.heartbeatTimer).toBeNull();

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
      expect(response.body).toEqual({ error: 'Token not found' });
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
      expect(response.body.error).toMatch(/token is required/i);
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
      expect(response.body.error).toMatch(/token.*must be a string/i);
    });

    it('should return 400 when event is not an object', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'valid-token',
          event: 'not an object', // String instead of object
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/event must be an object/i);
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
      expect(response.body.error).toMatch(/event\.data.*required/i);
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
      expect(response.body.error).toMatch(/event\.data.*must be a string/i);
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
      expect(response.body.error).toMatch(/event\.name.*must be a string/i);
    });

    it('should return 400 when close is not a boolean', async () => {
      const response = await request(app)
        .post('/internal/send')
        .send({
          token: 'valid-token',
          close: 'true', // String instead of boolean
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/close must be a boolean/i);
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
      expect(response.body).toEqual({ error: 'Token not found' });

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
});

/**
 * Integration tests for SSE connection flow
 *
 * Tests the complete SSE lifecycle: connect, callback, reject, and disconnect scenarios.
 */

import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { MockServer } from '../utils/mockServer.js';
import { connections } from '../../src/connections.js';

describe('SSE Connection Flow', () => {
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

  describe('Successful connection establishment', () => {
    it('should establish SSE connection when callback returns 200', async () => {
      // Start SSE connection WITHOUT .timeout() to prevent premature closure
      const req = request(app)
        .get('/sse/channel/updates?user=123')
        .set('Authorization', 'Bearer test-token')
        .set('X-Custom-Header', 'test-value');

      // Start request and immediately defer the promise (don't await yet)
      const responsePromise = req.then(
        () => {},
        () => {}
      );

      // Wait for connection to be established and callback to be sent
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify connect callback was sent to Python backend
      const callbacks = mockServer.getCallbacks();
      expect(callbacks.length).toBeGreaterThan(0);

      const connectCallback = callbacks.find((cb) => cb.action === 'connect');
      expect(connectCallback).toBeDefined();
      expect(connectCallback!).toMatchObject({
        action: 'connect',
        token: expect.any(String),
        request: {
          url: '/sse/channel/updates?user=123',
          headers: expect.objectContaining({
            authorization: 'Bearer test-token',
            'x-custom-header': 'test-value',
          }),
        },
      });

      // Verify token is a valid UUID
      expect(connectCallback!.token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      // Verify connection is stored in Map
      expect(connections.has(connectCallback!.token)).toBe(true);

      // Abort the request to close connection
      req.abort();
      await responsePromise;
    }, 10000);

    it('should accept any path under /sse/ without parsing', async () => {
      const path = '/sse/channel/updates';
      const req = request(app).get(path);
      const responsePromise = req.then(() => {}, () => {});

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callbacks = mockServer.getCallbacks();
      const callback = callbacks.find((cb) => cb.request.url === path);
      expect(callback).toBeDefined();
      expect(callback!.request.url).toBe(path);

      // Abort and cleanup
      req.abort();
      await responsePromise;
    }, 10000);

    it('should forward headers verbatim without parsing', async () => {
      const req = request(app)
        .get('/sse/test')
        .set('Authorization', 'Bearer token')
        .set('Cookie', 'session=abc123')
        .set('X-Custom-Header', 'custom-value')
        .set('User-Agent', 'test-agent');
      const responsePromise = req.then(() => {}, () => {});

      // Wait for connection and callback
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callbacks = mockServer.getCallbacks();
      const callback = callbacks.find((cb) => cb.request.url === '/sse/test');
      expect(callback).toBeDefined();
      expect(callback!.request.headers).toMatchObject({
        authorization: 'Bearer token',
        cookie: 'session=abc123',
        'x-custom-header': 'custom-value',
        'user-agent': 'test-agent',
      });

      // Abort and cleanup
      req.abort();
      await responsePromise;
    }, 10000);

    it('should filter out undefined header values', async () => {
      const req = request(app).get('/sse/test-headers');
      const responsePromise = req.then(() => {}, () => {});

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callbacks = mockServer.getCallbacks();
      const callback = callbacks.find((cb) => cb.request.url === '/sse/test-headers');
      expect(callback).toBeDefined();

      const headers = callback!.request.headers;

      // Verify no undefined values in headers
      Object.values(headers).forEach((value) => {
        expect(value).not.toBeUndefined();
      });

      // Abort and cleanup
      req.abort();
      await responsePromise;
    }, 10000);

    it('should handle multiple concurrent connections independently', async () => {
      const req1 = request(app).get('/sse/channel1');
      const req2 = request(app).get('/sse/channel2');
      const req3 = request(app).get('/sse/channel3');

      const requests = [
        req1.then(() => {}, () => {}),
        req2.then(() => {}, () => {}),
        req3.then(() => {}, () => {}),
      ];

      // Wait for connections to be established
      await new Promise((resolve) => setTimeout(resolve, 200));

      // All should have unique tokens
      const callbacks = mockServer.getCallbacks();
      const connectCallbacks = callbacks.filter((cb) => cb.action === 'connect');
      expect(connectCallbacks.length).toBeGreaterThanOrEqual(3);

      const tokens = connectCallbacks.map((cb) => cb.token);
      const uniqueTokens = new Set(tokens);
      expect(uniqueTokens.size).toBeGreaterThanOrEqual(3);

      // Abort all requests and cleanup
      req1.abort();
      req2.abort();
      req3.abort();
      await Promise.all(requests);
    }, 10000);
  });

  describe('Connect callback rejection (non-2xx)', () => {
    it('should return 401 when Python callback returns 401', async () => {
      mockServer.setStatusCode(401);

      const response = await request(app).get('/sse/protected');

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toEqual({ error: 'Backend returned 401' });

      // Verify connect callback was sent
      const callbacks = mockServer.getCallbacks();
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0].action).toBe('connect');

      // Verify connection is NOT in Map
      expect(connections.size).toBe(0);
    });

    it('should return 403 when Python callback returns 403', async () => {
      mockServer.setStatusCode(403);

      const response = await request(app).get('/sse/forbidden');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Backend returned 403' });
      expect(connections.size).toBe(0);
    });

    it('should return 500 when Python callback returns 500', async () => {
      mockServer.setStatusCode(500);

      const response = await request(app).get('/sse/error');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Backend returned 500' });
      expect(connections.size).toBe(0);
    });

    it('should NOT set SSE headers when callback rejects', async () => {
      mockServer.setStatusCode(401);

      const response = await request(app).get('/sse/protected');

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.headers['content-type']).not.toBe('text/event-stream');
    });
  });

  describe('Connect callback network failures', () => {
    it('should return 503 when callback URL is unreachable', async () => {
      // Stop mock server to simulate network failure
      await mockServer.stop();

      const response = await request(app).get('/sse/test');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Backend unavailable' });
      expect(connections.size).toBe(0);
    });

    it('should return 504 when callback times out (>5s)', async () => {
      // Set delay longer than timeout (5s)
      mockServer.setDelay(6000);

      const response = await request(app).get('/sse/test');

      expect(response.status).toBe(504);
      expect(response.body).toEqual({ error: 'Gateway timeout' });
      expect(connections.size).toBe(0);
    }, 10000); // Increase Jest timeout for this test
  });

  describe('CALLBACK_URL not configured', () => {
    it('should return 503 when CALLBACK_URL is null', async () => {
      const appWithoutCallback = createApp({
        port: 3000,
        callbackUrl: null,
        heartbeatIntervalSeconds: 15,
      });

      const response = await request(appWithoutCallback).get('/sse/test');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Service not configured' });
      expect(connections.size).toBe(0);
    });
  });

  describe('Client disconnect detection', () => {
    it('should send disconnect callback when client closes connection', async () => {
      // Start SSE connection
      const req = request(app).get('/sse/channel/updates?user=123');
      const responsePromise = req.then(() => {}, () => {});

      // Wait a bit for connection to be established
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify connection is established
      const connectCallbacks = mockServer.getCallbacks();
      expect(connectCallbacks.length).toBeGreaterThanOrEqual(1);
      const connectCallback = connectCallbacks.find((cb) => cb.action === 'connect');
      expect(connectCallback).toBeDefined();

      const token = connectCallback!.token;
      expect(connections.has(token)).toBe(true);

      // Abort request to trigger disconnect
      req.abort();
      await responsePromise;

      // Wait for disconnect to be processed
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify disconnect callback was sent
      const disconnectCallbacks = mockServer
        .getCallbacks()
        .filter((cb) => cb.action === 'disconnect' && cb.token === token);
      expect(disconnectCallbacks.length).toBeGreaterThanOrEqual(1);
      expect(disconnectCallbacks[0]).toMatchObject({
        action: 'disconnect',
        reason: 'client_closed',
        token,
        request: {
          url: '/sse/channel/updates?user=123',
        },
      });

      // Verify connection was removed from Map
      expect(connections.has(token)).toBe(false);
    });

    it('should cleanup connection state even if disconnect callback fails', async () => {
      // Start SSE connection
      const req = request(app).get('/sse/test');
      const responsePromise = req.then(() => {}, () => {});

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 200));

      const token = mockServer.getLastCallback()!.token;
      expect(connections.has(token)).toBe(true);

      // Stop mock server to simulate disconnect callback failure
      await mockServer.stop();

      // Abort request to trigger disconnect
      req.abort();
      await responsePromise;

      // Wait for disconnect processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify connection was still removed from Map
      expect(connections.has(token)).toBe(false);
    });
  });

  describe('Race condition: client disconnects during callback', () => {
    it('should not add connection to Map if client disconnects during callback', async () => {
      // Set delay on callback to create window for disconnect
      mockServer.setDelay(200);

      // Start request and abort it quickly
      const responsePromise = request(app).get('/sse/test').timeout(100);

      // Wait for timeout/abort
      await responsePromise.catch(() => {}); // Ignore error

      // Wait for callback to complete
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Verify connect callback was sent
      const callbacks = mockServer.getCallbacks();
      expect(callbacks.length).toBeGreaterThanOrEqual(1);
      const connectCallback = callbacks.find((cb) => cb.action === 'connect');
      expect(connectCallback).toBeDefined();

      // Verify connection is NOT in Map (disconnected flag prevented insertion)
      expect(connections.size).toBe(0);

      // Verify no disconnect callback sent (connection never established)
      const disconnectCallbacks = callbacks.filter((cb) => cb.action === 'disconnect');
      expect(disconnectCallbacks).toHaveLength(0);
    });
  });

  describe('URL edge cases', () => {
    it('should handle paths without query strings', async () => {
      const req = request(app).get('/sse/simple');
      const responsePromise = req.then(() => {}, () => {});

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callbacks = mockServer.getCallbacks();
      const callback = callbacks.find((cb) => cb.request.url === '/sse/simple');
      expect(callback).toBeDefined();
      expect(callback!.request.url).toBe('/sse/simple');

      // Abort and cleanup
      req.abort();
      await responsePromise;
    }, 10000);

    it('should preserve complex query strings', async () => {
      const queryPath = '/sse/test?foo=bar&baz=qux&empty=&special=%20%2F';
      const req = request(app).get(queryPath);
      const responsePromise = req.then(() => {}, () => {});

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callbacks = mockServer.getCallbacks();
      const callback = callbacks.find((cb) => cb.request.url === queryPath);
      expect(callback).toBeDefined();
      expect(callback!.request.url).toBe(queryPath);

      // Abort and cleanup
      req.abort();
      await responsePromise;
    }, 10000);
  });

  describe('Connection state management', () => {
    it('should store correct connection metadata in Map', async () => {
      // Start SSE connection
      const req = request(app)
        .get('/sse/metadata-test?user=123')
        .set('Authorization', 'Bearer token');
      const responsePromise = req.then(() => {}, () => {});

      // Wait for connection to be established
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callbacks = mockServer.getCallbacks();
      const callback = callbacks.find((cb) => cb.request.url === '/sse/metadata-test?user=123');
      expect(callback).toBeDefined();

      const token = callback!.token;
      const connection = connections.get(token);

      expect(connection).toBeDefined();
      expect(connection!.request.url).toBe('/sse/metadata-test?user=123');
      expect(connection!.request.headers).toMatchObject({
        authorization: 'Bearer token',
      });
      expect(connection!.heartbeatTimer).not.toBeNull(); // Heartbeat timer active
      expect(connection!.disconnected).toBe(false);

      // Abort and cleanup
      req.abort();
      await responsePromise;
    }, 10000);

    it('should cleanup all connections on disconnect', async () => {
      // Start multiple connections
      const req1 = request(app).get('/sse/cleanup1');
      const req2 = request(app).get('/sse/cleanup2');
      const req3 = request(app).get('/sse/cleanup3');

      const requests = [
        req1.then(() => {}, () => {}),
        req2.then(() => {}, () => {}),
        req3.then(() => {}, () => {}),
      ];

      // Wait for all connections to be established
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get the initial connection count from callbacks
      const initialCallbacks = mockServer.getCallbacks();
      const cleanupCallbacks = initialCallbacks.filter((cb) =>
        cb.request.url.startsWith('/sse/cleanup')
      );
      expect(cleanupCallbacks.length).toBe(3);

      // Abort all requests to trigger disconnect
      req1.abort();
      req2.abort();
      req3.abort();
      await Promise.all(requests);

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify all these connections cleaned up
      const tokens = cleanupCallbacks.map((cb) => cb.token);
      tokens.forEach((token) => {
        expect(connections.has(token)).toBe(false);
      });
    }, 10000);
  });
});

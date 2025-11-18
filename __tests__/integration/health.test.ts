/**
 * Integration tests for health check endpoints
 *
 * Tests both /healthz and /readyz endpoints under various configuration scenarios.
 */

import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';

describe('Health Endpoints', () => {
  describe('GET /healthz', () => {
    let app: Express;

    beforeEach(() => {
      const config: Config = {
        port: 3000,
        callbackUrl: null,
        heartbeatIntervalSeconds: 15,
      };
      app = createApp(config);
    });

    it('should return 200 OK with status', async () => {
      const response = await request(app).get('/healthz');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('should return JSON content type', async () => {
      const response = await request(app).get('/healthz');

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should not include Content-Encoding header (verifies no compression)', async () => {
      const response = await request(app).get('/healthz');

      expect(response.headers['content-encoding']).toBeUndefined();
    });

    it('should always return 200 regardless of configuration', async () => {
      // Test with different configs
      const configs: Config[] = [
        { port: 3000, callbackUrl: null, heartbeatIntervalSeconds: 15 },
        { port: 3000, callbackUrl: 'http://backend/callback', heartbeatIntervalSeconds: 30 },
        { port: 8080, callbackUrl: null, heartbeatIntervalSeconds: 1 },
      ];

      for (const config of configs) {
        const testApp = createApp(config);
        const response = await request(testApp).get('/healthz');
        expect(response.status).toBe(200);
      }
    });
  });

  describe('GET /readyz', () => {
    it('should return 200 when CALLBACK_URL is configured', async () => {
      const config: Config = {
        port: 3000,
        callbackUrl: 'http://backend/callback',
        heartbeatIntervalSeconds: 15,
      };
      const app = createApp(config);

      const response = await request(app).get('/readyz');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ready',
        configured: true,
      });
    });

    it('should return 503 when CALLBACK_URL is not configured (null)', async () => {
      const config: Config = {
        port: 3000,
        callbackUrl: null,
        heartbeatIntervalSeconds: 15,
      };
      const app = createApp(config);

      const response = await request(app).get('/readyz');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: 'not_ready',
        configured: false,
      });
    });

    // Note: No test for empty string callbackUrl because config.ts converts empty strings
    // to null using || operator, so empty strings can never reach the health endpoint

    it('should return JSON content type', async () => {
      const config: Config = {
        port: 3000,
        callbackUrl: 'http://backend/callback',
        heartbeatIntervalSeconds: 15,
      };
      const app = createApp(config);

      const response = await request(app).get('/readyz');

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });
});

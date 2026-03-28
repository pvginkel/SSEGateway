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
        rabbitmqUrl: null,
        rabbitmqQueueTtlMs: 300000,
        rabbitmqExchangePrefix: '',
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
        { port: 3000, callbackUrl: null, heartbeatIntervalSeconds: 15, rabbitmqUrl: null, rabbitmqQueueTtlMs: 300000, rabbitmqExchangePrefix: '' },
        { port: 3000, callbackUrl: 'http://backend/callback', heartbeatIntervalSeconds: 30, rabbitmqUrl: null, rabbitmqQueueTtlMs: 300000, rabbitmqExchangePrefix: '' },
        { port: 8080, callbackUrl: null, heartbeatIntervalSeconds: 1, rabbitmqUrl: null, rabbitmqQueueTtlMs: 300000, rabbitmqExchangePrefix: '' },
      ];

      for (const config of configs) {
        const testApp = createApp(config);
        const response = await request(testApp).get('/healthz');
        expect(response.status).toBe(200);
      }
    });
  });

  describe('GET /readyz', () => {
    it('should return 200 when CALLBACK_URL is configured and RabbitMQ is disabled', async () => {
      const config: Config = {
        port: 3000,
        callbackUrl: 'http://backend/callback',
        heartbeatIntervalSeconds: 15,
        rabbitmqUrl: null,
        rabbitmqQueueTtlMs: 300000,
        rabbitmqExchangePrefix: '',
      };
      const app = createApp(config);

      const response = await request(app).get('/readyz');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ready',
        configured: true,
        rabbitmq: 'disabled',
      });
    });

    it('should return 503 when CALLBACK_URL is not configured (null)', async () => {
      const config: Config = {
        port: 3000,
        callbackUrl: null,
        heartbeatIntervalSeconds: 15,
        rabbitmqUrl: null,
        rabbitmqQueueTtlMs: 300000,
        rabbitmqExchangePrefix: '',
      };
      const app = createApp(config);

      const response = await request(app).get('/readyz');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
      expect(response.body.configured).toBe(false);
      expect(response.body.reasons).toContain('CALLBACK_URL not configured');
    });

    it('should return 503 when RabbitMQ is configured but not connected', async () => {
      const config: Config = {
        port: 3000,
        callbackUrl: 'http://backend/callback',
        heartbeatIntervalSeconds: 15,
        rabbitmqUrl: 'amqp://localhost:5672',
        rabbitmqQueueTtlMs: 300000,
        rabbitmqExchangePrefix: '',
      };
      // Note: we create the app but do NOT call connectRabbitMQ, so isConnected() is false
      const app = createApp(config);

      const response = await request(app).get('/readyz');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
      expect(response.body.rabbitmq).toBe('disconnected');
      expect(response.body.reasons).toContain('RabbitMQ not connected');
    });

    // Note: No test for empty string callbackUrl because config.ts converts empty strings
    // to null using || operator, so empty strings can never reach the health endpoint

    it('should return JSON content type', async () => {
      const config: Config = {
        port: 3000,
        callbackUrl: 'http://backend/callback',
        heartbeatIntervalSeconds: 15,
        rabbitmqUrl: null,
        rabbitmqQueueTtlMs: 300000,
        rabbitmqExchangePrefix: '',
      };
      const app = createApp(config);

      const response = await request(app).get('/readyz');

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });
});

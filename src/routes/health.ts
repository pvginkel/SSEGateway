/**
 * Health check endpoints for SSEGateway
 *
 * Provides Kubernetes-compatible health and readiness probes.
 */

import express, { Request, Response } from 'express';
import type { Config } from '../config.js';
import { isConnected } from '../rabbitmq.js';

/**
 * Create health check router
 *
 * @param config - Application configuration
 * @returns Express router with health endpoints
 */
export function createHealthRouter(config: Config): express.Router {
  const router = express.Router();

  /**
   * GET /healthz - Liveness probe
   *
   * Returns 200 OK unless the server is in a fatal state.
   * This endpoint indicates whether the server process is alive.
   */
  router.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  /**
   * GET /readyz - Readiness probe
   *
   * Returns 200 OK when:
   * - CALLBACK_URL is configured
   * - Server initialization is complete
   *
   * Returns 503 Service Unavailable otherwise.
   * This endpoint indicates whether the server is ready to accept traffic.
   */
  router.get('/readyz', (_req: Request, res: Response) => {
    // Check if CALLBACK_URL is configured
    // Note: config.callbackUrl is null if CALLBACK_URL is missing or empty (handled in config.ts)
    const isConfigured = config.callbackUrl !== null;

    // RabbitMQ is a hard dependency when configured — not ready until connected
    const rabbitmqReady = !config.rabbitmqUrl || isConnected();

    if (isConfigured && rabbitmqReady) {
      res.status(200).json({
        status: 'ready',
        configured: true,
        rabbitmq: config.rabbitmqUrl ? 'connected' : 'disabled',
      });
    } else {
      const reasons: string[] = [];
      if (!isConfigured) reasons.push('CALLBACK_URL not configured');
      if (!rabbitmqReady) reasons.push('RabbitMQ not connected');

      res.status(503).json({
        status: 'not_ready',
        configured: isConfigured,
        rabbitmq: config.rabbitmqUrl ? (isConnected() ? 'connected' : 'disconnected') : 'disabled',
        reasons,
      });
    }
  });

  return router;
}

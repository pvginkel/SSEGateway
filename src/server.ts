/**
 * Express application setup for SSEGateway
 *
 * Creates and configures the Express application with health endpoints.
 * Does NOT include compression middleware (per CLAUDE.md requirements).
 */

import express, { Express } from 'express';
import type { Config } from './config.js';
import { createHealthRouter } from './routes/health.js';
import { createSseRouter } from './routes/sse.js';
import { createInternalRouter } from './routes/internal.js';

/**
 * Create and configure Express application
 *
 * @param config - Application configuration
 * @returns Configured Express application
 */
export function createApp(config: Config): Express {
  const app = express();

  // Parse JSON request bodies
  app.use(express.json());

  // Add CORS headers for development/testing (allows direct browser connections)
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Register health check routes
  const healthRouter = createHealthRouter(config);
  app.use(healthRouter);

  // Register SSE routes
  const sseRouter = createSseRouter(config);
  app.use(sseRouter);

  // Register internal routes (for Python backend communication)
  const internalRouter = createInternalRouter(config);
  app.use(internalRouter);

  // Note: Compression middleware is NOT registered per CLAUDE.md:
  // "No Compression: SSE output must never be compressed"

  return app;
}

/**
 * Express application setup for SSEGateway
 *
 * Creates and configures the Express application with health endpoints.
 * Does NOT include compression middleware (per CLAUDE.md requirements).
 */

import express, { Express } from 'express';
import type { Config } from './config.js';
import { createHealthRouter } from './routes/health.js';

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

  // Register health check routes
  const healthRouter = createHealthRouter(config);
  app.use(healthRouter);

  // Note: Compression middleware is NOT registered per CLAUDE.md:
  // "No Compression: SSE output must never be compressed"

  return app;
}

/**
 * Entry point for SSEGateway
 *
 * Initializes configuration, creates the Express application, starts the HTTP server,
 * and handles graceful shutdown on SIGTERM and SIGINT signals.
 */

import { createServer, Server } from 'http';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createApp } from './server.js';

/**
 * Start the SSEGateway server
 */
async function start(): Promise<void> {
  // Load configuration
  const config = loadConfig();

  // Log configuration summary (log presence only for security)
  const callbackUrlSummary = config.callbackUrl ? '<configured>' : '<not configured>';
  logger.info(
    `Configuration loaded: callbackUrl=${callbackUrlSummary} heartbeatInterval=${config.heartbeatIntervalSeconds}s port=${config.port}`
  );

  // Create Express application
  const app = createApp(config);

  // Create HTTP server
  const server: Server = createServer(app);

  // Set up graceful shutdown handlers
  setupGracefulShutdown(server);

  // Start listening
  server.listen(config.port, () => {
    logger.info(`Server listening on port ${config.port}`);
  });

  // Handle server errors
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Failed to start server: Port ${config.port} is already in use (EADDRINUSE)`);
    } else {
      logger.error(`Failed to start server: ${error.message}`);
    }
    process.exit(1);
  });
}

/**
 * Set up graceful shutdown handlers for SIGTERM and SIGINT
 *
 * @param server - HTTP server instance
 */
function setupGracefulShutdown(server: Server): void {
  const shutdown = (): void => {
    logger.info('Shutdown signal received, closing server gracefully...');

    // Force shutdown after 10 seconds if graceful shutdown doesn't complete
    const timeoutHandle = setTimeout(() => {
      logger.error('Graceful shutdown timeout, forcing exit');
      process.exit(1);
    }, 10000);

    server.close(() => {
      clearTimeout(timeoutHandle);
      logger.info('Server closed, exiting process');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Start the server
start().catch((error: Error) => {
  logger.error(`Unexpected error during startup: ${error.message}`);
  process.exit(1);
});

/**
 * Configuration loader for SSEGateway
 *
 * Loads and validates environment variables required for server operation.
 * Follows fail-fast principle: exits process if critical configuration is invalid.
 */

import { logger } from './logger.js';

export interface Config {
  port: number;
  callbackUrl: string | null;
  heartbeatIntervalSeconds: number;
}

/**
 * Load configuration from environment variables
 *
 * Environment variables:
 * - PORT: Server port (default: 3000, range: 1-65535)
 * - CALLBACK_URL: Python backend callback endpoint (optional, required for readiness)
 * - HEARTBEAT_INTERVAL_SECONDS: SSE heartbeat interval (default: 15, minimum: 1)
 */
export function loadConfig(): Config {
  // Parse PORT with validation
  const portEnv = process.env.PORT;
  let port = 3000; // default port

  if (portEnv) {
    const parsedPort = Number(portEnv);
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535 || !Number.isInteger(parsedPort)) {
      logger.error(`Invalid PORT value: "${portEnv}". Must be an integer between 1 and 65535.`);
      process.exit(1);
    }
    port = parsedPort;
  }

  // Parse CALLBACK_URL (optional, but required for readiness)
  const callbackUrl = process.env.CALLBACK_URL || null;

  // Parse HEARTBEAT_INTERVAL_SECONDS with validation and default
  const heartbeatEnv = process.env.HEARTBEAT_INTERVAL_SECONDS;
  let heartbeatIntervalSeconds = 15; // default

  if (heartbeatEnv) {
    const parsed = Number(heartbeatEnv);
    if (isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
      logger.error(`Invalid HEARTBEAT_INTERVAL_SECONDS value: "${heartbeatEnv}". Must be an integer >= 1. Using default: 15`);
      heartbeatIntervalSeconds = 15;
    } else {
      heartbeatIntervalSeconds = parsed;
    }
  }

  return {
    port,
    callbackUrl,
    heartbeatIntervalSeconds,
  };
}

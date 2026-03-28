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
  /** RabbitMQ AMQP URL — null disables the RabbitMQ transport */
  rabbitmqUrl: string | null;
  /** TTL in milliseconds for per-connection AMQP queues (x-expires argument) */
  rabbitmqQueueTtlMs: number;
  /** Prefix for the SSE events exchange name (environment isolation) */
  rabbitmqEnvPrefix: string;
}

/**
 * Load configuration from environment variables
 *
 * Environment variables:
 * - PORT: Server port (default: 3000, range: 1-65535)
 * - CALLBACK_URL: Python backend callback endpoint (optional, required for readiness)
 * - HEARTBEAT_INTERVAL_SECONDS: SSE heartbeat interval (default: 15, minimum: 1)
 * - RABBITMQ_URL: AMQP URL for RabbitMQ transport (optional — disables RabbitMQ if absent)
 * - RABBITMQ_QUEUE_TTL_MS: TTL for per-connection queues in ms (default: 300000)
 * - RABBITMQ_ENV_PREFIX: Prefix for exchange name for environment isolation (optional, default: none)
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

  // Parse RABBITMQ_URL (optional — null disables RabbitMQ transport)
  const rabbitmqUrl = process.env.RABBITMQ_URL || null;

  // Parse RABBITMQ_QUEUE_TTL_MS with validation and default (5 minutes)
  const queueTtlEnv = process.env.RABBITMQ_QUEUE_TTL_MS;
  let rabbitmqQueueTtlMs = 300000; // default: 5 minutes

  if (queueTtlEnv) {
    const parsed = Number(queueTtlEnv);
    if (isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
      logger.error(`Invalid RABBITMQ_QUEUE_TTL_MS value: "${queueTtlEnv}". Must be an integer >= 1. Using default: 300000`);
      rabbitmqQueueTtlMs = 300000;
    } else {
      rabbitmqQueueTtlMs = parsed;
    }
  }

  // Parse RABBITMQ_ENV_PREFIX (optional — empty string means no prefix)
  const rabbitmqEnvPrefix = process.env.RABBITMQ_ENV_PREFIX || '';

  return {
    port,
    callbackUrl,
    heartbeatIntervalSeconds,
    rabbitmqUrl,
    rabbitmqQueueTtlMs,
    rabbitmqEnvPrefix,
  };
}

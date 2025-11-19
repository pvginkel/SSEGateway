/**
 * Internal API routes for SSEGateway
 *
 * Provides endpoints for Python backend to send events and close connections.
 * These endpoints are internal-only - no authentication (relies on network-level access control).
 */

import express, { Request, Response } from 'express';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { getConnection, removeConnection } from '../connections.js';
import { sendDisconnectCallback } from '../callback.js';
import { formatSseEvent } from '../sse.js';

/**
 * Send request payload structure
 */
interface SendRequest {
  /** Connection token (required) */
  token: string;
  /** Optional event to send */
  event?: {
    /** Optional event type name */
    name?: string;
    /** Event data (required if event present) */
    data: string;
  };
  /** Optional close flag - if true, close connection after sending event */
  close?: boolean;
}

/**
 * Create internal routes router
 *
 * @param config - Application configuration
 * @returns Express router with internal endpoints
 */
export function createInternalRouter(config: Config): express.Router {
  const router = express.Router();

  /**
   * POST /internal/send - Send SSE event and/or close connection
   *
   * Request body:
   * {
   *   "token": "string",      // required - UUID of target connection
   *   "event": {              // optional - SSE event to send
   *     "name": "string",     // optional - event type name
   *     "data": "string"      // required if event present
   *   },
   *   "close": true           // optional - close connection after event
   * }
   *
   * Behavior:
   * - If both event and close: send event FIRST, then close
   * - Unknown token → 404
   * - Invalid types → 400
   * - Write failure → disconnect with reason "error"
   */
  router.post('/internal/send', async (req: Request, res: Response) => {
    // Validate request body structure
    const body = req.body as Partial<SendRequest>;

    // Token is required and must be a string
    if (!body.token || typeof body.token !== 'string') {
      logger.error('Invalid /internal/send request: missing or invalid token');
      res.status(400).json({ error: 'Invalid request: token is required and must be a string' });
      return;
    }

    const { token, event, close } = body;

    // If event is present, validate its structure
    if (event !== undefined) {
      if (typeof event !== 'object' || event === null) {
        logger.error(`Invalid /internal/send request: event must be an object: token=${token}`);
        res.status(400).json({ error: 'Invalid request: event must be an object' });
        return;
      }

      // event.data is required if event is present
      if (!('data' in event) || typeof event.data !== 'string') {
        logger.error(`Invalid /internal/send request: event.data is required and must be a string: token=${token}`);
        res.status(400).json({ error: 'Invalid request: event.data is required and must be a string' });
        return;
      }

      // event.name (if present) must be a string
      if ('name' in event && event.name !== undefined && typeof event.name !== 'string') {
        logger.error(`Invalid /internal/send request: event.name must be a string: token=${token}`);
        res.status(400).json({ error: 'Invalid request: event.name must be a string' });
        return;
      }
    }

    // If close is present, validate it's a boolean
    if (close !== undefined && typeof close !== 'boolean') {
      logger.error(`Invalid /internal/send request: close must be a boolean: token=${token}`);
      res.status(400).json({ error: 'Invalid request: close must be a boolean' });
      return;
    }

    // Look up connection in Map
    const connection = getConnection(token);

    if (!connection) {
      // Token not found - connection doesn't exist or already closed
      logger.info(`Send request for unknown token: token=${token}`);
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    // If event is present, send it to the SSE stream
    if (event) {
      try {
        // Format SSE event according to spec
        const formattedEvent = formatSseEvent(event.name, event.data);

        // Write to response stream
        const writeSuccess = connection.res.write(formattedEvent);

        // Flush immediately (required by SSE spec)
        // Note: Express Response doesn't have flush() method - flushHeaders() only works before first write
        // For SSE, we rely on write() to flush immediately for small chunks
        // The X-Accel-Buffering: no header (set during connection) ensures no buffering

        if (!writeSuccess) {
          // Write returned false - indicates backpressure, but stream is still open
          // For SSE, we continue anyway (client will catch up or disconnect)
          logger.info(`Write backpressure on token=${token}, continuing anyway`);
        }

        // Log event send
        const eventName = event.name || '(unnamed)';
        const dataLength = event.data.length;
        logger.info(
          `Sent SSE event: token=${token} event=${eventName} dataLength=${dataLength} url=${connection.request.url}`
        );
      } catch (error) {
        // Write failed - stream is closed or broken
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Write failed: token=${token} error=${errorMessage}`);

        // Cleanup connection state
        if (connection.heartbeatTimer) {
          clearInterval(connection.heartbeatTimer);
        }
        removeConnection(token);

        // Send disconnect callback with reason "error" (best-effort)
        await sendDisconnectCallback(
          config.callbackUrl!,
          token,
          'error',
          connection.request
        );

        // Return 500 to Python backend
        res.status(500).json({ error: 'Write failed: connection closed' });
        return;
      }
    }

    // If close flag is true, close the connection
    if (close) {
      await handleServerClose(config.callbackUrl!, token, connection);
    }

    // Return success response
    res.status(200).json({ status: 'ok' });
  });

  return router;
}

/**
 * Handle server-initiated close of SSE connection
 *
 * Performs cleanup and sends disconnect callback with reason "server_closed"
 *
 * @param callbackUrl - Python backend callback URL
 * @param token - Connection token
 * @param connection - Connection record
 */
async function handleServerClose(
  callbackUrl: string,
  token: string,
  connection: ReturnType<typeof getConnection>
): Promise<void> {
  // This should never happen (caller already checked), but defensive check
  if (!connection) {
    return;
  }

  // Clear heartbeat timer if set
  if (connection.heartbeatTimer) {
    clearInterval(connection.heartbeatTimer);
  }

  // Remove from Map
  removeConnection(token);

  // Log server close
  logger.info(`Server closed connection: token=${token} url=${connection.request.url}`);

  // Send disconnect callback with reason "server_closed" (best-effort)
  await sendDisconnectCallback(
    callbackUrl,
    token,
    'server_closed',
    connection.request
  );

  // End the response stream
  connection.res.end();
}

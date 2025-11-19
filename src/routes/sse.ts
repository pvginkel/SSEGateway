/**
 * SSE connection endpoint for SSEGateway
 *
 * Handles GET /* wildcard routes for Server-Sent Event connections.
 * Implements connection establishment, callback to Python backend, and disconnect detection.
 */

import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import {
  addConnection,
  removeConnection,
  hasConnection,
  getConnection,
  type ConnectionRecord,
} from '../connections.js';
import {
  sendConnectCallback,
  sendDisconnectCallback,
  type CallbackRequest,
} from '../callback.js';

/**
 * Create SSE router with wildcard route handler
 *
 * @param config - Application configuration
 * @returns Express router with SSE endpoint
 */
export function createSseRouter(config: Config): express.Router {
  const router = express.Router();

  /**
   * GET /* - SSE connection endpoint (accepts any path)
   *
   * 1. Validates CALLBACK_URL is configured
   * 2. Generates unique token using crypto.randomUUID()
   * 3. Extracts raw URL and headers from request
   * 4. Registers 'close' event listener BEFORE callback (race condition handling)
   * 5. Sends connect callback to Python backend with 5s timeout
   * 6. If callback succeeds (2xx): sets SSE headers and opens stream
   * 7. If callback fails (non-2xx/timeout/error): returns error status to client
   * 8. Handles client disconnect via 'close' event
   */
  router.get(/^\/.*/, async (req: Request, res: Response) => {
    // Check if CALLBACK_URL is configured
    if (!config.callbackUrl) {
      logger.error('SSE connection rejected: CALLBACK_URL not configured');
      res.status(503).json({ error: 'Service not configured' });
      return;
    }

    // Generate unique token
    const token = randomUUID();

    // Extract full raw URL (including query string)
    // Defensive: fallback to '/unknown' if req.url is undefined (edge case)
    const url = req.url || '/unknown';

    // Extract raw headers and filter out undefined values
    // This prevents JSON serialization issues in Python backend
    const headers: Record<string, string | string[]> = Object.fromEntries(
      Object.entries(req.headers).filter(
        (entry): entry is [string, string | string[]] => entry[1] !== undefined
      )
    );

    // Prepare request metadata for callback
    const callbackRequest: CallbackRequest = {
      url,
      headers,
    };

    // Log new connection attempt
    logger.info(`New SSE connection: token=${token} url=${url}`);

    // Create preliminary connection record (before callback)
    const connectionRecord: ConnectionRecord = {
      res,
      request: callbackRequest,
      heartbeatTimer: null, // Heartbeat implementation deferred
      disconnected: false, // Track early client disconnect
    };

    // Register 'close' event listener BEFORE sending callback
    // This handles race condition: client disconnects during callback
    res.on('close', () => {
      handleDisconnect(config.callbackUrl!, token, connectionRecord);
    });

    // Send connect callback to Python backend
    const callbackResult = await sendConnectCallback(
      config.callbackUrl,
      token,
      callbackRequest
    );

    // Handle callback result
    if (!callbackResult.success) {
      // Callback failed - determine appropriate HTTP status code
      let statusCode: number;
      let errorMessage: string;

      if (callbackResult.errorType === 'timeout') {
        // Callback timeout (>5s)
        statusCode = 504;
        errorMessage = 'Gateway timeout';
      } else if (callbackResult.errorType === 'http_error') {
        // Non-2xx response from Python - return same status
        statusCode = callbackResult.statusCode!;
        errorMessage = `Backend returned ${statusCode}`;
      } else {
        // Network error (ECONNREFUSED, DNS failure, etc.)
        statusCode = 503;
        errorMessage = 'Backend unavailable';
      }

      logger.error(
        `SSE connection rejected: token=${token} status=${statusCode} error=${callbackResult.error}`
      );

      // Mark as disconnected to prevent adding to Map if 'close' fires later
      connectionRecord.disconnected = true;

      // Return error to client WITHOUT setting SSE headers
      res.status(statusCode).json({ error: errorMessage });
      return;
    }

    // Callback succeeded (2xx) - check if client already disconnected during callback
    if (connectionRecord.disconnected) {
      // Client disconnected during callback - do not add to Map or open stream
      logger.info(
        `SSE connection closed early: token=${token} (client disconnected during callback)`
      );
      return;
    }

    // Set SSE response headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevent NGINX buffering

    // Send 200 status and flush headers (opens SSE stream)
    res.status(200);
    res.flushHeaders();

    // Add connection to Map (stream is now open)
    addConnection(token, connectionRecord);

    // Create heartbeat timer to keep connection alive
    const heartbeatIntervalMs = config.heartbeatIntervalSeconds * 1000;
    const heartbeatTimer = setInterval(() => {
      // Defensive check: ensure connection still exists in Map
      const connection = getConnection(token);
      if (!connection) {
        // Connection was removed - timer will be cleared by disconnect handler
        return;
      }

      // Send heartbeat comment (SSE format: `: heartbeat\n\n`)
      try {
        const writeSuccess = connection.res.write(': heartbeat\n\n');

        // Check for backpressure (client slow to consume)
        if (!writeSuccess) {
          // Backpressure detected - log but continue (best-effort heartbeat)
          logger.info(`Heartbeat backpressure: token=${token}`);
        }
        // Note: Do not log routine heartbeat sends to prevent log spam
      } catch (error) {
        // Write failed - connection likely closed or broken
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Heartbeat write failed: token=${token} error=${errorMessage}`);
        // Do not call disconnect handler here - let 'close' event handle cleanup
      }
    }, heartbeatIntervalMs);

    // Store timer in connection record
    connectionRecord.heartbeatTimer = heartbeatTimer;

    logger.info(
      `SSE connection established: token=${token} heartbeatInterval=${config.heartbeatIntervalSeconds}s`
    );
  });

  return router;
}

/**
 * Handle client disconnect
 *
 * Called when Express response 'close' event fires.
 * Implements cleanup and sends disconnect callback to Python backend.
 *
 * @param callbackUrl - Python backend callback URL
 * @param token - Connection token
 * @param connectionRecord - Connection record (may or may not be in Map)
 */
async function handleDisconnect(
  callbackUrl: string,
  token: string,
  connectionRecord: ConnectionRecord
): Promise<void> {
  // Check if connection exists in Map
  if (hasConnection(token)) {
    // Connection is in Map - perform full cleanup
    const record = getConnection(token)!;

    // Clear heartbeat timer if set
    if (record.heartbeatTimer) {
      clearInterval(record.heartbeatTimer);
    }

    // Remove from Map
    removeConnection(token);

    // Log disconnect
    logger.info(`Client disconnected: token=${token} url=${record.request.url}`);

    // Send disconnect callback to Python (best-effort)
    // Await to ensure callback completes before cleanup finishes
    // sendDisconnectCallback already catches and logs errors internally
    await sendDisconnectCallback(
      callbackUrl,
      token,
      'client_closed',
      record.request
    );
  } else {
    // Connection not in Map - client disconnected during callback
    // Set disconnected flag to prevent later Map insertion
    connectionRecord.disconnected = true;

    logger.info(
      `Client disconnected early: token=${token} url=${connectionRecord.request.url} (during callback)`
    );

    // No disconnect callback sent - connection was never established in Python
  }
}

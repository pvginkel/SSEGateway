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
import { handleEventAndClose } from './internal.js';
import { formatSseEvent } from '../sse.js';
import {
  respondWithError,
  SERVICE_NOT_CONFIGURED,
  BACKEND_ERROR,
  BACKEND_UNAVAILABLE,
  GATEWAY_TIMEOUT,
  RABBITMQ_UNAVAILABLE,
} from '../errors.js';
import {
  getChannel,
  isConnected,
  setupConnectionQueue,
  cancelConsumer,
  createMessageHandler,
  closeSseConnectionForAmqpFailure,
} from '../rabbitmq.js';

/**
 * Open the SSE response stream: sets the standard SSE response headers,
 * sends 200, and flushes headers so the stream is live for writes.
 */
function openSseResponseStream(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Prevent NGINX buffering
  res.status(200);
  res.flushHeaders();
}

/**
 * Standard HTTP reason phrases for the in-stream rejection statuses.
 * Used as a fallback when the callback's HTTP/1.1 status line carries no
 * reason phrase (e.g. HTTP/2, where the reason phrase is deprecated).
 */
function standardReasonPhrase(status: 400 | 401 | 403): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
  }
}

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
      respondWithError(res, 503, 'Service not configured', SERVICE_NOT_CONFIGURED);
      return;
    }

    // Reject new connections when RabbitMQ is configured but not connected
    if (config.rabbitmqUrl && !isConnected()) {
      logger.error('SSE connection rejected: RabbitMQ not connected');
      respondWithError(res, 503, 'RabbitMQ unavailable', RABBITMQ_UNAVAILABLE);
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
      ready: false, // Headers not sent yet
      eventBuffer: [], // Buffer for events during callback
    };

    // Register 'close' event listener BEFORE sending callback
    // This handles race condition: client disconnects during callback
    res.on('close', () => {
      handleDisconnect(config.callbackUrl!, token, connectionRecord);
    });

    // Add connection to Map BEFORE sending callback
    // This allows /internal/send requests during callback to succeed
    addConnection(token, connectionRecord);

    // Send connect callback to Python backend
    const callbackResult = await sendConnectCallback(
      config.callbackUrl,
      token,
      callbackRequest
    );

    // Handle callback result
    if (!callbackResult.success) {
      // Graceful in-stream rejection for 400/401/403: open the SSE stream with
      // a 200, emit a `rejected` control event carrying the status and reason
      // phrase, then close cleanly. Clients that handle the event surface a
      // toast; clients that don't see "stream opened, then closed" and fall
      // through to their normal reconnect path.
      if (
        callbackResult.errorType === 'http_error' &&
        (callbackResult.statusCode === 400 ||
          callbackResult.statusCode === 401 ||
          callbackResult.statusCode === 403)
      ) {
        const status = callbackResult.statusCode;
        const message =
          callbackResult.statusText && callbackResult.statusText.length > 0
            ? callbackResult.statusText
            : standardReasonPhrase(status);

        logger.info(
          `SSE connection rejected (in-stream): token=${token} status=${status} message=${message}`
        );

        // Mark disconnected and remove from map BEFORE writing so the
        // res.on('close') handler (fired by res.end below) sees no map entry
        // and skips the disconnect callback — the rejection itself is the
        // disconnect signal.
        connectionRecord.disconnected = true;
        removeConnection(token);

        openSseResponseStream(res);

        try {
          const payload = JSON.stringify({ status, message });
          res.write(formatSseEvent('rejected', payload));
        } catch {
          // Write failed — client already disconnected; fall through to end()
        }
        res.end();
        return;
      }

      // Other non-2xx outcomes (timeout, network error, 5xx, other 4xx) keep
      // the existing HTTP-error response path.
      let statusCode: number;
      let errorMessage: string;
      let errorCode: string;

      if (callbackResult.errorType === 'timeout') {
        statusCode = 504;
        errorMessage = 'Gateway timeout';
        errorCode = GATEWAY_TIMEOUT;
      } else if (callbackResult.errorType === 'http_error') {
        statusCode = callbackResult.statusCode!;
        errorMessage = `Backend returned ${statusCode}`;
        errorCode = BACKEND_ERROR;
      } else {
        statusCode = 503;
        errorMessage = 'Backend unavailable';
        errorCode = BACKEND_UNAVAILABLE;
      }

      logger.error(
        `SSE connection rejected: token=${token} status=${statusCode} error=${callbackResult.error}`
      );

      connectionRecord.disconnected = true;
      removeConnection(token);

      respondWithError(res, statusCode, errorMessage, errorCode);
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

    openSseResponseStream(res);

    // Mark connection as ready for writes
    connectionRecord.ready = true;

    // Flush any buffered events that arrived during callback
    for (const bufferedEvent of connectionRecord.eventBuffer) {
      try {
        await handleEventAndClose(
          connectionRecord,
          bufferedEvent.name ? { name: bufferedEvent.name, data: bufferedEvent.data } : { data: bufferedEvent.data },
          bufferedEvent.close,
          token,
          config.callbackUrl
        );
        if (bufferedEvent.close) {
          // Connection closed by buffered event
          return;
        }
      } catch (error) {
        // Write failed - connection already closed
        return;
      }
    }
    connectionRecord.eventBuffer = []; // Clear buffer after flushing

    // Set up AMQP consumer if the connect callback returned bindings AND the
    // gateway is configured for AMQP (rabbitmqUrl set). This happens AFTER the
    // buffer is fully flushed so event ordering is preserved.
    //
    // When AMQP is configured and bindings are present, the connection
    // requires AMQP delivery: a setup failure cannot fall through to
    // "HTTP-only mode" because that leaves the client believing the stream is
    // healthy while no events will ever arrive. Instead, close the SSE stream
    // cleanly and notify the backend so it cleans up per-token state. The
    // client's existing EventSource.onerror reconnect path then handles
    // recovery.
    //
    // When rabbitmqUrl is null the gateway operates in HTTP-only mode: any
    // bindings returned by the callback are ignored and events flow through
    // /internal/send only.
    if (
      callbackResult.bindings?.length &&
      callbackResult.requestId &&
      config.callbackUrl &&
      config.rabbitmqUrl
    ) {
      const queueName = `sse.conn.${callbackResult.requestId}`;
      let amqpFailureReason: string | undefined;

      try {
        if (!getChannel()) {
          amqpFailureReason = 'channel unavailable';
        } else {
          const messageHandler = createMessageHandler(config.callbackUrl);
          const consumerTag = await setupConnectionQueue(
            token,
            queueName,
            callbackResult.bindings,
            config,
            messageHandler
          );
          if (consumerTag) {
            connectionRecord.amqpQueueName = queueName;
            connectionRecord.amqpConsumerTag = consumerTag;
            connectionRecord.amqpBindings = callbackResult.bindings;
          } else {
            amqpFailureReason = 'consumer setup returned null';
          }
        }
      } catch (err) {
        amqpFailureReason = err instanceof Error ? err.message : String(err);
      }

      if (amqpFailureReason) {
        await closeSseConnectionForAmqpFailure(
          token,
          config.callbackUrl,
          `queue setup failed: ${amqpFailureReason}`
        );
        return;
      }
    }

    // Signal the client that the connection is fully ready.
    // With AMQP: sent after bindings are confirmed by the broker.
    // Without AMQP (HTTP-only mode) or AMQP setup failed: sent immediately.
    // Clients must wait for this event before treating the connection as established.
    try {
      const readyEvent = formatSseEvent('ready');
      res.write(readyEvent);
    } catch {
      // Write failed — client already disconnected
      return;
    }

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
    // Connection is in Map
    const record = getConnection(token)!;

    // Check if connection was ready (headers sent)
    if (record.ready) {
      // Connection was fully established - perform full cleanup and send disconnect callback

      // Clear heartbeat timer if set
      if (record.heartbeatTimer) {
        clearInterval(record.heartbeatTimer);
      }

      // Cancel AMQP consumer if one was started for this connection
      if (record.amqpConsumerTag) {
        await cancelConsumer(record.amqpConsumerTag);
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
      // Connection in Map but not ready - client disconnected during callback window
      // Set disconnected flag to prevent stream from opening
      record.disconnected = true;

      // Remove from Map
      removeConnection(token);

      logger.info(
        `Client disconnected early: token=${token} url=${record.request.url} (during callback)`
      );

      // No disconnect callback sent - connection was never fully established in Python
    }
  } else {
    // Connection not in Map - should not happen with buffering, but handle defensively
    // Set disconnected flag to prevent later Map insertion
    connectionRecord.disconnected = true;

    logger.info(
      `Client disconnected early: token=${token} url=${connectionRecord.request.url} (not in Map)`
    );

    // No disconnect callback sent - connection was never established in Python
  }
}

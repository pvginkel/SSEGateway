/**
 * RabbitMQ transport module for SSEGateway
 *
 * Manages a single AMQP connection and shared channel for delivering events
 * to SSE clients via a topic exchange. Implements exponential-backoff reconnect
 * and per-connection queue lifecycle (assert, bind, consume, cancel).
 *
 * Design decisions:
 * - Module-level singleton (matches `connections` Map pattern in connections.ts)
 * - Single connection + single channel; prefetch 10 for flow control
 * - Reconnect with exponential backoff capped at 30 s
 * - Reverse Map (consumerTag → token) for O(1) lookup in message handler
 * - Channel errors handled separately — amqplib does NOT propagate channel errors
 *   to the connection error handler
 */

import amqplib from 'amqplib';
import type { ChannelModel, Channel, ConsumeMessage } from 'amqplib';
import { logger } from './logger.js';
import type { Config } from './config.js';
import { getConnection, removeConnection, connections } from './connections.js';
import { sendDisconnectCallback } from './callback.js';
import { formatSseEvent } from './sse.js';

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

/** Active AMQP connection model (null when disconnected) */
let amqpConnection: ChannelModel | null = null;

/** Active AMQP channel (null when disconnected) */
let amqpChannel: Channel | null = null;

/** Whether the module is currently connected and ready to use */
let connected = false;

/** Prevents reconnect loop from starting after intentional shutdown */
let shutdownRequested = false;

/** Prevents double-fire of handleConnectionLoss (error + close both fire on connection loss) */
let reconnecting = false;

/** Current reconnect backoff delay in milliseconds (doubles on each retry, capped at 30 s) */
let reconnectDelayMs = 1000;

/** Handle for the pending reconnect timer (for cleanup on shutdown) */
let reconnectTimerHandle: ReturnType<typeof setTimeout> | null = null;

/** Reverse lookup: consumerTag → gateway token */
const consumerTagToToken = new Map<string, string>();


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to RabbitMQ and set up the shared channel and exchange.
 * Called once at startup if config.rabbitmqUrl is set.
 * Safe to call again on reconnect (clears previous state first).
 *
 * @param config - Application configuration
 */
export async function connectRabbitMQ(config: Config): Promise<void> {
  shutdownRequested = false;
  reconnecting = false;
  await doConnect(config);
}

/**
 * Shut down the RabbitMQ connection cleanly.
 * Cancels all consumers, closes the channel and connection.
 * Sets shutdownRequested to prevent reconnect loop.
 */
export async function shutdownRabbitMQ(): Promise<void> {
  shutdownRequested = true;
  connected = false;
  reconnecting = false;

  // Clear any pending reconnect timer
  if (reconnectTimerHandle) {
    clearTimeout(reconnectTimerHandle);
    reconnectTimerHandle = null;
  }
  reconnectDelayMs = 1000;

  // Cancel all active consumers via the reverse map before closing
  if (amqpChannel) {
    const tags = Array.from(consumerTagToToken.keys());
    for (const tag of tags) {
      try {
        await amqpChannel.cancel(tag);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`AMQP consumer cancel failed during shutdown: tag=${tag} error=${msg}`);
      }
    }
    consumerTagToToken.clear();

    try {
      await amqpChannel.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`AMQP channel close failed during shutdown: error=${msg}`);
    }
    amqpChannel = null;
  }

  if (amqpConnection) {
    try {
      await amqpConnection.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`AMQP connection close failed during shutdown: error=${msg}`);
    }
    amqpConnection = null;
  }

  logger.info('RabbitMQ connection closed');
}

/**
 * Returns the active AMQP channel, or null if not connected.
 * Callers must treat null as "AMQP unavailable, use HTTP-only mode".
 */
export function getChannel(): Channel | null {
  return connected ? amqpChannel : null;
}

/**
 * Returns true when the RabbitMQ connection is established and ready.
 */
export function isConnected(): boolean {
  return connected;
}

/**
 * Assert a queue, bind it to the exchange with the given routing keys,
 * and start consuming. Returns the consumer tag or null if the connection
 * was lost during setup or the connection disconnected before consume resolved.
 *
 * @param token - Gateway connection token (for reverse map and orphan guard)
 * @param queueName - Queue name derived from request_id
 * @param bindings - List of routing keys to bind
 * @param config - Application configuration (for queue TTL)
 * @param onMessage - Message handler callback
 * @returns Consumer tag on success, null on failure
 */
export async function setupConnectionQueue(
  token: string,
  queueName: string,
  bindings: string[],
  config: Config,
  onMessage: (msg: ConsumeMessage | null) => void
): Promise<string | null> {
  const ch = getChannel();
  if (!ch) {
    return null;
  }

  // Assert queue with TTL — idempotent, safe on reconnect
  await ch.assertQueue(queueName, {
    durable: false,
    exclusive: false,
    autoDelete: false,
    arguments: { 'x-expires': config.rabbitmqQueueTtlMs },
  });

  // Bind each routing key to the topic exchange
  for (const key of bindings) {
    await ch.bindQueue(queueName, 'sse.events', key);
  }

  // Wrap the message handler to auto-register the consumer tag on first delivery.
  // This is necessary because amqplib may deliver messages synchronously in the
  // same event loop tick as the ConsumeOk response, BEFORE our await continuation
  // runs and registers the tag in the reverse map.
  const wrappedHandler = (msg: ConsumeMessage | null) => {
    if (msg && !consumerTagToToken.has(msg.fields.consumerTag)) {
      consumerTagToToken.set(msg.fields.consumerTag, token);
    }
    onMessage(msg);
  };

  // Start consuming messages
  const consumeResult = await ch.consume(queueName, wrappedHandler);
  const consumerTag = consumeResult.consumerTag;

  // Orphaned-consumer guard: client may have disconnected while async ops were in-flight
  const connectionRecord = getConnection(token);
  if (!connectionRecord) {
    // Connection is gone — cancel consumer immediately to prevent nack-loop
    consumerTagToToken.delete(consumerTag);
    logger.warn(
      `AMQP orphaned consumer cancelled: token=${token} queue=${queueName} consumerTag=${consumerTag}`
    );
    try {
      await ch.cancel(consumerTag);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`AMQP orphan cancel failed: tag=${consumerTag} error=${msg}`);
    }
    return null;
  }

  // Ensure tag is registered (may already be set by wrappedHandler)
  consumerTagToToken.set(consumerTag, token);

  logger.info(
    `AMQP consumer started: token=${token} queue=${queueName} consumerTag=${consumerTag}`
  );

  return consumerTag;
}

/**
 * Cancel an active consumer and remove it from the reverse map.
 * Fire-and-forget: errors are logged and swallowed.
 *
 * @param consumerTag - Consumer tag to cancel
 */
export async function cancelConsumer(consumerTag: string): Promise<void> {
  // Remove from reverse map first (synchronous)
  consumerTagToToken.delete(consumerTag);

  const ch = amqpChannel;
  if (!ch) {
    return;
  }

  try {
    await ch.cancel(consumerTag);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`AMQP consumer cancel failed: tag=${consumerTag} error=${msg}`);
  }
}

/**
 * Look up the gateway token associated with a consumer tag.
 * Used by the message handler to find the target SSE connection.
 *
 * @param consumerTag - AMQP consumer tag
 * @returns Gateway token or undefined if not found
 */
export function getTokenForConsumerTag(consumerTag: string): string | undefined {
  return consumerTagToToken.get(consumerTag);
}

/**
 * Create a message handler closure bound to the given callbackUrl.
 * The handler: parses the AMQP message body, looks up the SSE connection,
 * writes the SSE event, and acks or nacks accordingly.
 *
 * @param callbackUrl - Python backend callback URL (for disconnect callbacks)
 * @returns amqplib message handler
 */
export function createMessageHandler(
  callbackUrl: string
): (msg: ConsumeMessage | null) => Promise<void> {
  return async (msg: ConsumeMessage | null): Promise<void> => {
    // Consumer cancelled by broker — nothing to do
    if (msg === null) {
      return;
    }

    const ch = amqpChannel;
    if (!ch) {
      // Channel gone during delivery — cannot ack/nack
      return;
    }

    // Parse message body
    let eventName: string | undefined;
    let eventData: string;

    try {
      const body = JSON.parse(msg.content.toString()) as { event?: string; data: string };
      eventName = body.event;
      eventData = body.data;

      if (typeof eventData !== 'string') {
        throw new Error('data field is not a string');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        `AMQP message parse error: queue=${msg.fields.routingKey} error=${errMsg}`
      );
      ch.nack(msg, false, false);
      return;
    }

    // Look up connection via reverse map
    const token = consumerTagToToken.get(msg.fields.consumerTag);
    if (!token) {
      // Race condition: consumer tag no longer mapped (disconnect race)
      // Discard (requeue=false) — requeuing would cause an infinite nack loop
      logger.warn(
        `AMQP message for unknown consumer tag: tag=${msg.fields.consumerTag}`
      );
      ch.nack(msg, false, false);
      return;
    }

    const connectionRecord = getConnection(token);
    if (!connectionRecord) {
      // Race condition: connection removed between tag lookup and record fetch
      // Discard (requeue=false) — requeuing would cause an infinite nack loop
      logger.warn(`AMQP message for disconnected token: token=${token}`);
      ch.nack(msg, false, false);
      return;
    }

    // Write SSE event to the client stream
    try {
      const formatted = formatSseEvent(eventName, eventData);
      connectionRecord.res.write(formatted);

      // Attempt explicit flush if available (compression-safe)
      if ('flush' in connectionRecord.res && typeof (connectionRecord.res as any).flush === 'function') {
        (connectionRecord.res as any).flush();
      }

      logger.info(
        `AMQP event sent: token=${token} event=${eventName ?? '(unnamed)'}`
      );
      ch.ack(msg);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`AMQP write failed: token=${token} error=${errMsg}`);

      // Cancel consumer before cleanup to prevent further deliveries
      consumerTagToToken.delete(msg.fields.consumerTag);
      try {
        await ch.cancel(msg.fields.consumerTag);
      } catch {
        // Best-effort — channel may already be gone
      }

      // Clean up connection state
      if (connectionRecord.heartbeatTimer) {
        clearInterval(connectionRecord.heartbeatTimer);
      }
      removeConnection(token);

      // Send disconnect callback (best-effort)
      await sendDisconnectCallback(callbackUrl, token, 'error', connectionRecord.request);

      // Nack with requeue so message is not lost if client reconnects
      try {
        ch.nack(msg, false, true);
      } catch {
        // Best-effort — channel may already be gone
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Internal connection management
// ---------------------------------------------------------------------------

/**
 * Perform the actual AMQP connect + channel + exchange setup.
 * Attaches error/close handlers for reconnect.
 */
async function doConnect(config: Config): Promise<void> {
  if (!config.rabbitmqUrl) {
    return;
  }

  reconnecting = false;

  try {
    logger.info('RabbitMQ connecting...');

    const conn = await amqplib.connect(config.rabbitmqUrl);
    amqpConnection = conn;

    // Attach connection-level error and close handlers BEFORE any other operations
    conn.on('error', (err: Error) => {
      logger.warn(`RabbitMQ connection error: ${err.message}`);
      handleConnectionLoss(config);
    });

    conn.on('close', () => {
      if (!shutdownRequested) {
        logger.warn('RabbitMQ connection closed unexpectedly, reconnecting...');
        handleConnectionLoss(config);
      }
    });

    // Create channel
    const ch = await conn.createChannel();
    amqpChannel = ch;

    // Attach channel error handler IMMEDIATELY after creation.
    // Channel errors (e.g., mismatched queue redeclare) close the channel
    // WITHOUT firing connection.on('error') — this handler is the only catch.
    ch.on('error', (err: Error) => {
      logger.error(`RabbitMQ channel error: ${err.message}`);
      handleConnectionLoss(config);
    });

    // Set prefetch for flow control
    await ch.prefetch(10);

    // Assert the topic exchange (idempotent — safe on reconnect)
    await ch.assertExchange('sse.events', 'topic', { durable: true });

    // Mark as connected
    connected = true;
    reconnectDelayMs = 1000; // reset backoff on success

    logger.info('RabbitMQ connected');

    // Re-establish consumers for all active connections that have a queue name
    // (happens on reconnect after connection loss)
    await reestablishConsumers(config);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`RabbitMQ connect failed: ${errMsg}`);
    connected = false;
    amqpChannel = null;
    amqpConnection = null;
    scheduleReconnect(config);
  }
}

/**
 * Handle a connection or channel loss event.
 * Sets connected=false and schedules a reconnect.
 */
function handleConnectionLoss(config: Config): void {
  if (shutdownRequested || reconnecting) {
    return;
  }
  reconnecting = true;

  connected = false;
  amqpChannel = null;
  amqpConnection = null;

  // All consumer tags are now stale — clear the reverse map and null out
  // stale tags on existing ConnectionRecords to prevent cancel of stale tags
  // during the reconnect window.
  consumerTagToToken.clear();
  for (const [, record] of connections) {
    if (record.amqpConsumerTag) {
      record.amqpConsumerTag = undefined;
    }
  }

  scheduleReconnect(config);
}

/**
 * Schedule a reconnect attempt with exponential backoff (max 30 s).
 */
function scheduleReconnect(config: Config): void {
  if (shutdownRequested) {
    return;
  }

  const delay = reconnectDelayMs;
  // Double the delay for next attempt, capped at 30 s
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);

  logger.info(`RabbitMQ reconnecting in ${delay}ms...`);
  reconnectTimerHandle = setTimeout(() => {
    reconnectTimerHandle = null;
    if (!shutdownRequested) {
      doConnect(config).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`RabbitMQ reconnect threw: ${errMsg}`);
      });
    }
  }, delay);
}

/**
 * Re-establish AMQP consumers for all active SSE connections after reconnect.
 * Iterates the connections Map and re-creates consumers for connections that
 * have amqpQueueName set (meaning they were consuming before the reconnect).
 */
async function reestablishConsumers(config: Config): Promise<void> {
  if (!config.callbackUrl) {
    return;
  }

  const messageHandler = createMessageHandler(config.callbackUrl);
  let reestablished = 0;

  for (const [token, record] of connections) {
    if (!record.amqpQueueName) {
      continue;
    }

    const ch = amqpChannel;
    if (!ch) {
      break; // Channel gone during iteration — stop
    }

    try {
      // Re-check channel is still alive before each iteration
      if (!amqpChannel || amqpChannel !== ch) {
        break;
      }

      // assertQueue is idempotent — safe to call again with same params
      await ch.assertQueue(record.amqpQueueName, {
        durable: false,
        exclusive: false,
        autoDelete: false,
        arguments: { 'x-expires': config.rabbitmqQueueTtlMs },
      });

      // Re-bind routing keys — necessary after full broker restart
      // (bindQueue is idempotent, safe in all cases)
      if (record.amqpBindings) {
        for (const key of record.amqpBindings) {
          await ch.bindQueue(record.amqpQueueName, 'sse.events', key);
        }
      }

      const consumeResult = await ch.consume(record.amqpQueueName, messageHandler);
      const newTag = consumeResult.consumerTag;

      // Update record and reverse map with new consumer tag
      record.amqpConsumerTag = newTag;
      consumerTagToToken.set(newTag, token);
      reestablished++;

      logger.info(
        `AMQP consumer re-established: token=${token} queue=${record.amqpQueueName} consumerTag=${newTag}`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `AMQP consumer re-establish failed: token=${token} queue=${record.amqpQueueName} error=${errMsg}`
      );
    }
  }

  if (reestablished > 0) {
    logger.info(`AMQP consumers re-established: count=${reestablished}`);
  }
}

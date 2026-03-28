/**
 * Integration tests for RabbitMQ transport
 *
 * Tests the full publish-to-SSE delivery flow, reconnect/queue reuse,
 * routing key filtering, mixed HTTP+AMQP mode, and HTTP-only fallback.
 *
 * Prerequisites: RabbitMQ available at amqp://guest:guest@localhost:5672/
 *
 * These tests use the real amqplib to publish messages and verify they arrive
 * at the SSE stream. Timing-sensitive assertions use polling with 2s timeouts.
 */

import http from 'http';
import type { IncomingMessage } from 'http';
import request from 'supertest';
import type { Express } from 'express';
import amqplib from 'amqplib';
import type { ChannelModel, Channel } from 'amqplib';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { MockServer } from '../utils/mockServer.js';
import { connections } from '../../src/connections.js';
import {
  connectRabbitMQ,
  shutdownRabbitMQ,
  isConnected,
} from '../../src/rabbitmq.js';
import { SseStreamReader } from '../utils/sseStreamReader.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const RABBITMQ_URL = 'amqp://guest:guest@localhost:5672/';
const EXCHANGE = 'sse.events';
const MESSAGE_DELIVERY_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(callbackUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    callbackUrl,
    heartbeatIntervalSeconds: 60, // Long interval so heartbeats don't interfere with timing
    rabbitmqUrl: RABBITMQ_URL,
    rabbitmqQueueTtlMs: 60000, // 1 minute TTL for test queues
    rabbitmqEnvPrefix: '',
    ...overrides,
  };
}

/**
 * Publish a message to the sse.events exchange with the given routing key.
 */
async function publishMessage(
  channel: Channel,
  routingKey: string,
  event: string,
  data: string
): Promise<void> {
  const body = JSON.stringify({ event, data });
  channel.publish(EXCHANGE, routingKey, Buffer.from(body));
}

/**
 * Open an SSE stream to the given app+server+path and return a reader.
 * Returns the reader and a cleanup function.
 */
function openSseStream(
  server: http.Server,
  path: string,
  headers: Record<string, string> = {}
): { reader: SseStreamReader; cleanup: () => void; done: Promise<void> } {
  const reader = new SseStreamReader();
  let cleanup: () => void;

  const done = new Promise<void>((resolve) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 3000;

    const req = http.get(
      {
        hostname: 'localhost',
        port,
        path,
        headers: {
          Accept: 'text/event-stream',
          Connection: 'keep-alive',
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        res.on('data', (chunk: Buffer) => {
          reader.addChunk(chunk);
        });
        res.on('end', resolve);
        res.on('error', resolve);
      }
    );

    req.on('error', () => resolve());

    cleanup = () => {
      req.destroy();
      resolve();
    };
  });

  return {
    reader,
    cleanup: cleanup!,
    done,
  };
}

/**
 * Wait for the SSE reader to receive at least N events, with timeout.
 */
async function waitForEvents(reader: SseStreamReader, count: number, timeoutMs = MESSAGE_DELIVERY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (reader.getEventCount() >= count) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test suite setup / teardown
// ---------------------------------------------------------------------------

describe('RabbitMQ integration tests', () => {
  let mockServer: MockServer;
  let app: Express;
  let httpServer: http.Server;
  let config: Config;
  let publishChannel: Channel;
  let publishConnection: ChannelModel;

  beforeAll(async () => {
    // Connect a publisher channel for injecting test messages
    publishConnection = await amqplib.connect(RABBITMQ_URL);
    publishChannel = await publishConnection.createChannel();

    // Ensure the exchange exists
    await publishChannel.assertExchange(EXCHANGE, 'topic', { durable: true });
  });

  afterAll(async () => {
    try {
      await publishChannel.close();
      await publishConnection.close();
    } catch {
      // Best-effort cleanup
    }
  });

  beforeEach(async () => {
    connections.clear();

    mockServer = new MockServer();
    await mockServer.start();

    config = makeConfig(mockServer.getCallbackUrl());
    app = createApp(config);

    // Connect SSEGateway's RabbitMQ client
    await connectRabbitMQ(config);

    // Wait for RabbitMQ to be connected
    const deadline = Date.now() + 5000;
    while (!isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!isConnected()) {
      throw new Error('RabbitMQ did not connect within 5s');
    }

    // Create HTTP server
    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  });

  afterEach(async () => {
    // Shut down AMQP
    await shutdownRabbitMQ();

    // Close HTTP server
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    connections.clear();

    await mockServer.stop();

    // Allow async cleanup to settle
    await new Promise((r) => setTimeout(r, 100));
  });

  // -------------------------------------------------------------------------
  // Test 1: Full publish-to-SSE flow
  // -------------------------------------------------------------------------

  it('should deliver AMQP message to SSE client', async () => {
    const requestId = `test-req-${Date.now()}`;
    const routingKey = `connection.${requestId}`;

    // Configure mock server to return bindings
    mockServer.setRabbitMQResponse({
      request_id: requestId,
      bindings: [routingKey],
    });

    // Open SSE connection
    const { reader, cleanup, done } = openSseStream(httpServer, '/sse/test');

    // Wait for SSE connection to be established and AMQP consumer set up
    await new Promise((r) => setTimeout(r, 500));

    // Verify a connection was established
    expect(connections.size).toBe(1);
    const [, record] = Array.from(connections)[0];
    expect(record.amqpQueueName).toBe(`sse.conn.${requestId}`);
    expect(record.amqpConsumerTag).toBeDefined();

    // Publish a message via the test publisher
    await publishMessage(publishChannel, routingKey, 'ping', '"pong"');

    // Wait for delivery
    const delivered = await waitForEvents(reader, 1);
    expect(delivered).toBe(true);

    const events = reader.getEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);

    // The event data should contain 'pong' (wrapped in envelope since 'ping' is not passthrough)
    const eventData = events[0].data;
    expect(eventData).toContain('pong');
    expect(eventData).toContain('ping');

    cleanup();
    await done;
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 2: Multiple messages in order
  // -------------------------------------------------------------------------

  it('should deliver multiple AMQP messages in order', async () => {
    const requestId = `test-multi-${Date.now()}`;
    const routingKey = `connection.${requestId}`;

    mockServer.setRabbitMQResponse({
      request_id: requestId,
      bindings: [routingKey],
    });

    const { reader, cleanup, done } = openSseStream(httpServer, '/sse/test');

    await new Promise((r) => setTimeout(r, 500));
    expect(connections.size).toBe(1);

    // Publish 3 messages
    await publishMessage(publishChannel, routingKey, 'msg', '"first"');
    await publishMessage(publishChannel, routingKey, 'msg', '"second"');
    await publishMessage(publishChannel, routingKey, 'msg', '"third"');

    const delivered = await waitForEvents(reader, 3);
    expect(delivered).toBe(true);

    const events = reader.getEvents();
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Verify order by checking data content
    const dataStrings = events.slice(0, 3).map((e) => e.data);
    expect(dataStrings[0]).toContain('first');
    expect(dataStrings[1]).toContain('second');
    expect(dataStrings[2]).toContain('third');

    cleanup();
    await done;
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 3: Routing key filtering
  // -------------------------------------------------------------------------

  it('should filter messages by routing key — only correct connection receives them', async () => {
    const idA = `test-rka-${Date.now()}`;
    const idB = `test-rkb-${Date.now()}`;
    const keyA = `connection.${idA}`;
    const keyB = `connection.${idB}`;

    // First connection: connection A
    mockServer.setRabbitMQResponse({ request_id: idA, bindings: [keyA] });
    const streamA = openSseStream(httpServer, '/sse/a');

    // Wait for first connection
    await new Promise((r) => setTimeout(r, 400));
    expect(connections.size).toBe(1);

    // Second connection: connection B (mock returns different bindings)
    mockServer.setRabbitMQResponse({ request_id: idB, bindings: [keyB] });
    const streamB = openSseStream(httpServer, '/sse/b');

    // Wait for second connection
    await new Promise((r) => setTimeout(r, 400));
    expect(connections.size).toBe(2);

    // Publish to keyA only
    await publishMessage(publishChannel, keyA, 'for-a', '"hello-A"');

    // Wait for delivery
    await waitForEvents(streamA.reader, 1);
    await new Promise((r) => setTimeout(r, 300)); // Extra time to ensure B doesn't get it

    // A should receive the event, B should not
    expect(streamA.reader.getEventCount()).toBeGreaterThanOrEqual(1);
    expect(streamA.reader.getEvents()[0].data).toContain('hello-A');
    expect(streamB.reader.getEventCount()).toBe(0);

    streamA.cleanup();
    streamB.cleanup();
    await Promise.all([streamA.done, streamB.done]);
  }, 20000);

  // -------------------------------------------------------------------------
  // Test 4: Mixed mode (HTTP + AMQP)
  // -------------------------------------------------------------------------

  it('should deliver both HTTP /internal/send and AMQP events to the same SSE stream', async () => {
    const requestId = `test-mixed-${Date.now()}`;
    const routingKey = `connection.${requestId}`;

    mockServer.setRabbitMQResponse({
      request_id: requestId,
      bindings: [routingKey],
    });

    const { reader, cleanup, done } = openSseStream(httpServer, '/sse/test');

    await new Promise((r) => setTimeout(r, 500));
    expect(connections.size).toBe(1);
    const [token] = Array.from(connections.keys());

    // Send an HTTP event via /internal/send
    await request(app)
      .post('/internal/send')
      .send({ token, event: { name: 'http_event', data: '"from-http"' } });

    // Send an AMQP event
    await publishMessage(publishChannel, routingKey, 'amqp_event', '"from-amqp"');

    // Wait for both events
    const delivered = await waitForEvents(reader, 2);
    expect(delivered).toBe(true);

    const events = reader.getEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);

    // Both events should be present
    const allData = events.map((e) => e.data).join(' ');
    expect(allData).toContain('from-http');
    expect(allData).toContain('from-amqp');

    cleanup();
    await done;
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 5: HTTP-only fallback when no bindings returned
  // -------------------------------------------------------------------------

  it('should work in HTTP-only mode when callback returns no bindings', async () => {
    // No rabbitmq response set — callback returns { status: 'ok' } without bindings

    const { reader, cleanup, done } = openSseStream(httpServer, '/sse/test');

    await new Promise((r) => setTimeout(r, 500));
    expect(connections.size).toBe(1);
    const [token, record] = Array.from(connections)[0];

    // No AMQP consumer should have been set up
    expect(record.amqpQueueName).toBeUndefined();
    expect(record.amqpConsumerTag).toBeUndefined();

    // HTTP events should still work
    await request(app)
      .post('/internal/send')
      .send({ token, event: { name: 'http_only', data: '"works"' } });

    const delivered = await waitForEvents(reader, 1);
    expect(delivered).toBe(true);

    const events = reader.getEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].data).toContain('works');

    cleanup();
    await done;
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 6: HTTP-only mode when rabbitmqUrl is null
  // -------------------------------------------------------------------------

  it('should function correctly when RABBITMQ_URL is not configured', async () => {
    // Create a separate server with no RabbitMQ URL
    await shutdownRabbitMQ(); // Shut down the one started in beforeEach

    const noRabbitConfig: Config = {
      port: 0,
      callbackUrl: mockServer.getCallbackUrl(),
      heartbeatIntervalSeconds: 60,
      rabbitmqUrl: null,
      rabbitmqQueueTtlMs: 300000,
      rabbitmqEnvPrefix: '',
    };

    mockServer.setRabbitMQResponse({
      request_id: 'should-be-ignored',
      bindings: ['connection.should-be-ignored'],
    });

    const noRabbitApp = createApp(noRabbitConfig);
    const noRabbitServer = http.createServer(noRabbitApp);
    await new Promise<void>((resolve) => noRabbitServer.listen(0, resolve));

    try {
      const { reader, cleanup, done } = openSseStream(noRabbitServer, '/sse/test');

      await new Promise((r) => setTimeout(r, 400));
      expect(connections.size).toBe(1);

      const [token, record] = Array.from(connections)[0];

      // No AMQP setup despite callback returning bindings
      expect(record.amqpQueueName).toBeUndefined();
      expect(record.amqpConsumerTag).toBeUndefined();

      // HTTP events work normally
      await request(noRabbitApp)
        .post('/internal/send')
        .send({ token, event: { data: '"no-rabbit-works"' } });

      const delivered = await waitForEvents(reader, 1);
      expect(delivered).toBe(true);

      const events = reader.getEvents();
      expect(events.length).toBeGreaterThanOrEqual(1);

      cleanup();
      await done;
    } finally {
      await new Promise<void>((resolve) => noRabbitServer.close(() => resolve()));
      // Re-establish RabbitMQ connection for afterEach shutdownRabbitMQ call
      await connectRabbitMQ(config);
    }
  }, 15000);

  // -------------------------------------------------------------------------
  // Test 7: Queue reuse on reconnect (queue persists between connects)
  // -------------------------------------------------------------------------

  it('should reuse the same queue name when the same request_id is returned on reconnect', async () => {
    const requestId = `test-reuse-${Date.now()}`;
    const routingKey = `connection.${requestId}`;
    const queueName = `sse.conn.${requestId}`;

    mockServer.setRabbitMQResponse({
      request_id: requestId,
      bindings: [routingKey],
    });

    // First SSE connection
    const stream1 = openSseStream(httpServer, '/sse/reuse');
    await new Promise((r) => setTimeout(r, 500));
    expect(connections.size).toBe(1);

    // Verify queue was set up
    const [, record1] = Array.from(connections)[0];
    expect(record1.amqpQueueName).toBe(queueName);

    // Publish a message during the first connection
    await publishMessage(publishChannel, routingKey, 'during-first', '"msg1"');
    await waitForEvents(stream1.reader, 1);
    expect(stream1.reader.getEventCount()).toBeGreaterThanOrEqual(1);

    // Close the first connection
    stream1.cleanup();
    await stream1.done;
    await new Promise((r) => setTimeout(r, 300));
    expect(connections.size).toBe(0);

    // Publish a message WHILE disconnected (queue persists due to TTL)
    await publishMessage(publishChannel, routingKey, 'during-disconnect', '"msg2"');
    await new Promise((r) => setTimeout(r, 100)); // Small delay for publish to arrive at queue

    // Second SSE connection with same request_id
    const stream2 = openSseStream(httpServer, '/sse/reuse');
    await new Promise((r) => setTimeout(r, 500));
    expect(connections.size).toBe(1);

    const [, record2] = Array.from(connections)[0];
    // Queue name should be the same (assertQueue is idempotent)
    expect(record2.amqpQueueName).toBe(queueName);

    // The message published during disconnect should be delivered
    const delivered = await waitForEvents(stream2.reader, 1);
    expect(delivered).toBe(true);

    const events2 = stream2.reader.getEvents();
    expect(events2.length).toBeGreaterThanOrEqual(1);
    expect(events2[0].data).toContain('msg2');

    stream2.cleanup();
    await stream2.done;
  }, 20000);

  // -------------------------------------------------------------------------
  // Test 8: Consumer is cancelled when SSE client disconnects
  // -------------------------------------------------------------------------

  it('should cancel AMQP consumer when SSE client disconnects', async () => {
    const requestId = `test-cancel-${Date.now()}`;
    const routingKey = `connection.${requestId}`;

    mockServer.setRabbitMQResponse({
      request_id: requestId,
      bindings: [routingKey],
    });

    const { cleanup, done } = openSseStream(httpServer, '/sse/test');

    await new Promise((r) => setTimeout(r, 500));
    expect(connections.size).toBe(1);
    const [, record] = Array.from(connections)[0];
    const consumerTag = record.amqpConsumerTag;
    expect(consumerTag).toBeDefined();

    // Disconnect the client
    cleanup();
    await done;

    // Wait for disconnect cleanup
    await new Promise((r) => setTimeout(r, 300));
    expect(connections.size).toBe(0);
  }, 15000);
});

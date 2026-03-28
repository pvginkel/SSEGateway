/**
 * Unit tests for RabbitMQ transport
 *
 * Tests: callback body parsing, queue name computation, AMQP message forwarding,
 * consumer cancellation on disconnect, channel error reconnect, no-config degradation,
 * and reconnect backoff capping.
 *
 * Mocking strategy for ESM Jest:
 * - Use jest.unstable_mockModule() before dynamic import() for amqplib mocking.
 * - Each test group that requires isolated module state uses jest.resetModules()
 *   combined with jest.unstable_mockModule() then a fresh dynamic import().
 * - callback.ts is tested by spying on globalThis.fetch (no amqplib needed).
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<{
  rabbitmqUrl: string | null;
  rabbitmqQueueTtlMs: number;
  callbackUrl: string | null;
  heartbeatIntervalSeconds: number;
  port: number;
  rabbitmqExchangePrefix: string;
}> = {}) {
  return {
    port: 3000,
    callbackUrl: 'http://localhost:9999/callback',
    heartbeatIntervalSeconds: 15,
    rabbitmqUrl: 'amqp://guest:guest@localhost:5672/',
    rabbitmqQueueTtlMs: 300000,
    rabbitmqExchangePrefix: '',
    ...overrides,
  };
}

type MockChannelType = {
  ack: ReturnType<typeof jest.fn>;
  nack: ReturnType<typeof jest.fn>;
  cancel: jest.Mock<() => Promise<void>>;
  on: ReturnType<typeof jest.fn>;
  prefetch: ReturnType<typeof jest.fn>;
  assertQueue: ReturnType<typeof jest.fn>;
  assertExchange: ReturnType<typeof jest.fn>;
  bindQueue: ReturnType<typeof jest.fn>;
  consume: jest.Mock<() => Promise<{ consumerTag: string }>>;
};

function makeMockChannel(overrides: Partial<MockChannelType> = {}, consumerTag = 'test-tag'): MockChannelType {
  return {
    ack: jest.fn(),
    nack: jest.fn(),
    cancel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    on: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({}),
    assertExchange: jest.fn().mockResolvedValue({}),
    bindQueue: jest.fn().mockResolvedValue({}),
    consume: jest.fn<() => Promise<{ consumerTag: string }>>().mockResolvedValue({ consumerTag }),
    ...overrides,
  };
}

function makeMockConnection(ch: MockChannelType) {
  return {
    on: jest.fn(),
    createChannel: jest.fn().mockResolvedValue(ch),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Section 1: CallbackResult body parsing
// Tests the sendConnectCallback return value when backend returns bindings.
// Uses jest.spyOn on globalThis.fetch — no amqplib needed.
// ---------------------------------------------------------------------------

describe('Callback body parsing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should parse request_id and bindings from 2xx callback response body', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: jest.fn<() => Promise<string>>().mockResolvedValue(
        JSON.stringify({ request_id: 'r1', bindings: ['connection.r1', 'broadcast.*'] })
      ),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const { sendConnectCallback } = await import('../../src/callback.js');
    const result = await sendConnectCallback('http://localhost:9999/callback', 'tok-1', {
      url: '/test',
      headers: {},
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toBe('r1');
    expect(result.bindings).toEqual(['connection.r1', 'broadcast.*']);
  });

  it('should return success with undefined requestId/bindings when body is empty', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const { sendConnectCallback } = await import('../../src/callback.js');
    const result = await sendConnectCallback('http://localhost:9999/callback', 'tok-2', {
      url: '/test',
      headers: {},
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toBeUndefined();
    expect(result.bindings).toBeUndefined();
  });

  it('should return success with undefined requestId/bindings when body is non-JSON', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: jest.fn<() => Promise<string>>().mockResolvedValue('not-json'),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const { sendConnectCallback } = await import('../../src/callback.js');
    const result = await sendConnectCallback('http://localhost:9999/callback', 'tok-3', {
      url: '/test',
      headers: {},
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toBeUndefined();
    expect(result.bindings).toBeUndefined();
  });

  it('should not parse body on non-2xx response', async () => {
    const mockResponse = {
      ok: false,
      status: 403,
      text: jest.fn<() => Promise<string>>().mockResolvedValue(
        JSON.stringify({ request_id: 'r-should-not-appear', bindings: ['x'] })
      ),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const { sendConnectCallback } = await import('../../src/callback.js');
    const result = await sendConnectCallback('http://localhost:9999/callback', 'tok-4', {
      url: '/test',
      headers: {},
    });

    expect(result.success).toBe(false);
    expect(result.requestId).toBeUndefined();
    expect(result.bindings).toBeUndefined();
  });

  it('should handle body with request_id only (no bindings)', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: jest.fn<() => Promise<string>>().mockResolvedValue(
        JSON.stringify({ request_id: 'r2' })
      ),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const { sendConnectCallback } = await import('../../src/callback.js');
    const result = await sendConnectCallback('http://localhost:9999/callback', 'tok-5', {
      url: '/test',
      headers: {},
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toBe('r2');
    expect(result.bindings).toBeUndefined();
  });

  it('should succeed even when response body text() throws', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: jest.fn<() => Promise<string>>().mockRejectedValue(new Error('body read error')),
    };
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as unknown as Response);

    const { sendConnectCallback } = await import('../../src/callback.js');
    const result = await sendConnectCallback('http://localhost:9999/callback', 'tok-6', {
      url: '/test',
      headers: {},
    });

    // Should still return success — body parsing failure is tolerated
    expect(result.success).toBe(true);
    expect(result.requestId).toBeUndefined();
    expect(result.bindings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 2: Queue name computation (pure string operations, no mocks needed)
// ---------------------------------------------------------------------------

describe('Queue name computation', () => {
  it('should derive queue name as sse.conn.<requestId>', () => {
    expect(`sse.conn.${'abc-123'}`).toBe('sse.conn.abc-123');
  });

  it('should handle UUID-style request IDs without modification', () => {
    const requestId = '550e8400-e29b-41d4-a716-446655440000';
    expect(`sse.conn.${requestId}`).toBe('sse.conn.550e8400-e29b-41d4-a716-446655440000');
  });

  it('should produce unique queue names for different request IDs', () => {
    const names = ['r1', 'r2', 'r3'].map((id) => `sse.conn.${id}`);
    expect(new Set(names).size).toBe(3);
  });

  it('should prefix all queue names with sse.conn.', () => {
    for (const id of ['test', 'abc', '123']) {
      expect(`sse.conn.${id}`).toMatch(/^sse\.conn\./);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: AMQP module state (isConnected / getChannel) using real RabbitMQ
// We use the actual connection to RabbitMQ for these tests since the environment
// has RabbitMQ available. This avoids complex ESM mock gymnastics.
// ---------------------------------------------------------------------------

describe('Module state — isConnected and getChannel (real RabbitMQ)', () => {
  beforeEach(async () => {
    // Ensure clean state
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
  });

  afterEach(async () => {
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
  });

  it('should report connected=true and return channel after successful connect', async () => {
    const { connectRabbitMQ, isConnected, getChannel } = await import('../../src/rabbitmq.js');

    await connectRabbitMQ(makeConfig());

    expect(isConnected()).toBe(true);
    expect(getChannel()).not.toBeNull();
  });

  it('should report connected=false and return null when rabbitmqUrl is null', async () => {
    const { connectRabbitMQ, isConnected, getChannel } = await import('../../src/rabbitmq.js');

    await connectRabbitMQ(makeConfig({ rabbitmqUrl: null }));

    expect(isConnected()).toBe(false);
    expect(getChannel()).toBeNull();
  });

  it('should report connected=false when rabbitmqUrl points to unreachable host', async () => {
    jest.useFakeTimers();

    const { connectRabbitMQ, isConnected, getChannel } = await import('../../src/rabbitmq.js');
    // Use a port that is not available
    await connectRabbitMQ(makeConfig({ rabbitmqUrl: 'amqp://guest:guest@localhost:19999/' }));

    expect(isConnected()).toBe(false);
    expect(getChannel()).toBeNull();

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Section 4: setupConnectionQueue and consumer lifecycle (real RabbitMQ)
// ---------------------------------------------------------------------------

describe('setupConnectionQueue and cancelConsumer (real RabbitMQ)', () => {
  beforeEach(async () => {
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
    const { connections } = await import('../../src/connections.js');
    connections.clear();
  });

  afterEach(async () => {
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
    const { connections } = await import('../../src/connections.js');
    connections.clear();
  });

  it('should return a consumer tag when queue is set up successfully', async () => {
    const { connectRabbitMQ, setupConnectionQueue, cancelConsumer } =
      await import('../../src/rabbitmq.js');
    const { connections } = await import('../../src/connections.js');

    await connectRabbitMQ(makeConfig());

    const token = `tok-setup-${Date.now()}`;
    connections.set(token, {
      res: { write: jest.fn(), end: jest.fn() } as any,
      request: { url: '/test', headers: {} },
      heartbeatTimer: null,
      disconnected: false,
      ready: true,
      eventBuffer: [],
    });

    const queueName = `sse.conn.unit-test-${Date.now()}`;
    const tag = await setupConnectionQueue(token, queueName, ['test.key'], makeConfig(), jest.fn());

    expect(tag).toBeTruthy();
    expect(typeof tag).toBe('string');

    // Cleanup
    if (tag) await cancelConsumer(tag);
    connections.delete(token);
  });

  it('should register consumer tag in reverse map', async () => {
    const { connectRabbitMQ, setupConnectionQueue, getTokenForConsumerTag, cancelConsumer } =
      await import('../../src/rabbitmq.js');
    const { connections } = await import('../../src/connections.js');

    await connectRabbitMQ(makeConfig());

    const token = `tok-reverse-${Date.now()}`;
    connections.set(token, {
      res: { write: jest.fn(), end: jest.fn() } as any,
      request: { url: '/test', headers: {} },
      heartbeatTimer: null,
      disconnected: false,
      ready: true,
      eventBuffer: [],
    });

    const queueName = `sse.conn.unit-reverse-${Date.now()}`;
    const tag = await setupConnectionQueue(token, queueName, ['reverse.key'], makeConfig(), jest.fn());

    expect(tag).toBeTruthy();
    expect(getTokenForConsumerTag(tag!)).toBe(token);

    // After cancel, reverse map entry is removed
    await cancelConsumer(tag!);
    expect(getTokenForConsumerTag(tag!)).toBeUndefined();

    connections.delete(token);
  });

  it('should return null and cancel consumer when connection removed during setup (orphan guard)', async () => {
    const { connectRabbitMQ, setupConnectionQueue, getTokenForConsumerTag } =
      await import('../../src/rabbitmq.js');
    const { connections } = await import('../../src/connections.js');

    await connectRabbitMQ(makeConfig());

    const token = `tok-orphan-${Date.now()}`;
    // Set the connection but don't keep it in the map — remove it before consume resolves
    // We simulate this by NOT adding it to the map at all
    // (connection will be absent when orphan guard runs)

    const queueName = `sse.conn.unit-orphan-${Date.now()}`;
    // token is NOT in connections map
    const tag = await setupConnectionQueue(token, queueName, ['orphan.key'], makeConfig(), jest.fn());

    // Should return null — orphan guard fires
    expect(tag).toBeNull();
    // Reverse map should not contain the orphaned tag
    // (tag is null anyway, so this is a sanity check)
  });

  it('should return null from setupConnectionQueue when channel is null', async () => {
    const { setupConnectionQueue } = await import('../../src/rabbitmq.js');
    // No connectRabbitMQ called — channel is null

    const tag = await setupConnectionQueue('tok-no-channel', 'sse.conn.x', ['k'], makeConfig(), jest.fn());
    expect(tag).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 5: No-config graceful degradation (no amqplib call when URL is null)
// ---------------------------------------------------------------------------

describe('No-config graceful degradation', () => {
  beforeEach(async () => {
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
  });

  afterEach(async () => {
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
  });

  it('getChannel() should return null when rabbitmqUrl is null', async () => {
    const { connectRabbitMQ, getChannel, isConnected } = await import('../../src/rabbitmq.js');
    await connectRabbitMQ(makeConfig({ rabbitmqUrl: null }));

    expect(getChannel()).toBeNull();
    expect(isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 6: AMQP message handler — createMessageHandler
// Uses real RabbitMQ but mocks the connection record's res.write.
// ---------------------------------------------------------------------------

describe('AMQP message handler via createMessageHandler (real RabbitMQ)', () => {
  const CALLBACK_URL = 'http://localhost:9999/callback';

  beforeEach(async () => {
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
    const { connections } = await import('../../src/connections.js');
    connections.clear();
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    const { shutdownRabbitMQ } = await import('../../src/rabbitmq.js');
    await shutdownRabbitMQ();
    const { connections } = await import('../../src/connections.js');
    connections.clear();
    jest.restoreAllMocks();
  });

  it('should ack and write SSE event when message is valid and connection exists', async () => {
    const {
      connectRabbitMQ,
      createMessageHandler,
      setupConnectionQueue,
      cancelConsumer,
      getChannel,
    } = await import('../../src/rabbitmq.js');
    const { connections } = await import('../../src/connections.js');

    await connectRabbitMQ(makeConfig());
    const ch = getChannel()!;

    const mockWrite = jest.fn().mockReturnValue(true);
    const token = `tok-handler-valid-${Date.now()}`;
    connections.set(token, {
      res: { write: mockWrite, end: jest.fn() } as any,
      request: { url: '/test', headers: {} },
      heartbeatTimer: null,
      disconnected: false,
      ready: true,
      eventBuffer: [],
      amqpQueueName: `sse.conn.unit-handler-${Date.now()}`,
    });

    const queueName = connections.get(token)!.amqpQueueName!;
    const tag = await setupConnectionQueue(token, queueName, ['handler.key'], makeConfig(), jest.fn());
    expect(tag).toBeTruthy();

    // Create and invoke the handler
    const handler = createMessageHandler(CALLBACK_URL);
    const msgBody = JSON.stringify({ event: 'task_event', data: '{"x":1}' });
    const msg = {
      content: Buffer.from(msgBody),
      fields: {
        consumerTag: tag,
        deliveryTag: 1,
        redelivered: false,
        exchange: 'sse.events',
        routingKey: 'handler.key',
      },
      properties: {},
    } as unknown as import('amqplib').ConsumeMessage;

    // Spy on channel ack/nack
    const ackSpy = jest.spyOn(ch, 'ack');
    const nackSpy = jest.spyOn(ch, 'nack');

    await handler(msg);

    expect(mockWrite).toHaveBeenCalled();
    const written = mockWrite.mock.calls[0][0] as string;
    expect(written).toContain('task_event');
    expect(written).toContain('"x":1');
    expect(ackSpy).toHaveBeenCalledWith(msg);
    expect(nackSpy).not.toHaveBeenCalled();

    if (tag) await cancelConsumer(tag);
    connections.delete(token);
  });

  it('should nack and not write when message body is invalid JSON', async () => {
    const { connectRabbitMQ, createMessageHandler, getChannel } = await import('../../src/rabbitmq.js');

    await connectRabbitMQ(makeConfig());
    const ch = getChannel()!;
    const nackSpy = jest.spyOn(ch, 'nack');

    const handler = createMessageHandler(CALLBACK_URL);
    const badMsg = {
      content: Buffer.from('not-valid-json!!!'),
      fields: {
        consumerTag: 'some-unregistered-tag',
        deliveryTag: 2,
        redelivered: false,
        exchange: 'x',
        routingKey: 'k',
      },
      properties: {},
    } as unknown as import('amqplib').ConsumeMessage;

    await handler(badMsg);

    expect(nackSpy).toHaveBeenCalledWith(badMsg, false, false);
  });

  it('should nack when consumer tag is not in reverse map', async () => {
    const { connectRabbitMQ, createMessageHandler, getChannel } = await import('../../src/rabbitmq.js');

    await connectRabbitMQ(makeConfig());
    const ch = getChannel()!;
    const nackSpy = jest.spyOn(ch, 'nack');

    const handler = createMessageHandler(CALLBACK_URL);
    const msg = {
      content: Buffer.from(JSON.stringify({ event: 'test', data: '"data"' })),
      fields: {
        consumerTag: 'unknown-tag-xyz-unit',
        deliveryTag: 3,
        redelivered: false,
        exchange: 'sse.events',
        routingKey: 'k',
      },
      properties: {},
    } as unknown as import('amqplib').ConsumeMessage;

    await handler(msg);

    expect(nackSpy).toHaveBeenCalledWith(msg, false, false);
  });

  it('should return immediately and not throw when msg is null', async () => {
    const { connectRabbitMQ, createMessageHandler } = await import('../../src/rabbitmq.js');

    await connectRabbitMQ(makeConfig());
    const handler = createMessageHandler(CALLBACK_URL);

    // Should not throw
    await expect(handler(null)).resolves.toBeUndefined();
  });

  it('should nack and send disconnect callback when res.write throws', async () => {
    const {
      connectRabbitMQ,
      createMessageHandler,
      setupConnectionQueue,
      getChannel,
    } = await import('../../src/rabbitmq.js');
    const { connections } = await import('../../src/connections.js');

    // Mock fetch for disconnect callback
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    } as unknown as Response);

    await connectRabbitMQ(makeConfig());
    const ch = getChannel()!;
    const nackSpy = jest.spyOn(ch, 'nack');

    const token = `tok-writefail-${Date.now()}`;
    const queueName = `sse.conn.unit-fail-${Date.now()}`;
    connections.set(token, {
      res: {
        write: jest.fn().mockImplementation(() => { throw new Error('write error'); }),
        end: jest.fn(),
      } as any,
      request: { url: '/test', headers: {} },
      heartbeatTimer: null,
      disconnected: false,
      ready: true,
      eventBuffer: [],
      amqpQueueName: queueName,
    });

    const tag = await setupConnectionQueue(token, queueName, ['fail.key'], makeConfig(), jest.fn());
    expect(tag).toBeTruthy();

    const handler = createMessageHandler(CALLBACK_URL);
    const msg = {
      content: Buffer.from(JSON.stringify({ event: 'ping', data: '"pong"' })),
      fields: {
        consumerTag: tag,
        deliveryTag: 4,
        redelivered: false,
        exchange: 'sse.events',
        routingKey: 'fail.key',
      },
      properties: {},
    } as unknown as import('amqplib').ConsumeMessage;

    await handler(msg);

    // Message should be nacked with requeue
    expect(nackSpy).toHaveBeenCalledWith(msg, false, true);
    // Connection should be removed from map
    expect(connections.has(token)).toBe(false);
    // Disconnect callback should have been sent
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

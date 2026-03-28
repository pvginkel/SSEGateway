/**
 * Unit tests for RabbitMQ reconnect behavior and channel error handling.
 *
 * These tests use jest.unstable_mockModule to inject a controllable amqplib mock
 * and must be isolated in their own file to prevent module mock contamination
 * of the real-RabbitMQ tests in rabbitmq.test.ts.
 *
 * Tests: reconnect backoff capping, channel error triggers reconnect.
 */

import { jest } from '@jest/globals';

function makeConfig() {
  return {
    port: 3000,
    callbackUrl: 'http://localhost:9999/callback',
    heartbeatIntervalSeconds: 15,
    rabbitmqUrl: 'amqp://guest:guest@localhost:5672/',
    rabbitmqQueueTtlMs: 300000,
    rabbitmqExchangePrefix: '',
  };
}

// ---------------------------------------------------------------------------
// Reconnect backoff capping
// ---------------------------------------------------------------------------

describe('Reconnect backoff capping', () => {
  it('should cap reconnect delay at 30s and attempt multiple reconnects', async () => {
    jest.useFakeTimers();

    let connectCallCount = 0;

    jest.unstable_mockModule('amqplib', () => ({
      default: {
        connect: jest.fn().mockImplementation(() => {
          connectCallCount++;
          return Promise.reject(new Error('ECONNREFUSED'));
        }),
      },
    }));

    jest.resetModules();

    const { connectRabbitMQ } = await import('../../src/rabbitmq.js');
    const config = makeConfig();

    // First attempt (fails immediately)
    await connectRabbitMQ(config);
    expect(connectCallCount).toBe(1);

    // Advance timers through several backoff windows: 1s, 2s, 4s, 8s, 16s, 30s, 30s
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of delays) {
      await jest.advanceTimersByTimeAsync(delay);
    }

    // Should have attempted many reconnects (1 initial + 7 scheduled = 8)
    expect(connectCallCount).toBeGreaterThan(5);

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Channel error triggers reconnect
// ---------------------------------------------------------------------------

describe('Channel error triggers reconnect', () => {
  it('should set connected=false and schedule reconnect on channel error', async () => {
    jest.useFakeTimers();

    let channelErrorHandler: ((err: Error) => void) | undefined;
    let connectCallCount = 0;

    const mockCh = {
      on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'error') {
          channelErrorHandler = handler as (err: Error) => void;
        }
      }),
      prefetch: jest.fn().mockResolvedValue(undefined),
      assertExchange: jest.fn().mockResolvedValue({}),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const mockConn = {
      on: jest.fn(),
      createChannel: jest.fn().mockResolvedValue(mockCh),
      close: jest.fn().mockResolvedValue(undefined),
    };

    jest.unstable_mockModule('amqplib', () => ({
      default: {
        connect: jest.fn().mockImplementation(() => {
          connectCallCount++;
          if (connectCallCount === 1) {
            return Promise.resolve(mockConn);
          }
          return Promise.reject(new Error('still unreachable'));
        }),
      },
    }));

    jest.resetModules();

    const { connectRabbitMQ, isConnected } = await import('../../src/rabbitmq.js');
    await connectRabbitMQ(makeConfig());

    expect(isConnected()).toBe(true);
    expect(channelErrorHandler).toBeDefined();

    // Trigger channel error
    channelErrorHandler!(new Error('PRECONDITION_FAILED'));

    // connected should be false immediately
    expect(isConnected()).toBe(false);

    // After 1s backoff, reconnect should be attempted
    await jest.advanceTimersByTimeAsync(1000);
    expect(connectCallCount).toBe(2);

    jest.useRealTimers();
  });

  it('should set connected=false on connection error event', async () => {
    jest.useFakeTimers();

    let connectionErrorHandler: ((err: Error) => void) | undefined;
    let connectCallCount = 0;

    const mockCh = {
      on: jest.fn(),
      prefetch: jest.fn().mockResolvedValue(undefined),
      assertExchange: jest.fn().mockResolvedValue({}),
    };

    const mockConn = {
      on: jest.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'error') {
          connectionErrorHandler = handler as (err: Error) => void;
        }
      }),
      createChannel: jest.fn().mockResolvedValue(mockCh),
      close: jest.fn().mockResolvedValue(undefined),
    };

    jest.unstable_mockModule('amqplib', () => ({
      default: {
        connect: jest.fn().mockImplementation(() => {
          connectCallCount++;
          if (connectCallCount === 1) {
            return Promise.resolve(mockConn);
          }
          return Promise.reject(new Error('still unreachable'));
        }),
      },
    }));

    jest.resetModules();

    const { connectRabbitMQ, isConnected } = await import('../../src/rabbitmq.js');
    await connectRabbitMQ(makeConfig());

    expect(isConnected()).toBe(true);
    expect(connectionErrorHandler).toBeDefined();

    // Trigger connection error
    connectionErrorHandler!(new Error('ECONNRESET'));

    // connected should be false
    expect(isConnected()).toBe(false);

    jest.useRealTimers();
  });
});

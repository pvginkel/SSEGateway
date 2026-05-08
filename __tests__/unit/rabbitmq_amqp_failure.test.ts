/**
 * Unit tests for AMQP fail-loud behavior.
 *
 * The DA-side reconnect contract assumes that whenever an AMQP-side problem
 * leaves a connection unable to receive messages, the SSE stream is closed
 * by the gateway so the client's EventSource.onerror reconnect path handles
 * recovery. These tests cover the three failure paths the gateway is aware
 * of:
 *
 * 1. Initial AMQP queue setup throws on connect (route-level).
 * 2. Broker cancels the consumer (`msg === null` delivered by amqplib).
 * 3. reestablishConsumers per-connection failure during reconnect.
 *
 * amqplib is mocked at the file level via jest.unstable_mockModule so we can
 * force specific failures without depending on a real broker.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import type { Express } from 'express';
import { MockServer } from '../utils/mockServer.js';
import { parseSseStream } from '../utils/sseParser.js';

// ---------------------------------------------------------------------------
// Shared amqplib mock — each test resets and reconfigures behavior in beforeEach.
// ---------------------------------------------------------------------------

type MockChannel = {
  ack: jest.Mock;
  nack: jest.Mock;
  cancel: jest.Mock;
  on: jest.Mock;
  prefetch: jest.Mock;
  assertQueue: jest.Mock;
  assertExchange: jest.Mock;
  bindQueue: jest.Mock;
  consume: jest.Mock;
  close: jest.Mock;
};

type MockConn = {
  on: jest.Mock;
  createChannel: jest.Mock;
  close: jest.Mock;
};

let mockChannel: MockChannel;
let mockConn: MockConn;
let amqplibConnect: jest.Mock;

function makeMockChannel(): MockChannel {
  return {
    ack: jest.fn(),
    nack: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({}),
    assertExchange: jest.fn().mockResolvedValue({}),
    bindQueue: jest.fn().mockResolvedValue({}),
    consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-default' }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockConn(ch: MockChannel): MockConn {
  return {
    on: jest.fn(),
    createChannel: jest.fn().mockResolvedValue(ch),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

jest.unstable_mockModule('amqplib', () => ({
  default: {
    connect: (...args: unknown[]) => amqplibConnect(...args),
  },
}));

function makeConfig(callbackUrl: string) {
  return {
    port: 0,
    callbackUrl,
    heartbeatIntervalSeconds: 60,
    rabbitmqUrl: 'amqp://mocked',
    rabbitmqQueueTtlMs: 60000,
    rabbitmqEnvPrefix: '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AMQP failure paths fail loud (close SSE stream)', () => {
  let mockServer: MockServer;
  let app: Express;
  let connections: Map<string, unknown>;
  let connectRabbitMQ: typeof import('../../src/rabbitmq.js').connectRabbitMQ;
  let shutdownRabbitMQ: typeof import('../../src/rabbitmq.js').shutdownRabbitMQ;
  let setupConnectionQueue: typeof import('../../src/rabbitmq.js').setupConnectionQueue;

  beforeEach(async () => {
    mockChannel = makeMockChannel();
    mockConn = makeMockConn(mockChannel);
    amqplibConnect = jest.fn().mockResolvedValue(mockConn);

    jest.resetModules();

    const rabbit = await import('../../src/rabbitmq.js');
    connectRabbitMQ = rabbit.connectRabbitMQ;
    shutdownRabbitMQ = rabbit.shutdownRabbitMQ;
    setupConnectionQueue = rabbit.setupConnectionQueue;

    const conns = await import('../../src/connections.js');
    connections = conns.connections as unknown as Map<string, unknown>;
    connections.clear();

    mockServer = new MockServer();
    await mockServer.start();

    const { createApp } = await import('../../src/server.js');
    const config = makeConfig(mockServer.getCallbackUrl());
    app = createApp(config);

    await connectRabbitMQ(config);
  });

  afterEach(async () => {
    await shutdownRabbitMQ();
    await mockServer.stop();
    connections.clear();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Path 1: initial AMQP setup throws — route closes the stream
  // -------------------------------------------------------------------------

  it('closes SSE stream + sends disconnect callback when assertQueue throws on connect', async () => {
    mockChannel.assertQueue.mockRejectedValueOnce(new Error('forced assertQueue failure'));
    mockServer.setRabbitMQResponse({
      request_id: 'req-setup-fail',
      bindings: ['setup-fail.key'],
    });

    const response = await request(app).get('/sse/setup-fail');

    // Headers were flushed before AMQP setup, so HTTP status is 200
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // No `ready` event was sent — stream closed before the gateway signalled ready
    const events = parseSseStream(response.text);
    expect(events.find((e) => e.event === 'ready')).toBeUndefined();

    // Connection record is cleaned up
    expect(connections.size).toBe(0);

    // Backend got connect + disconnect('error') so it can release per-token state
    const callbacks = mockServer.getCallbacks();
    expect(callbacks).toHaveLength(2);
    expect(callbacks[0].action).toBe('connect');
    expect(callbacks[1].action).toBe('disconnect');
    expect(callbacks[1].reason).toBe('error');
  });

  it('closes SSE stream + sends disconnect callback when bindQueue throws on connect', async () => {
    mockChannel.bindQueue.mockRejectedValueOnce(new Error('forced bindQueue failure'));
    mockServer.setRabbitMQResponse({
      request_id: 'req-bind-fail',
      bindings: ['bind-fail.key'],
    });

    const response = await request(app).get('/sse/bind-fail');

    expect(response.status).toBe(200);
    const events = parseSseStream(response.text);
    expect(events.find((e) => e.event === 'ready')).toBeUndefined();
    expect(connections.size).toBe(0);

    const callbacks = mockServer.getCallbacks();
    expect(callbacks).toHaveLength(2);
    expect(callbacks[1].action).toBe('disconnect');
    expect(callbacks[1].reason).toBe('error');
  });

  // -------------------------------------------------------------------------
  // Path 2: broker cancels the consumer (msg === null) — stream closed
  // -------------------------------------------------------------------------

  it('closes SSE stream + sends disconnect callback when broker cancels the consumer', async () => {
    let capturedHandler: ((msg: unknown) => Promise<void> | void) | undefined;
    mockChannel.consume.mockImplementationOnce((_queueName: string, handler: (msg: unknown) => Promise<void> | void) => {
      capturedHandler = handler;
      return Promise.resolve({ consumerTag: 'tag-cancel' });
    });

    // Spy fetch so we can verify the disconnect callback body
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
      } as unknown as Response);

    // Seed the connections map with a fake live SSE connection
    const token = `tok-cancel-${Date.now()}`;
    const resEnd = jest.fn();
    const resWrite = jest.fn();
    const conns = await import('../../src/connections.js');
    conns.connections.set(token, {
      res: { write: resWrite, end: resEnd } as never,
      request: { url: '/sse/cancel-test', headers: {} },
      heartbeatTimer: null,
      disconnected: false,
      ready: true,
      eventBuffer: [],
    });

    const tag = await setupConnectionQueue(
      token,
      'sse.conn.cancel-test',
      ['cancel.k'],
      makeConfig(mockServer.getCallbackUrl()),
      jest.fn()
    );
    expect(tag).toBeTruthy();
    expect(capturedHandler).toBeDefined();

    // Broker-side consumer cancel
    await capturedHandler!(null);

    expect(conns.connections.has(token)).toBe(false);
    expect(resEnd).toHaveBeenCalled();

    // Disconnect callback with reason 'error'
    const disconnectCall = fetchSpy.mock.calls.find((call) => {
      try {
        const body = JSON.parse((call[1] as { body: string }).body) as {
          action?: string;
        };
        return body.action === 'disconnect';
      } catch {
        return false;
      }
    });
    expect(disconnectCall).toBeDefined();
    const disconnectBody = JSON.parse(
      (disconnectCall![1] as { body: string }).body
    ) as { action: string; reason: string; token: string };
    expect(disconnectBody.reason).toBe('error');
    expect(disconnectBody.token).toBe(token);
  });

  // -------------------------------------------------------------------------
  // Path 3: reestablishConsumers per-connection throw — that stream closed
  // -------------------------------------------------------------------------

  it('closes the affected SSE stream when reestablishConsumers throws for a connection', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
      } as unknown as Response);

    // Seed the connections map with a connection that was previously consuming
    // (amqpQueueName + amqpBindings set). reestablishConsumers will iterate it
    // and try to assertQueue/bindQueue/consume.
    const token = `tok-reest-${Date.now()}`;
    const resEnd = jest.fn();
    const conns = await import('../../src/connections.js');
    conns.connections.set(token, {
      res: { write: jest.fn(), end: resEnd } as never,
      request: { url: '/sse/reest-test', headers: {} },
      heartbeatTimer: null,
      disconnected: false,
      ready: true,
      eventBuffer: [],
      amqpQueueName: 'sse.conn.reest-test',
      amqpConsumerTag: 'tag-reest-initial',
      amqpBindings: ['reest.k'],
    });

    // Force the consume() call inside reestablishConsumers to throw.
    mockChannel.consume.mockRejectedValueOnce(
      new Error('forced consume failure during reestablish')
    );

    // Re-run connect — doConnect calls reestablishConsumers at the end.
    await connectRabbitMQ(makeConfig(mockServer.getCallbackUrl()));

    expect(conns.connections.has(token)).toBe(false);
    expect(resEnd).toHaveBeenCalled();

    // Disconnect callback with reason 'error' for this token
    const disconnectCall = fetchSpy.mock.calls.find((call) => {
      try {
        const body = JSON.parse((call[1] as { body: string }).body) as {
          action?: string;
          token?: string;
        };
        return body.action === 'disconnect' && body.token === token;
      } catch {
        return false;
      }
    });
    expect(disconnectCall).toBeDefined();
    const disconnectBody = JSON.parse(
      (disconnectCall![1] as { body: string }).body
    ) as { reason: string };
    expect(disconnectBody.reason).toBe('error');
  });
});

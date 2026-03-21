/**
 * Mock Python backend server for testing callback interactions
 *
 * Provides a simple HTTP server that can be configured to return various responses
 * for testing connect and disconnect callback scenarios.
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

/**
 * Callback record captured by mock server
 */
export interface CallbackRecord {
  action: 'connect' | 'disconnect';
  reason?: 'client_closed' | 'server_closed' | 'error';
  token: string;
  request: {
    url: string;
    headers: Record<string, string | string[]>;
  };
}

/**
 * RabbitMQ callback response body
 */
export interface RabbitMQResponseBody {
  /** Request ID used to derive AMQP queue name */
  request_id: string;
  /** Routing key bindings for the connection */
  bindings: string[];
}

/**
 * Mock server configuration
 */
export interface MockServerConfig {
  /** Port to listen on (default: 0 for random port) */
  port?: number;
  /** Status code to return (default: 200) */
  statusCode?: number;
  /** Response delay in milliseconds (default: 0) */
  delay?: number;
  /** Optional RabbitMQ bindings to return in connect response body */
  rabbitmqResponse?: RabbitMQResponseBody | null;
}

/**
 * Mock Python backend server
 */
export class MockServer {
  private server: Server;
  private config: Required<MockServerConfig>;
  private callbackRecords: CallbackRecord[] = [];
  private listening = false;
  public port = 0;

  constructor(config: MockServerConfig = {}) {
    this.config = {
      port: config.port ?? 0,
      statusCode: config.statusCode ?? 200,
      delay: config.delay ?? 0,
      rabbitmqResponse: config.rabbitmqResponse ?? null,
    };

    this.server = createServer(this.handleRequest.bind(this));
  }

  /**
   * Start the mock server
   *
   * @returns Promise that resolves when server is listening
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);

      this.server.listen(this.config.port, () => {
        this.listening = true;
        const address = this.server.address();
        if (address && typeof address !== 'string') {
          this.port = address.port;
        }
        resolve();
      });
    });
  }

  /**
   * Stop the mock server
   *
   * @returns Promise that resolves when server is closed
   */
  async stop(): Promise<void> {
    if (!this.listening) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.listening = false;
          resolve();
        }
      });
    });
  }

  /**
   * Get the callback URL for this mock server
   *
   * @returns Callback URL
   */
  getCallbackUrl(): string {
    return `http://localhost:${this.port}/callback`;
  }

  /**
   * Get all captured callback records
   *
   * @returns Array of callback records
   */
  getCallbacks(): CallbackRecord[] {
    return this.callbackRecords;
  }

  /**
   * Get the last captured callback record
   *
   * @returns Last callback record or undefined if none
   */
  getLastCallback(): CallbackRecord | undefined {
    return this.callbackRecords[this.callbackRecords.length - 1];
  }

  /**
   * Clear all captured callback records
   */
  clearCallbacks(): void {
    this.callbackRecords = [];
  }

  /**
   * Set the status code to return for future requests
   *
   * @param statusCode - HTTP status code
   */
  setStatusCode(statusCode: number): void {
    this.config.statusCode = statusCode;
  }

  /**
   * Set the delay for future requests
   *
   * @param delay - Delay in milliseconds
   */
  setDelay(delay: number): void {
    this.config.delay = delay;
  }

  /**
   * Set the RabbitMQ response body to return for connect callbacks
   *
   * @param body - RabbitMQ response body with request_id and bindings, or null to clear
   */
  setRabbitMQResponse(body: RabbitMQResponseBody | null): void {
    this.config.rabbitmqResponse = body as Required<MockServerConfig>['rabbitmqResponse'];
  }

  /**
   * Handle incoming HTTP requests
   *
   * @param req - Incoming request
   * @param res - Server response
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only handle POST requests to /callback
    if (req.method !== 'POST' || req.url !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Read request body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      // Parse callback payload
      let action: string | undefined;
      try {
        const payload = JSON.parse(body) as CallbackRecord;
        this.callbackRecords.push(payload);
        action = payload.action;
      } catch (error) {
        // Invalid JSON - ignore for testing purposes
      }

      // Apply delay if configured
      if (this.config.delay > 0) {
        setTimeout(() => {
          this.sendResponse(res, action);
        }, this.config.delay);
      } else {
        this.sendResponse(res, action);
      }
    });
  }

  /**
   * Send HTTP response
   *
   * Includes RabbitMQ response body if configured for the current request.
   * Only includes rabbitmqResponse for connect callbacks (not disconnect).
   *
   * @param res - Server response
   * @param action - The callback action ('connect' or 'disconnect')
   */
  private sendResponse(res: ServerResponse, action?: string): void {
    res.writeHead(this.config.statusCode, { 'Content-Type': 'application/json' });

    // Include rabbitmq bindings in connect callback response if configured
    if (action === 'connect' && this.config.rabbitmqResponse) {
      res.end(JSON.stringify(this.config.rabbitmqResponse));
    } else {
      res.end(JSON.stringify({ status: 'ok' }));
    }
  }
}

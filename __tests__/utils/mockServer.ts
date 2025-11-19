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
 * Mock server configuration
 */
export interface MockServerConfig {
  /** Port to listen on (default: 0 for random port) */
  port?: number;
  /** Status code to return (default: 200) */
  statusCode?: number;
  /** Response delay in milliseconds (default: 0) */
  delay?: number;
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
  private responseBody: unknown = { status: 'ok' };

  constructor(config: MockServerConfig = {}) {
    this.config = {
      port: config.port ?? 0,
      statusCode: config.statusCode ?? 200,
      delay: config.delay ?? 0,
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
   * Set the response body to return for future requests
   *
   * Accepts any value (object, string, etc.) and stores it.
   * In sendResponse(), calls JSON.stringify() on the stored value.
   * This allows testing both valid CallbackResponseBody objects AND invalid structures.
   *
   * @param body - Response body (will be JSON.stringify'd)
   */
  setResponseBody(body: unknown): void {
    this.responseBody = body;
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
      try {
        const payload = JSON.parse(body) as CallbackRecord;
        this.callbackRecords.push(payload);
      } catch (error) {
        // Invalid JSON - ignore for testing purposes
      }

      // Apply delay if configured
      if (this.config.delay > 0) {
        setTimeout(() => {
          this.sendResponse(res);
        }, this.config.delay);
      } else {
        this.sendResponse(res);
      }
    });
  }

  /**
   * Send HTTP response
   *
   * @param res - Server response
   */
  private sendResponse(res: ServerResponse): void {
    res.writeHead(this.config.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.responseBody));
  }
}

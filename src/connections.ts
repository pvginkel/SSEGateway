/**
 * Connection state management for SSEGateway
 *
 * Manages the in-memory Map of active SSE connections.
 * Each connection is identified by a unique token (UUID).
 */

import type { Response } from 'express';

/**
 * Connection metadata stored for each active SSE connection
 */
export interface ConnectionRecord {
  /** Express response object for the SSE stream */
  res: Response;
  /** Original request metadata forwarded to Python backend */
  request: {
    /** Full raw URL including query string */
    url: string;
    /** Raw headers from the request (undefined values filtered out) */
    headers: Record<string, string | string[]>;
  };
  /** Heartbeat timer for periodic SSE keep-alive comments */
  heartbeatTimer: NodeJS.Timeout | null;
  /** Flag indicating client disconnected during async callback (race condition handling) */
  disconnected: boolean;
  /** Flag indicating headers have been sent and stream is ready for writes */
  ready: boolean;
  /** Buffer for events received before stream is ready */
  eventBuffer: Array<{ name?: string; data: string; close?: boolean }>;
}

/**
 * In-memory Map storing active SSE connections
 * Key: UUID token
 * Value: ConnectionRecord
 *
 * Note: All state is ephemeral - lost on process restart
 */
export const connections = new Map<string, ConnectionRecord>();

/**
 * Add a connection to the connections Map
 *
 * @param token - Unique connection token (UUID)
 * @param record - Connection record to store
 */
export function addConnection(token: string, record: ConnectionRecord): void {
  connections.set(token, record);
}

/**
 * Remove a connection from the connections Map
 *
 * @param token - Connection token to remove
 * @returns true if connection existed and was removed, false otherwise
 */
export function removeConnection(token: string): boolean {
  return connections.delete(token);
}

/**
 * Get a connection from the connections Map
 *
 * @param token - Connection token to retrieve
 * @returns ConnectionRecord if found, undefined otherwise
 */
export function getConnection(token: string): ConnectionRecord | undefined {
  return connections.get(token);
}

/**
 * Check if a connection exists in the Map
 *
 * @param token - Connection token to check
 * @returns true if connection exists, false otherwise
 */
export function hasConnection(token: string): boolean {
  return connections.has(token);
}

import type { IncomingMessage, RequestListener, ServerResponse } from 'http';
import type { Server, AddressInfo } from 'net';

export interface StoredVersion<T = unknown> {
  id: string;
  data: T;
}

/** The request a store call is made for, so the store can authorize per resource. */
export interface SyncContext {
  method: 'QUERY' | 'POST' | 'SYNC';
  target: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Everything SYNC needs from your data layer. Either method may be async. */
export interface SyncStore<T = unknown> {
  /** Return null for a resource that does not exist or that the caller may not read (reported as 404). */
  getCurrent(resource: string, context: SyncContext): StoredVersion<T> | null | Promise<StoredVersion<T> | null>;
  /** Return null when that version cannot be rebuilt; the client then receives a snapshot. */
  getVersion(resource: string, token: string, context: SyncContext): StoredVersion<T> | null | Promise<StoredVersion<T> | null>;
}

export interface SyncServer {
  server: Server;
  listen(port: number, host?: string | (() => void), cb?: () => void): SyncServer;
  address(): AddressInfo | string | null;
  close(cb?: () => void): void;
}

/**
 * Serves SYNC requests sent with QUERY (and POST as a fallback) whose Content-Type is
 * application/sync-baseline+json; all other requests go to next(). Works with
 * Express/Connect or around a plain Node handler.
 */
export function syncHandler(options?: {
  store?: SyncStore;
  /** Cache-Control for successful responses. Default 'no-store'; use public caching only for caller-independent data. */
  cacheControl?: string;
  /** Accept the POST fallback. Default true. */
  allowPost?: boolean;
  /** Answer QUERY requests with a missing (400) or other (415) Content-Type instead of passing them on. Default false. */
  strict?: boolean;
}): (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;

/** syncHandler plus the optional dedicated SYNC method, in front of an existing request handler. */
export function createSyncServer(options?: { app?: RequestListener; store?: SyncStore }): SyncServer;

export interface MemoryStore<T = unknown> {
  getCurrent(resource: string): StoredVersion<T> | null;
  getVersion(resource: string, token: string): StoredVersion<T> | null;
  addVersion(resource: string, id: string, data: T): void;
  getCurrentVersion(resource: string): StoredVersion<T> | null;
  listResources(): string[];
}

/** In-memory store; maxVersions bounds history per resource. */
export function createMemoryStore<T = unknown>(options?: { maxVersions?: number }): MemoryStore<T>;

export function computeResults(
  baselines: Record<string, string | null>,
  options?: { accept?: string[]; recover?: boolean; store?: SyncStore; context?: Partial<SyncContext> },
): Promise<{ results: Record<string, unknown>; allUnchanged: boolean }>;

export const JSON_PATCH: 'application/json-patch+json';
export const MERGE_PATCH: 'application/merge-patch+json';
export const SNAPSHOT: 'application/json';
export const SYNC_TYPE: 'application/sync-baseline+json';
export function buildUpdate(oldData: unknown, newData: unknown, accept?: string[]): { format: string; data: unknown };

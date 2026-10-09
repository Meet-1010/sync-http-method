import type { IncomingMessage, RequestListener, ServerResponse } from 'http';
import type { Server, AddressInfo } from 'net';

export interface StoredVersion<T = unknown> {
  id: string;
  data: T;
}

/** Everything SYNC needs from your data layer. Either method may be async. */
export interface SyncStore<T = unknown> {
  getCurrent(resource: string): StoredVersion<T> | null | Promise<StoredVersion<T> | null>;
  /** Return null when that version cannot be rebuilt; the client then receives a snapshot. */
  getVersion(resource: string, token: string): StoredVersion<T> | null | Promise<StoredVersion<T> | null>;
}

export interface SyncServer {
  server: Server;
  listen(port: number, host?: string | (() => void), cb?: () => void): SyncServer;
  address(): AddressInfo | string | null;
  close(cb?: () => void): void;
}

/** Serves the SYNC method and its POST form in front of an existing request handler. */
export function createSyncServer(options?: { app?: RequestListener; store?: SyncStore }): SyncServer;

/** Middleware for the POST form; works with Express/Connect or a plain Node handler. */
export function syncOverPost(options?: { store?: SyncStore }):
  (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;

export interface MemoryStore<T = unknown> extends SyncStore<T> {
  addVersion(resource: string, id: string, data: T): void;
  getCurrentVersion(resource: string): StoredVersion<T> | null;
  listResources(): string[];
}

/** In-memory store; maxVersions bounds history per resource. */
export function createMemoryStore<T = unknown>(options?: { maxVersions?: number }): MemoryStore<T>;

export function computeResults(
  baselines: Record<string, string | null>,
  options?: { accept?: string[]; recover?: boolean; store?: SyncStore },
): Promise<{ results: Record<string, unknown>; allUnchanged: boolean }>;

export const JSON_PATCH: 'application/json-patch+json';
export const MERGE_PATCH: 'application/merge-patch+json';
export const SNAPSHOT: 'application/json';
export const SYNC_TYPE: 'application/sync-baseline+json';
export function buildUpdate(oldData: unknown, newData: unknown, accept?: string[]): { format: string; data: unknown };

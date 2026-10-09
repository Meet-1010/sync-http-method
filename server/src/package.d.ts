import type { IncomingMessage, RequestListener, ServerResponse } from 'http';
import type { Server, AddressInfo } from 'net';

/** A version: one identifier, or a set of identifiers (printable ASCII). */
export type Version = string | string[];

export interface StoredVersion<T = unknown> {
  /** Must always name this exact state: the content of a version never changes. */
  version: Version;
  /** Media type; default application/json. JSON types hold JSON values, text types strings, others bytes. */
  type?: string;
  data: T;
}

/** The request a store call is made for, so the store can authorize per resource. */
export interface SyncContext {
  method: 'QUERY' | 'POST' | 'SYNC' | 'GET' | 'HEAD';
  target: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface SyncStoreView<T = unknown> {
  /** Return null for a resource that does not exist or that the caller may not read (reported as 404). */
  getCurrent(resource: string, context: SyncContext): StoredVersion<T> | null | Promise<StoredVersion<T> | null>;
  /** Return null when that version is no longer kept; the client then receives the full representation. */
  getVersion(resource: string, version: Version, context: SyncContext): StoredVersion<T> | null | Promise<StoredVersion<T> | null>;
}

/** Everything SYNC needs from your data layer. Methods may be async. */
export interface SyncStore<T = unknown> extends SyncStoreView<T> {
  /** Optional: a read view fixed at one instant, used for "consistent": true requests. */
  snapshot?(context: SyncContext): SyncStoreView<T> | Promise<SyncStoreView<T>>;
  /** Optional: call listener with the names of changed resources after each change; returns an unsubscribe function. Enables watching. */
  subscribe?(listener: (resources: string[]) => void): () => void;
  /**
   * Optional: write all changes atomically if every resource is at the version it expects (null: absent),
   * otherwise write nothing. Enables application/sync-changes+json. Statuses other than 412 (for example 403)
   * are reported to the client as they are.
   */
  write?(changes: StoreChange<T>[], context: SyncContext): WriteOutcome | Promise<WriteOutcome>;
}

export type StoreChange<T = unknown> =
  | { resource: string; expect: Version | null; version: Version; type: string; data: T }
  | { resource: string; expect: Version; deleted: true };

export type WriteOutcome = { ok: true } | { ok: false; statuses: Record<string, number> };

export interface LinkOptions {
  /** At least 32 characters; authenticates and encrypts links. Keep it stable across restarts and servers. */
  secret: string;
  /** Absolute path under which links are served, e.g. "/sync/updates". */
  path: string;
  /** Updates at least this many bytes become links. Default 1024. */
  minBytes?: number;
  /** Cache-Control for link and shared-result responses. Default 'private, max-age=31536000, immutable'. */
  cacheControl?: string;
  /**
   * Answer requests with "redirect": true by 303 (See Other) to a shared result under `path`,
   * which every client in the same state receives, so shared caches can serve all of them. Default true.
   */
  redirect?: boolean;
  /**
   * Give clients that ask ("next": true) a next URI in Sync-Next: a GET of it is the same request from the
   * versions the results lead to, served with the handler's cacheControl. Default true.
   */
  next?: boolean;
  /** Longest shared-result or next URI to send; longer ones are not used. Default 8000 (RFC 9110 Section 4.1). */
  maxUriLength?: number;
}

/**
 * Serves SYNC requests sent with QUERY (and POST as a fallback) whose Content-Type is
 * application/sync-baseline+json, and GETs of links and shared results; all other requests go to next().
 * Works with Express/Connect or around a plain Node handler.
 */
export function syncHandler(options?: {
  store?: SyncStore;
  /** Cache-Control for responses that reflect the current state (QUERY, POST and next URIs). Default 'no-store'; use public caching only for caller-independent data. */
  cacheControl?: string;
  /** Accept the POST fallback. Default true. */
  allowPost?: boolean;
  /** Answer QUERY requests with a missing (400) or other (415) Content-Type instead of passing them on. Default false. */
  strict?: boolean;
  links?: LinkOptions;
  /** Interval of keep-alive comments in watch streams. Default 15000. */
  heartbeatMs?: number;
  /** New version identifiers for writes. Default: 72 random bits, base64url. */
  newVersion?: (resource: string) => string;
}): (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;

export interface SyncServer {
  server: Server;
  listen(port: number, host?: string | (() => void), cb?: () => void): SyncServer;
  address(): AddressInfo | string | null;
  close(cb?: () => void): void;
}

/** syncHandler plus the experimental dedicated SYNC method, in front of an existing request handler. */
export function createSyncServer(options?: { app?: RequestListener; store?: SyncStore }): SyncServer;

export interface MemoryStore<T = unknown> {
  getCurrent(resource: string): StoredVersion<T> | null;
  getVersion(resource: string, version: Version): StoredVersion<T> | null;
  snapshot(): SyncStoreView<T>;
  /** Adds a version of one resource. */
  addVersion(resource: string, version: Version, data: T, type?: string): void;
  /** Adds versions of (or removes) several resources atomically: a snapshot sees all of them or none. */
  commit(changes: ({ resource: string; version: Version; data: T; type?: string } | { resource: string; deleted: true })[]): void;
  /** Removes a resource: it is absent (404) until a new version is added. */
  remove(resource: string): void;
  /** Atomic conditional write (see SyncStore.write). */
  write(changes: StoreChange<T>[]): WriteOutcome;
  subscribe(listener: (resources: string[]) => void): () => void;
  getCurrentVersion(resource: string): StoredVersion<T> | null;
  listResources(): string[];
}

/** In-memory store; maxVersions bounds history per resource. */
export function createMemoryStore<T = unknown>(options?: { maxVersions?: number }): MemoryStore<T>;

export function computeResults(
  baselines: Record<string, Version | null>,
  options?: { accept?: string[]; recover?: boolean; consistent?: boolean; store?: SyncStore; context?: Partial<SyncContext> },
): Promise<{ results: Record<string, unknown>; allUnchanged: boolean; consistent: boolean }>;

export const JSON_PATCH: 'application/json-patch+json';
export const MERGE_PATCH: 'application/merge-patch+json';
export const SPLICE: 'application/sync-splice+json';
export const SYNC_TYPE: 'application/sync-baseline+json';
export function buildUpdate(
  base: { type?: string; data: unknown },
  current: { type?: string; data: unknown },
  accept?: string[],
): { full: true } | { format: string; data: unknown };

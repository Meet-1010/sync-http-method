/** A version: one identifier, or a set of identifiers (order carries no meaning). */
export type Version = string | string[];
export type Baselines = Record<string, Version | null>;

export const JSON_PATCH: 'application/json-patch+json';
export const MERGE_PATCH: 'application/merge-patch+json';
export const SPLICE: 'application/sync-splice+json';
export type PatchFormat = typeof JSON_PATCH | typeof MERGE_PATCH | typeof SPLICE;

/** JSON values for JSON media types, strings for text types, bytes for everything else. */
export type Value = unknown;

export type Result =
  | { status: 200; from: Version; to: Version; format: PatchFormat; data?: unknown; href?: string }
  | { status: 200; from: null; to: Version; type: string; data?: unknown; encoding?: 'base64'; value?: Value; href?: string; baseline?: 'unrecognized' }
  | { status: 304; to: Version }
  | { status: 404 }
  | { status: 409 };

export interface ResultDocument {
  results: Record<string, Result>;
}

export type Transport = 'auto' | 'query' | 'post' | 'method';

export interface SyncFetchOptions {
  /** Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** 'auto' sends QUERY and falls back to POST, remembering per origin; 'method' uses the experimental SYNC method. */
  transport?: Transport;
  /** 'json' (application/sync-result+json, default) or 'multipart' (multipart/mixed). */
  result?: 'json' | 'multipart';
  /** Patch formats in preference order. */
  accept?: PatchFormat[];
  /** false: unrecognized baselines yield 409 instead of the full representation. */
  recover?: boolean;
  /** Ask for every result to come from one state of the server (Sync-Consistent). */
  consistent?: boolean;
  /** Let the server return links for large updates; they are fetched automatically. */
  links?: boolean;
  /**
   * Let the server answer 303 (See Other) with the URI of the whole result, which shared caches can
   * serve to every client in the same state. Followed automatically; if that URI fails, the request is repeated directly.
   */
  redirect?: boolean;
  /**
   * Ask for a next URI (the Sync-Next response field): a GET of it is the same request from the
   * versions these results lead to, which shared caches can answer for every client in the same state.
   * SyncClient uses it automatically while it holds exactly those versions.
   */
  next?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SyncResponse {
  status: number;
  headers: Headers;
  body: ResultDocument | { title?: string; status?: number; detail?: string } | null;
  transport: 'QUERY' | 'POST' | 'SYNC';
}

export function syncFetch(url: string, baselines: Baselines, options?: SyncFetchOptions): Promise<SyncResponse>;

/** GET of a next URI (from Sync-Next); links in the results are fetched. Use it only while holding the versions it was issued for. */
export function syncFetchNext(
  uri: string,
  options?: Pick<SyncFetchOptions, 'fetch' | 'result' | 'headers' | 'signal'> & { base?: string | URL },
): Promise<Omit<SyncResponse, 'transport'> & { transport: 'GET' }>;

export interface StoredEntry {
  version: Version;
  type?: string;
  value: Value;
  encoding?: 'base64';
}

/** A next URI kept by SyncClient, and what it was issued for. */
export interface NextState {
  uri: string;
  key: string;
}

/** Serialized client state: one entry per resource (names start with "/"), and "@next" for the next URI. */
export type SyncClientState = Record<string, StoredEntry | NextState>;

export interface SyncClientOptions extends Omit<SyncFetchOptions, 'signal'> {
  /** State previously returned by client.toJSON(), to resume with patches (and the next URI). */
  state?: SyncClientState;
}

export interface SyncOutcome<T = Value> {
  values: Record<string, T>;
  changed: string[];
  removed: string[];
}

export interface WatchOptions<T = Value> {
  /** Called after each change is applied, with the current values of the watched resources. */
  onChange?: (outcome: SyncOutcome<T>) => void;
  /** Called on errors; watching continues (reconnecting) unless the error is fatal. */
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  /** Every state passed to onChange existed on the server at one instant; fails if the server cannot guarantee it. */
  consistent?: boolean;
  /** Polling interval against a server that cannot stream. Default 5000. */
  pollMs?: number;
  /** First delay before reconnecting after a failure (doubling up to 30 s). Default 1000. */
  retryMs?: number;
}

export interface WatchHandle {
  close(): void;
  /** Settles when watching stops; rejects with a fatal SyncError. */
  closed: Promise<void>;
}

export class SyncClient<T = Value> {
  constructor(url: string, options?: SyncClientOptions);
  /** Keeps the resources current over one stream ("watch": true), reconnecting with what it holds. */
  watch(resources?: string[], options?: WatchOptions<T>): WatchHandle;
  /**
   * Changes several resources atomically: every change is applied, or none. The client sends the smallest
   * patch from the version it holds. With merge, the server rebases changes made from an older version when
   * they touch different parts. Throws SyncError (with `results`) when the changes were not applied.
   */
  write(changes: Record<string, WriteChange<T>>, options?: { merge?: boolean; signal?: AbortSignal }): Promise<WriteOutcome>;
  /** With consistent: true, throws SyncError unless the server confirms a consistent snapshot. */
  sync(resources?: string[], options?: { signal?: AbortSignal; consistent?: boolean }): Promise<SyncOutcome<T>>;
  get(resource: string): T | undefined;
  toJSON(): SyncClientState;
  load(state: SyncClientState): void;
}

export function createSyncClient<T = Value>(url: string, options?: SyncClientOptions): SyncClient<T>;

export class SyncError extends Error {
  status: number;
  body: unknown;
  /** For writes: the per-resource results. */
  results?: Record<string, WriteResult>;
  /** For watches: the error ends watching. */
  fatal?: boolean;
}

export type WriteChange<T = Value> = { value: T; type?: string } | { delete: true };

export type WriteResult =
  | { status: 200; from: Version | null; to?: Version; rebased?: true; update?: { format: PatchFormat; data: unknown } | { type: string; data: unknown; encoding?: 'base64' } }
  | { status: 404 | 424 | 403 }
  | { status: 409; current?: Version; reason?: string }
  | { status: 412; current: Version }
  | { status: 422; reason?: string };

export interface WriteOutcome {
  results: Record<string, WriteResult>;
  /** Resources the server merged with newer changes; the client now holds the merged values. */
  rebased: string[];
}

export class BaselineMap {
  constructor(initial?: Baselines);
  get(resource: string): Version | null;
  set(resource: string, version: Version): void;
  toJSON(): Baselines;
  applyResults(body: ResultDocument | null): void;
}

/** Applies one result to a local value; throws if a patch does not start from localVersion. */
export function applyResult<T = Value>(localValue: T | undefined, localVersion: Version | null, result: Result): T;
export function applyMergePatch(target: unknown, patch: unknown): unknown;
export function applySplice(value: string | Uint8Array, patch: { unit: 'codepoint' | 'byte'; splices: [number, number, string][] }): string | Uint8Array;

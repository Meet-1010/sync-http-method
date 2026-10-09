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

export interface StoredEntry {
  version: Version;
  type?: string;
  value: Value;
  encoding?: 'base64';
}

export interface SyncClientOptions extends Omit<SyncFetchOptions, 'signal'> {
  /** State previously returned by client.toJSON(), to resume with patches. */
  state?: Record<string, StoredEntry>;
}

export interface SyncOutcome<T = Value> {
  values: Record<string, T>;
  changed: string[];
  removed: string[];
}

export class SyncClient<T = Value> {
  constructor(url: string, options?: SyncClientOptions);
  /** With consistent: true, throws SyncError unless the server confirms a consistent snapshot. */
  sync(resources?: string[], options?: { signal?: AbortSignal; consistent?: boolean }): Promise<SyncOutcome<T>>;
  get(resource: string): T | undefined;
  toJSON(): Record<string, StoredEntry>;
  load(state: Record<string, StoredEntry>): void;
}

export function createSyncClient<T = Value>(url: string, options?: SyncClientOptions): SyncClient<T>;

export class SyncError extends Error {
  status: number;
  body: unknown;
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

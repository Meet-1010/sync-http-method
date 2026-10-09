export type Token = string;
export type Baselines = Record<string, Token | null>;

export const JSON_PATCH: 'application/json-patch+json';
export const MERGE_PATCH: 'application/merge-patch+json';
export const SNAPSHOT: 'application/json';
export type UpdateFormat = typeof JSON_PATCH | typeof MERGE_PATCH | typeof SNAPSHOT;

export type Result =
  | { status: 200; format: UpdateFormat; from: Token | null; to: Token; data: unknown; baseline?: 'unrecognized' }
  | { status: 304; to: Token }
  | { status: 404 }
  | { status: 409 };

export interface ResultDocument {
  results: Record<string, Result>;
  synced_at: string;
}

export type Transport = 'auto' | 'query' | 'post' | 'method';

export interface SyncFetchOptions {
  /** Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** 'auto' sends QUERY and falls back to POST, remembering per origin; 'method' uses the dedicated SYNC method. */
  transport?: Transport;
  /** Update formats in preference order. */
  accept?: UpdateFormat[];
  /** false: unrecognized baselines yield 409 instead of a snapshot. */
  recover?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SyncResponse {
  status: number;
  headers: Headers;
  body: ResultDocument | { error: string } | null;
  transport: 'QUERY' | 'POST' | 'SYNC';
}

export function syncFetch(url: string, baselines: Baselines, options?: SyncFetchOptions): Promise<SyncResponse>;

export interface SyncClientOptions extends Omit<SyncFetchOptions, 'signal'> {
  /** State previously returned by client.toJSON(), to resume with patches. */
  state?: Record<string, { token: Token; value: unknown }>;
}

export interface SyncOutcome<T = unknown> {
  values: Record<string, T>;
  changed: string[];
  removed: string[];
}

export class SyncClient<T = unknown> {
  constructor(url: string, options?: SyncClientOptions);
  sync(resources?: string[], options?: { signal?: AbortSignal }): Promise<SyncOutcome<T>>;
  get(resource: string): T | undefined;
  toJSON(): Record<string, { token: Token; value: T }>;
  load(state: Record<string, { token: Token; value: T }>): void;
}

export function createSyncClient<T = unknown>(url: string, options?: SyncClientOptions): SyncClient<T>;

export class SyncError extends Error {
  status: number;
  body: unknown;
}

export class BaselineMap {
  constructor(initial?: Baselines);
  get(resource: string): Token | null;
  set(resource: string, token: Token): void;
  toJSON(): Baselines;
  applyResults(body: ResultDocument | null): void;
}

/** Applies one result to a local value; throws if a patch does not start from localToken. */
export function applyResult<T = unknown>(localValue: T | undefined, localToken: Token | null, result: Result): T;
export function applyMergePatch(target: unknown, patch: unknown): unknown;

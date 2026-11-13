import { Effect, Schema } from 'effect';
import type { Env, Caller } from '../env';
import { anonymousBucket, inRanges, type Cidr } from './ip';
import { QUOTAS } from './limits';

export const KeyRecord = Schema.Struct({
  name: Schema.String, email: Schema.String, org: Schema.String, use: Schema.String,
  createdAt: Schema.String, tier: Schema.Literal('registered'),
  status: Schema.Literals(['active', 'revoked']),
});
export type KeyRecord = typeof KeyRecord.Type;
export class StorageError extends Schema.TaggedError<StorageError>()('StorageError', {}) {}
export class CorruptRecord extends Schema.TaggedError<CorruptRecord>()('CorruptRecord', { key: Schema.String }) {}
export const storage = <A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: operation, catch: () => new StorageError({}),
});
export const hashKey = Effect.fn('hashKey')(function* (key: string) {
  const digest = yield* storage(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
});
/** Read a JSON record from KV: null when missing, CorruptRecord when unreadable, so a limiter never fails open. */
export const readJson = Effect.fn('readJson')(function* <S extends Schema.Top>(env: Env, key: string, schema: S) {
  const raw = yield* storage(() => env.MCP_KEYS.get(key));
  if (raw === null) return null;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(() => new CorruptRecord({ key })),
  );
});
/** A corrupt key record reads as "no such key" (a 401); a storage failure still propagates (a 503). */
export const readKey = (env: Env, hash: string) => readJson(env, `key:${hash}`, KeyRecord).pipe(
  Effect.catchTag('CorruptRecord', () => Effect.succeed(null)),
);
export const writeKey = (env: Env, hash: string, record: KeyRecord) =>
  storage(() => env.MCP_KEYS.put(`key:${hash}`, JSON.stringify(record)));

export const generateKey = Effect.sync(() => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = 'ctc_';
  while (key.length < 44) {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    for (const byte of bytes) {
      if (byte < 248 && key.length < 44) key += alphabet[byte % 62];
    }
  }
  return key;
});

/** `denyListUnchecked`: the deny list could not be read. The request may go on only if it runs no tool, so a
 *  KV outage does not take down initialise and tools/list, nor let a denied caller call tools. */
export type AuthDecision = { caller: Caller; status: number; error?: string; denyListUnchecked?: true };
/** True when any of the buckets is on the KV deny list. Read on every request, so a ban needs no deploy. */
/** True or false, or 'unknown' when KV could not be read. That is logged for the alert job, and the caller
 *  decides: only requests that run no tool may go on unchecked (see `denyListUnchecked`). */
const denied = (env: Env, buckets: readonly string[]) => Effect.forEach(
  [...new Set(buckets)], bucket => storage(() => env.MCP_KEYS.get(`deny:${bucket}`)), { concurrency: 'unbounded' },
).pipe(
  Effect.map(entries => entries.some(entry => entry !== null)),
  Effect.catchTag('StorageError', () => Effect.sync(() => { console.error('deny_list_unavailable'); return 'unknown' as const; })),
);
export const authorise = Effect.fn('authorise')(function* (request: Request, env: Env, connectors: readonly Cidr[]): Effect.fn.Return<AuthDecision, StorageError> {
  const header = request.headers.get('Authorization');
  const ip = request.headers.get('CF-Connecting-IP');
  // The address bucket: an IPv4 address or an IPv6 /64. A published connector address keeps it as its
  // bucket but gets the connector limits, because many people share it.
  const address = anonymousBucket(ip);
  const caller: Caller = header !== null
    ? { tier: 'registered', limits: 'registered', bucket: '' }
    : { tier: 'anonymous', limits: ip !== null && inRanges(ip, connectors) ? 'connector' : 'anonymous', bucket: address };
  if (header !== null) {
    const match = /^Bearer (ctc_[A-Za-z0-9]{40})$/i.exec(header);
    if (!match || !match[1].startsWith('ctc_')) return { caller, status: 401, error: 'invalid_key' };
    const hash = yield* hashKey(match[1]);
    const record = yield* readKey(env, hash);
    if (!record || record.status !== 'active') return { caller, status: 401, error: 'invalid_key' };
    // The quota belongs to the person, not the key: re-registering mints another key but no extra allowance.
    // The bucket keeps the `k:` prefix because www only accepts `k:` and `ip:` forwarded caller keys.
    caller.bucket = `k:${yield* hashKey(record.email.trim().toLowerCase())}`;
  }
  // The limiter runs first because it is the cheaper check: a flood is cut off at the minute rate without a
  // KV read per request. The address deny entry also covers keyed callers.
  const limiter = env[QUOTAS[caller.limits].binding];
  const rate = yield* storage(() => limiter.limit({ key: caller.bucket }));
  if (!rate.success) return { caller, status: 429, error: 'rate_limited' };
  const deny = yield* denied(env, [caller.bucket, address]);
  if (deny === true) return { caller, status: 403, error: 'denied' };
  return deny === 'unknown' ? { caller, status: 200, denyListUnchecked: true } : { caller, status: 200 };
});

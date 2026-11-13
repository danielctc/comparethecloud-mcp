import { Effect, Schema } from 'effect';
import type { Env, Caller } from '../env';
import { anonymousBucket, inRanges, type Cidr } from './ip';
import { QUOTAS, type LimitProfile } from './limits';
import { identifyBearer, oauthEnabled, type AuthUnavailable } from './oauth';

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
/** A credential's quota bucket, or why it gets none. The quota belongs to the person, not the key. */
type Credential = { bucket: string } | { status: 401 | 403 | 429; error: 'invalid_key' | 'insufficient_scope' | 'rate_limited' };
const invalid: Credential = { status: 401, error: 'invalid_key' };
const credentialBucket = Effect.fnUntraced(function* (env: Env, header: string, address: string, addressLimits: LimitProfile): Effect.fn.Return<Credential, StorageError | AuthUnavailable> {
  const match = /^Bearer (ctc_[A-Za-z0-9]{40})$/i.exec(header);
  if (!match && oauthEnabled(env)) {
    // An OAuth access token or a dashboard key, both vouched for by ctc-auth: the bucket is the user. Each
    // introspection cache miss costs ctc-auth a lookup, so misses are metered: per address, at the address's own
    // minute rate, for credentials any string can reach; per user for a JWT, whose signature already held.
    const spend = (limiter: RateLimit, key: string) => storage(() => limiter.limit({ key })).pipe(Effect.map(rate => rate.success));
    const meters = { address: spend(env[QUOTAS[addressLimits].binding], `introspect:${address}`), user: (sub: string) => spend(env.RL_INTROSPECT, `u:${sub}`) };
    return yield* identifyBearer(env, header, meters).pipe(
      Effect.map((verdict): Credential => verdict.kind === 'user' ? { bucket: `u:${verdict.sub}` }
        : verdict.kind === 'insufficient_scope' ? { status: 403, error: 'insufficient_scope' } : invalid),
      Effect.catchTag('IntrospectionThrottled', () => Effect.succeed<Credential>({ status: 429, error: 'rate_limited' })),
    );
  }
  if (!match || !match[1].startsWith('ctc_')) return invalid;
  const record = yield* readKey(env, yield* hashKey(match[1]));
  if (!record || record.status !== 'active') return invalid;
  // Re-registering mints another key but no extra allowance. The bucket keeps the `k:` prefix: www accepts
  // `k:` and `ip:` forwarded caller keys (`u:` once W1 ships).
  return { bucket: `k:${yield* hashKey(record.email.trim().toLowerCase())}` };
});
export const authorise = Effect.fn('authorise')(function* (request: Request, env: Env, connectors: readonly Cidr[]): Effect.fn.Return<AuthDecision, StorageError | AuthUnavailable> {
  const header = request.headers.get('Authorization');
  const ip = request.headers.get('CF-Connecting-IP');
  // The address bucket: an IPv4 address or an IPv6 /64. A published connector address keeps it as its
  // bucket but gets the connector limits, because many people share it.
  const address = anonymousBucket(ip);
  const addressLimits = ip !== null && inRanges(ip, connectors) ? 'connector' : 'anonymous';
  const caller: Caller = header !== null
    ? { tier: 'registered', limits: 'registered', bucket: '' }
    : { tier: 'anonymous', limits: addressLimits, bucket: address };
  if (header !== null) {
    const credential = yield* credentialBucket(env, header, address, addressLimits);
    if ('status' in credential) return { caller, ...credential };
    caller.bucket = credential.bucket;
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

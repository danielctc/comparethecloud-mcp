import { Effect, Schema } from 'effect';
import type { Env, Caller } from '../env';

export const KeyRecord = Schema.Struct({
  name: Schema.String, email: Schema.String, org: Schema.String, use: Schema.String,
  createdAt: Schema.String, tier: Schema.Literal('registered'),
  status: Schema.Literals(['active', 'revoked']),
});
export type KeyRecord = typeof KeyRecord.Type;
export class StorageError extends Schema.TaggedError<StorageError>()('StorageError', {}) {}
export const storage = <A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: operation, catch: () => new StorageError({}),
});
export const hashKey = Effect.fn('hashKey')(function* (key: string) {
  const digest = yield* storage(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
});
export const readKey = Effect.fn('readKey')(function* (env: Env, hash: string) {
  const raw = yield* storage(() => env.MCP_KEYS.get(`key:${hash}`));
  if (raw === null) return null;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(KeyRecord))(raw).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
});
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

export type AuthDecision = { caller: Caller; status: number; error?: string };
export const authorise = Effect.fn('authorise')(function* (request: Request, env: Env): Effect.fn.Return<AuthDecision, StorageError> {
  const header = request.headers.get('Authorization');
  const caller: Caller = header === null
    ? { tier: 'anonymous', policy: '60;w=60', bucket: `ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` }
    : { tier: 'registered', policy: '600;w=60', bucket: '' };
  if (header !== null) {
    const match = /^Bearer (ctc_[A-Za-z0-9]{40})$/i.exec(header);
    if (!match || !match[1].startsWith('ctc_')) return { caller, status: 401, error: 'invalid_key' };
    const hash = yield* hashKey(match[1]);
    const record = yield* readKey(env, hash);
    if (!record || record.status !== 'active') return { caller, status: 401, error: 'invalid_key' };
    caller.bucket = `k:${hash}`;
  }
  const limiter = caller.tier === 'anonymous' ? env.RL_ANON : env.RL_KEY;
  const rate = yield* storage(() => limiter.limit({ key: caller.bucket }));
  return rate.success ? { caller, status: 200 } : { caller, status: 429, error: 'rate_limited' };
});

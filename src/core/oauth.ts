import { Clock, Effect, Option, Predicate, Schema } from 'effect';
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet } from 'jose';
import type { Env } from '../env';
import { readUpTo } from './body';

/**
 * OAuth sign-in for the MCP Worker (plan comparethecloud-mcp-oauth-plan-v1.md section 1, bolt M2; revocation per
 * revocation-design-fable.md, "MCP Worker").
 *
 * A JWT is verified against the issuer's JWKS and then always introspected: ctc-auth answers inactive once the
 * user's grant is withdrawn, so a token is only as good as its latest answer. An opaque token and a dashboard API
 * key can only be checked by introspection. Answers are cached for under 60 seconds and never past exp, negatives
 * included. Any failure to get a clean answer is a deny: there is no fail-open.
 */
export const AUTH_ISSUER = 'https://auth.comparethecloud.net';
const JWKS_URL = `${AUTH_ISSUER}/api/auth/jwks`;
const INTROSPECTION_URL = `${AUTH_ISSUER}/api/auth/oauth2/introspect`;
export const RESOURCE_PATH = '/auth/mcp';
export const METADATA_PATH = `/.well-known/oauth-protected-resource${RESOURCE_PATH}`;
/** The scope a token needs for these read-only tools. */
export const REQUIRED_SCOPE = 'mcp:read';
/** The resource identifier: the URL a client connects to, and the audience its token must carry. */
export const resourceId = (env: Env) => `${env.PUBLIC_ORIGIN}${RESOURCE_PATH}`;
export const metadataUrl = (env: Env) => `${env.PUBLIC_ORIGIN}${METADATA_PATH}`;
/** Off unless exactly "true": the string "false" is truthy, and a typo must leave sign-in off. */
export const oauthEnabled = (env: Env) => env.OAUTH_ENABLED === 'true';

/** RFC 9728 metadata for /auth/mcp. Nothing like it is served for /mcp: the no-auth listings stay no-auth. */
export const protectedResourceMetadata = (env: Env) => ({
  resource: resourceId(env),
  authorization_servers: [AUTH_ISSUER],
  scopes_supported: ['openid', 'email', 'offline_access', REQUIRED_SCOPE],
  bearer_methods_supported: ['header'],
});

// The house OIDC client's numbers (ctc-auth lib/oidc): asymmetric algorithms only, so `none` and an HMAC keyed
// with the public key both fail; tokens over 8 KB are refused before any work.
const ALGORITHMS = ['EdDSA', 'ES256', 'RS256'];
const MAX_TOKEN_LENGTH = 8_192;
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;
/** release/r1 dashboard keys: ctc_ plus 32 random bytes in base64url. Legacy keys (40 alphanumerics) never get here. */
const DASHBOARD_KEY = /^ctc_[A-Za-z0-9_-]{43}$/;
/** The subject becomes the `u:` bucket: a KV key, a Durable Object name and the X-CTC-RL-Key header www checks
 *  against `[A-Za-z0-9.:_-]{1,128}` after its prefix. A subject outside that is refused rather than rewritten. */
const SUBJECT = /^[A-Za-z0-9.:_-]{1,128}$/;

const JWKS_FRESH_MS = 600_000;
// An unknown kid forces a refetch at once (a rotation), but at most once a minute, so forged kids cannot drive
// calls to ctc-auth.
const JWKS_FORCED_COOLDOWN_MS = 60_000;
// With no keys at all, a failed fetch is not retried for 10 seconds, so an outage does not turn every request
// into a call to ctc-auth.
const JWKS_RETRY_MS = 10_000;
/** Under 60 seconds from the introspection, so a withdrawn grant is refused within a minute (CT-5). */
const INTROSPECTION_CACHE_MS = 59_000;
const MAX_CACHED = 5_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 65_536;

export class AuthUnavailable extends Schema.TaggedError<AuthUnavailable>()('AuthUnavailable', {}) {}
/** The address, or for a JWT the user, has spent its revocation checks for this minute. */
export class IntrospectionThrottled extends Schema.TaggedError<IntrospectionThrottled>()('IntrospectionThrottled', {}) {}
class IntrospectionFailed extends Schema.TaggedError<IntrospectionFailed>()('IntrospectionFailed', {}) {}
/** Spends one introspection from a minute's allowance; true when it may go ahead. */
export type Admit = Effect.Effect<boolean, unknown>;
/** Where a credential's cache misses are metered: per address for anything any string can reach, per user for a
 *  JWT, which only gets as far as introspection once its signature holds. */
export interface Meters { address: Admit; user: (sub: string) => Admit }

/** Whose credential this is, or why it gets nothing: invalid is a 401, insufficient scope a 403. */
export type Verdict = { kind: 'user'; sub: string } | { kind: 'invalid' } | { kind: 'insufficient_scope' };
const user = (sub: string): Verdict => ({ kind: 'user', sub });
const invalid: Verdict = { kind: 'invalid' };
const insufficientScope: Verdict = { kind: 'insufficient_scope' };

/** The claims this server judges, whether they came from a verified JWT or an introspection answer. */
const Claims = Schema.Struct({
  sub: Schema.optionalKey(Schema.String),
  aud: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  scope: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
  azp: Schema.optionalKey(Schema.String),
  cnf: Schema.optionalKey(Schema.Unknown),
});
type Claims = typeof Claims.Type;
const decodeClaims = Schema.decodeUnknownOption(Claims);
const Introspection = Schema.Struct({
  ...Claims.fields,
  active: Schema.Boolean,
  iss: Schema.optionalKey(Schema.String),
  exp: Schema.optionalKey(Schema.Number),
  token_type: Schema.optionalKey(Schema.String),
});
type Introspection = typeof Introspection.Type;
const decodeIntrospection = Schema.decodeUnknownEffect(Schema.fromJsonString(Introspection));

const forThisResource = (env: Env, aud: Claims['aud']) =>
  (aud === undefined ? [] : Predicate.isString(aud) ? [aud] : aud).includes(resourceId(env));
/** OAuth scope is space-delimited; a lookalike such as mcp:readwrite does not count. */
const grantsRead = (scope: Claims['scope']) => scope !== undefined && scope.split(' ').includes(REQUIRED_SCOPE);
/** A user's token: a safe subject that is not the client itself. A client-credentials token carries the client
 *  id as `sub`, and a token naming no client cannot be told apart from one, so both are refused. */
const userSubject = ({ sub, client_id: clientId, azp }: Claims): Option.Option<string> => {
  if (sub === undefined || !SUBJECT.test(sub)) return Option.none();
  if (clientId === undefined && azp === undefined) return Option.none();
  return sub === clientId || sub === azp ? Option.none() : Option.some(sub);
};

// Per-isolate caches. The JWKS is public. Introspection answers are keyed on a SHA-256 of the token, never the
// token itself, kept apart for verified JWTs and for credentials any string can reach, and bounded so a spray of
// junk cannot grow the isolate's memory or push out the answers for real users.
let jwks: ReturnType<typeof createLocalJWKSet> | undefined;
/** When the key set is next fetched: 10 minutes after a good fetch, 60 seconds after a failed refresh of keys
 *  already held, 10 seconds after a failed first fetch. */
let refreshAt = -Infinity;
let lastForcedAt = -Infinity;
type AnswerCache = Map<string, { answer: Introspection; until: number }>;
const jwtAnswers: AnswerCache = new Map();
const credentialAnswers: AnswerCache = new Map();
/** Tests start each case with an empty isolate. */
export const resetOAuthCaches = () => {
  jwks = undefined; refreshAt = -Infinity; lastForcedAt = -Infinity; jwtAnswers.clear(); credentialAnswers.clear();
};

/** A 200 with a body read up to a cap; anything else (no answer, timeout, any other status) is a failure. */
const fetchText = (input: string, init: RequestInit) => Effect.tryPromise(async () => {
  const response = await fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status === 200) return response;
  await response.body?.cancel().catch(() => undefined);
  throw new Error(`HTTP ${response.status}`);
}).pipe(
  Effect.flatMap(response => readUpTo(response.body, MAX_RESPONSE_BYTES)),
  Effect.mapError(() => new IntrospectionFailed({})),
);

const loadJwks = Effect.fnUntraced(function* (force: boolean) {
  const now = yield* Clock.currentTimeMillis;
  const due = force && jwks ? now - lastForcedAt >= JWKS_FORCED_COOLDOWN_MS : now >= refreshAt;
  if (!due) return jwks ?? (yield* new AuthUnavailable({}));
  if (force) lastForcedAt = now;
  const fetched = yield* fetchText(JWKS_URL, { headers: { Accept: 'application/json' } }).pipe(
    Effect.flatMap(text => Effect.try({
      // SAFETY: createLocalJWKSet validates the set's shape itself and throws on anything that is not one.
      try: () => createLocalJWKSet(JSON.parse(text) as JSONWebKeySet), catch: () => new AuthUnavailable({}),
    })),
    Effect.option,
  );
  // A failed refresh keeps the last good keys: they are still the issuer's, and every token is introspected
  // anyway. With none ever fetched there is nothing to verify against, so the request fails closed, and so does a
  // forced refetch for an unknown kid: the old keys cannot settle whether the token is good.
  if (Option.isSome(fetched)) jwks = fetched.value;
  refreshAt = now + (Option.isSome(fetched) ? JWKS_FRESH_MS : jwks ? JWKS_FORCED_COOLDOWN_MS : JWKS_RETRY_MS);
  if (force && Option.isNone(fetched)) return yield* new AuthUnavailable({});
  return jwks ?? (yield* new AuthUnavailable({}));
});

const sha256 = (token: string) => Effect.promise(async () => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
});

/** Cache an answer from the time it was asked for: under 60 seconds and never past the token's exp. When the
 *  cache is full, expired answers go first; only a cache full of live ones loses its oldest entry. */
const remember = (cache: AnswerCache, key: string, answer: Introspection, now: number) => {
  const expiry = answer.exp !== undefined ? answer.exp * 1_000 : Infinity;
  if (cache.size >= MAX_CACHED) {
    for (const [stale, entry] of cache) if (entry.until <= now) cache.delete(stale);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value ?? '');
  }
  cache.delete(key);
  cache.set(key, { answer, until: Math.min(now + INTROSPECTION_CACHE_MS, expiry) });
};

/** Ask ctc-auth about a token as ctc-mcp (CT-5, client_secret_post), through a cache. Only a miss spends the
 *  allowance; a limiter that cannot answer, and any failure to get a clean answer, is AuthUnavailable (503). */
const introspect = Effect.fnUntraced(function* (env: Env, token: string, options: { cache: AnswerCache; admit: Admit; accessToken: boolean }) {
  const now = yield* Clock.currentTimeMillis;
  const key = yield* sha256(token);
  const cached = options.cache.get(key);
  if (cached && cached.until > now) return cached.answer;
  if (!(yield* options.admit.pipe(Effect.mapError(() => new AuthUnavailable({}))))) return yield* new IntrospectionThrottled({});
  if (!env.CTC_MCP_CLIENT_ID || !env.CTC_MCP_CLIENT_SECRET) return yield* new AuthUnavailable({});
  const form = new URLSearchParams({ token });
  if (options.accessToken) form.set('token_type_hint', 'access_token');
  form.set('client_id', env.CTC_MCP_CLIENT_ID);
  form.set('client_secret', env.CTC_MCP_CLIENT_SECRET);
  const answer = yield* fetchText(INTROSPECTION_URL, {
    method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  }).pipe(Effect.flatMap(decodeIntrospection), Effect.mapError(() => new AuthUnavailable({})));
  remember(options.cache, key, answer, now);
  return answer;
});

/** The local half of a JWT check: signature against the JWKS, issuer, audience, typ, expiry. None means the
 *  token is bad (401); AuthUnavailable means there were no keys to check it against (503). */
const verifyLocally = Effect.fnUntraced(function* (env: Env, token: string): Effect.fn.Return<Option.Option<Claims>, AuthUnavailable> {
  // A token whose header is unreadable or names an algorithm this server never accepts is refused before any
  // key is fetched.
  const header = Option.liftThrowable(decodeProtectedHeader)(token);
  if (Option.isNone(header) || !Predicate.isString(header.value.alg) || !ALGORITHMS.includes(header.value.alg)) return Option.none();
  const now = yield* Clock.currentTimeMillis;
  const verify = (force: boolean) => loadJwks(force).pipe(Effect.flatMap(keys => Effect.tryPromise({
    try: () => jwtVerify(token, keys, {
      issuer: AUTH_ISSUER, audience: resourceId(env), algorithms: ALGORITHMS, typ: 'at+jwt',
      requiredClaims: ['sub', 'exp'], currentDate: new Date(now),
    }),
    catch: cause => cause,
  })));
  return yield* verify(false).pipe(
    // An unknown kid is a rotation or a forgery. One refetch a minute settles which; inside that minute the
    // answer is a retryable 503, so a client holding a token from a just-rotated key does not discard it.
    Effect.catch(cause => !(cause instanceof errors.JWKSNoMatchingKey) ? Effect.fail(cause)
      : now - lastForcedAt >= JWKS_FORCED_COOLDOWN_MS ? verify(true) : Effect.fail(new AuthUnavailable({}))),
    // A payload whose claims have the wrong types is as bad as a bad signature.
    Effect.map(result => decodeClaims(result.payload)),
    // Only a missing key set is ctc-auth's fault; every other failure is the token's.
    Effect.catch(cause => cause instanceof AuthUnavailable ? Effect.fail(cause) : Effect.succeed(Option.none<Claims>())),
  );
});

/** What a token's claims, from the JWT or from introspection, say about this resource. Every check a future
 *  claim needs (ctc-auth's grant stamp, say) belongs here, so both token kinds get it. */
const judgeClaims = (env: Env, claims: Claims): Verdict => {
  // A sender-constrained token is not a bearer token; this server cannot check its proof.
  if (claims.cnf !== undefined || !forThisResource(env, claims.aud)) return invalid;
  const subject = userSubject(claims);
  if (Option.isNone(subject)) return invalid;
  return grantsRead(claims.scope) ? user(subject.value) : insufficientScope;
};

/** A JWT: verified locally, then always introspected, before scope is judged, so a revoked token is told to sign
 *  in again (401) rather than to ask for more scope (403). The answer, not the token, decides. */
const verifyJwt = Effect.fnUntraced(function* (env: Env, token: string, meters: Meters): Effect.fn.Return<Verdict, AuthUnavailable | IntrospectionThrottled> {
  const verified = yield* verifyLocally(env, token);
  if (Option.isNone(verified)) return invalid;
  const local = judgeClaims(env, verified.value);
  const subject = userSubject(verified.value);
  if (local.kind === 'invalid' || Option.isNone(subject)) return invalid;
  const answer = yield* introspect(env, token, { cache: jwtAnswers, admit: meters.user(subject.value), accessToken: true });
  if (!answer.active) return invalid;
  // The bucket stays the verified token's own subject; the answer must still vouch for the resource and scope.
  if (!forThisResource(env, answer.aud) || answer.cnf !== undefined) return invalid;
  return grantsRead(answer.scope) ? local : insufficientScope;
});

/** An opaque token has nothing to check locally, so introspection must vouch for every claim a JWT would carry. */
const verifyOpaque = Effect.fnUntraced(function* (env: Env, token: string, meters: Meters): Effect.fn.Return<Verdict, AuthUnavailable | IntrospectionThrottled> {
  const answer = yield* introspect(env, token, { cache: credentialAnswers, admit: meters.address, accessToken: true });
  const now = yield* Clock.currentTimeMillis;
  if (!answer.active || answer.iss !== AUTH_ISSUER) return invalid;
  if (answer.exp === undefined || answer.exp * 1_000 <= now) return invalid;
  if (answer.token_type !== undefined && answer.token_type.toLowerCase() !== 'bearer') return invalid;
  return judgeClaims(env, answer);
});

/** A dashboard key: release/r1's introspection hook answers `{ active, sub, token_type: 'api_key', scope:
 *  'api_key' }`. Keys never carry mcp:read, so the api_key marker is what admits them. */
const verifyDashboardKey = Effect.fnUntraced(function* (env: Env, token: string, meters: Meters): Effect.fn.Return<Verdict, AuthUnavailable | IntrospectionThrottled> {
  const answer = yield* introspect(env, token, { cache: credentialAnswers, admit: meters.address, accessToken: false });
  if (!answer.active || answer.token_type !== 'api_key' || answer.sub === undefined || !SUBJECT.test(answer.sub)) return invalid;
  return user(answer.sub);
});

/** Who an Authorization header that is not a legacy key belongs to. AuthUnavailable means ctc-auth gave no clean
 *  answer (503); IntrospectionThrottled means the allowance for the minute is spent (429). */
export const identifyBearer = Effect.fn('identifyBearer')(function* (env: Env, header: string, meters: Meters): Effect.fn.Return<Verdict, AuthUnavailable | IntrospectionThrottled> {
  const token = BEARER.exec(header)?.[1];
  if (token === undefined || token.length > MAX_TOKEN_LENGTH) return invalid;
  if (DASHBOARD_KEY.test(token)) return yield* verifyDashboardKey(env, token, meters);
  // Any other ctc_ string is a mistyped key, not a token worth asking ctc-auth about.
  if (token.startsWith('ctc_')) return invalid;
  // ctc-auth's opaque tokens carry no dots, so anything dotted is a JWT or junk; either way it is checked
  // locally, and a token that fails there (alg none, a missing signature) never reaches introspection.
  if (token.includes('.')) return yield* verifyJwt(env, token, meters);
  return yield* verifyOpaque(env, token, meters);
});

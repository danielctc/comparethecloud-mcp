import { Clock, Effect, Option, Predicate, Schema } from 'effect';
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { Env } from '../env';
import { readUpTo } from './body';

/**
 * OAuth sign-in for the MCP Worker (plan comparethecloud-mcp-oauth-plan-v1.md, section 1, bolt M2).
 *
 * ctc-auth issues a JWT access token when the client named this server as its `resource`, and an opaque one
 * otherwise. A JWT is verified here against the issuer's JWKS, then checked for revocation through RFC 7662
 * introspection; an opaque token and a dashboard API key can only be checked by introspection. Every answer is
 * cached for at most 60 seconds (CT-5), so a disconnected client is refused within a minute.
 */
export const AUTH_ISSUER = 'https://auth.comparethecloud.net';
const JWKS_URL = `${AUTH_ISSUER}/api/auth/jwks`;
const INTROSPECTION_URL = `${AUTH_ISSUER}/api/auth/oauth2/introspect`;
export const RESOURCE_PATH = '/auth/mcp';
export const METADATA_PATH = `/.well-known/oauth-protected-resource${RESOURCE_PATH}`;
/** The resource identifier: the URL a client connects to, and the audience its token must carry. */
export const resourceId = (env: Env) => `${env.PUBLIC_ORIGIN}${RESOURCE_PATH}`;
export const metadataUrl = (env: Env) => `${env.PUBLIC_ORIGIN}${METADATA_PATH}`;
/** Off unless exactly "true": the string "false" is truthy, and a typo must leave sign-in off. */
export const oauthEnabled = (env: Env) => env.OAUTH_ENABLED === 'true';

/** RFC 9728 metadata for /auth/mcp. Nothing like it is served for /mcp: the no-auth listings stay no-auth. */
export const protectedResourceMetadata = (env: Env) => ({
  resource: resourceId(env),
  authorization_servers: [AUTH_ISSUER],
  scopes_supported: ['openid', 'email', 'offline_access', 'mcp:read'],
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
const INTROSPECTION_BREAKER_MS = 10_000;
const INTROSPECTION_CACHE_MS = 60_000;
const MAX_CACHED = 5_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 65_536;

export class AuthUnavailable extends Schema.TaggedError<AuthUnavailable>()('AuthUnavailable', {}) {}
/** The caller's address has asked ctc-auth about too many unknown credentials this minute. */
export class IntrospectionThrottled extends Schema.TaggedError<IntrospectionThrottled>()('IntrospectionThrottled', {}) {}
/** Spends one of the caller address's introspections for this minute; true when it may go ahead. */
export type Admit = Effect.Effect<boolean, unknown>;
class IntrospectionUnavailable extends Schema.TaggedError<IntrospectionUnavailable>()('IntrospectionUnavailable', {
  reason: Schema.String,
}) {}

/** The user a credential belongs to, or none when it must be refused with 401. */
export type Identity = Option.Option<string>;
const refused: Identity = Option.none();

const Introspection = Schema.Struct({
  active: Schema.Boolean,
  sub: Schema.optionalKey(Schema.String),
  aud: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  iss: Schema.optionalKey(Schema.String),
  exp: Schema.optionalKey(Schema.Number),
  client_id: Schema.optionalKey(Schema.String),
  azp: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String),
  cnf: Schema.optionalKey(Schema.Unknown),
});
type Introspection = typeof Introspection.Type;
const decodeIntrospection = Schema.decodeUnknownEffect(Schema.fromJsonString(Introspection));

const audiences = (aud: string | readonly string[] | undefined) => aud === undefined ? [] : Predicate.isString(aud) ? [aud] : aud;
/** A user's token: a safe subject that is not the client itself. A client-credentials token carries the client
 *  id as `sub`, and a token naming no client cannot be told apart from one, so both are refused. */
const userSubject = (claims: { sub?: unknown; client_id?: unknown; azp?: unknown }): Option.Option<string> => {
  const { sub, client_id: clientId, azp } = claims;
  if (!Predicate.isString(sub) || !SUBJECT.test(sub)) return Option.none();
  if (!Predicate.isString(clientId) && !Predicate.isString(azp)) return Option.none();
  return sub === clientId || sub === azp ? Option.none() : Option.some(sub);
};

/** An outage: no answer or a 5xx, or the breaker still open after one. Anything else fails closed: missing or
 *  refused credentials and an unreadable answer are faults in this Worker's set-up, and a 429 is ctc-auth up
 *  but refusing this client, which junk-token traffic could otherwise use to switch revocation off. */
const isOutage = (reason: string) => reason === 'unreachable' || reason === 'circuit_open' || /^http_5\d\d$/.test(reason);
/** The longest-lived token served without a revocation check: ctc-auth's access-token lifetime. */
const FAIL_OPEN_MAX_LIFETIME_S = 900;
/** Fail-open events: a locally valid JWT served without a revocation check. One log line per event, so Workers
 *  Logs can count and alert on them; M1b's Analytics Engine row replaces this sink. */
const countFailOpen = (reason: string) => Effect.sync(() => {
  console.warn(JSON.stringify({ event: 'oauth_introspection_fail_open', reason }));
});

// Per-isolate caches. The JWKS is public; introspection answers are keyed on a SHA-256 of the token, never the
// token itself, and bounded so a spray of junk tokens cannot grow the isolate's memory.
let jwks: ReturnType<typeof createLocalJWKSet> | undefined;
/** When the key set is next fetched: 10 minutes after a good fetch, 60 seconds after a failed refresh of keys
 *  already held, 10 seconds after a failed first fetch. */
let refreshAt = -Infinity;
let lastForcedAt = -Infinity;
/** After an outage, introspection is not attempted again for 10 seconds, so requests do not each wait out a timeout. */
let introspectionDownUntil = -Infinity;
const introspections = new Map<string, { answer: Introspection; until: number }>();
/** Tests start each case with an empty isolate. */
export const resetOAuthCaches = () => {
  jwks = undefined; refreshAt = -Infinity; lastForcedAt = -Infinity; introspectionDownUntil = -Infinity; introspections.clear();
};

const fetchJson = Effect.fnUntraced(function* (input: string, init: RequestInit) {
  const response = yield* Effect.tryPromise({
    try: () => fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    catch: () => new IntrospectionUnavailable({ reason: 'unreachable' }),
  });
  if (response.status !== 200) {
    yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());
    return yield* new IntrospectionUnavailable({ reason: `http_${response.status}` });
  }
  return yield* readUpTo(response.body, MAX_RESPONSE_BYTES).pipe(
    Effect.mapError(() => new IntrospectionUnavailable({ reason: 'bad_response' })),
  );
});

const loadJwks = Effect.fnUntraced(function* (force: boolean) {
  const now = yield* Clock.currentTimeMillis;
  const due = force && jwks ? now - lastForcedAt >= JWKS_FORCED_COOLDOWN_MS : now >= refreshAt;
  if (!due) return jwks ?? (yield* new AuthUnavailable({}));
  if (force) lastForcedAt = now;
  const fetched = yield* fetchJson(JWKS_URL, { headers: { Accept: 'application/json' } }).pipe(
    Effect.flatMap(text => Effect.try({
      // SAFETY: createLocalJWKSet validates the set's shape itself and throws on anything that is not one.
      try: () => createLocalJWKSet(JSON.parse(text) as JSONWebKeySet), catch: () => new AuthUnavailable({}),
    })),
    Effect.option,
  );
  // A failed refresh keeps the last good keys, so a warm isolate still verifies while ctc-auth is down. With
  // none ever fetched there is nothing to verify against, so the request fails closed.
  if (Option.isSome(fetched)) jwks = fetched.value;
  refreshAt = now + (Option.isSome(fetched) ? JWKS_FRESH_MS : jwks ? JWKS_FORCED_COOLDOWN_MS : JWKS_RETRY_MS);
  return jwks ?? (yield* new AuthUnavailable({}));
});

const sha256 = (token: string) => Effect.promise(async () => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
});

/** Cache an answer: never past the token's own expiry, never longer than 60 seconds. When the cache is full,
 *  expired answers go first; only a cache full of live ones loses its oldest entry. */
const remember = (key: string, answer: Introspection, now: number) => {
  const expiry = answer.active && answer.exp !== undefined ? answer.exp * 1_000 : Infinity;
  if (introspections.size >= MAX_CACHED) {
    for (const [stale, entry] of introspections) if (entry.until <= now) introspections.delete(stale);
    if (introspections.size >= MAX_CACHED) introspections.delete(introspections.keys().next().value ?? '');
  }
  introspections.delete(key);
  introspections.set(key, { answer, until: Math.min(now + INTROSPECTION_CACHE_MS, expiry) });
};

/** Ask ctc-auth about a token with the Worker's own client (CT-5), through a cache of at most 60 seconds. */
const introspect = Effect.fnUntraced(function* (env: Env, token: string, accessToken: boolean, admit?: Admit) {
  const now = yield* Clock.currentTimeMillis;
  const key = yield* sha256(token);
  const cached = introspections.get(key);
  if (cached && cached.until > now) return cached.answer;
  if (now < introspectionDownUntil) return yield* new IntrospectionUnavailable({ reason: 'circuit_open' });
  // Only a cache miss costs ctc-auth anything, so only a miss spends the address's allowance. A limiter that
  // cannot answer denies.
  if (admit && !(yield* admit.pipe(Effect.mapError(() => new IntrospectionUnavailable({ reason: 'limiter' }))))) {
    return yield* new IntrospectionThrottled({});
  }
  if (!env.CTC_MCP_CLIENT_ID || !env.CTC_MCP_CLIENT_SECRET) return yield* new IntrospectionUnavailable({ reason: 'not_configured' });
  const form = new URLSearchParams({ token });
  if (accessToken) form.set('token_type_hint', 'access_token');
  form.set('client_id', env.CTC_MCP_CLIENT_ID);
  form.set('client_secret', env.CTC_MCP_CLIENT_SECRET);
  const text = yield* fetchJson(INTROSPECTION_URL, {
    method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  }).pipe(Effect.tapError(error => Effect.sync(() => {
    if (isOutage(error.reason)) introspectionDownUntil = now + INTROSPECTION_BREAKER_MS;
  })));
  const answer = yield* decodeIntrospection(text).pipe(Effect.mapError(() => new IntrospectionUnavailable({ reason: 'bad_response' })));
  remember(key, answer, now);
  return answer;
});

/** The local half of a JWT check: signature against the JWKS, issuer, audience, typ, expiry. None means the
 *  token is bad (401); AuthUnavailable means there were no keys to check it against (503). */
const verifyLocally = Effect.fnUntraced(function* (env: Env, token: string): Effect.fn.Return<Option.Option<JWTPayload>, AuthUnavailable> {
  // A token whose header is unreadable or names an algorithm this server never accepts is refused before any
  // key is fetched.
  const header = Option.liftThrowable(decodeProtectedHeader)(token);
  if (Option.isNone(header) || !Predicate.isString(header.value.alg) || !ALGORITHMS.includes(header.value.alg)) return Option.none();
  const now = yield* Clock.currentTimeMillis;
  const verify = (force: boolean) => loadJwks(force).pipe(Effect.flatMap(keys => Effect.tryPromise({
    try: () => jwtVerify(token, keys, {
      issuer: AUTH_ISSUER, audience: resourceId(env), algorithms: ALGORITHMS, typ: 'at+jwt',
      requiredClaims: ['sub', 'exp', 'iat'], currentDate: new Date(now),
    }),
    catch: cause => cause,
  })));
  return yield* verify(false).pipe(
    // An unknown kid is a rotation or a forgery. One refetch a minute settles which; inside that minute the
    // answer is a retryable 503, so a client holding a token from a just-rotated key does not discard it.
    Effect.catch(cause => !(cause instanceof errors.JWKSNoMatchingKey) ? Effect.fail(cause)
      : now - lastForcedAt >= JWKS_FORCED_COOLDOWN_MS ? verify(true) : Effect.fail(new AuthUnavailable({}))),
    Effect.map(result => Option.some(result.payload)),
    // Only a missing key set is ctc-auth's fault; every other failure is the token's.
    Effect.catch(cause => cause instanceof AuthUnavailable ? Effect.fail(cause) : Effect.succeed(Option.none<JWTPayload>())),
  );
});

/** The one deliberate exception to deny-on-error (SEC-15), required by ctc-auth intent.md:22 ("people already
 *  logged in stay logged in if the login service is briefly down") and plan section 1. A locally verified JWT is
 *  served without its revocation check only during an outage, and only if it lives no longer than ctc-auth's
 *  15 minutes; every other failure in this file denies. */
const mayFailOpen = (claims: JWTPayload, reason: string) => isOutage(reason)
  && Predicate.isNumber(claims.exp) && Predicate.isNumber(claims.iat) && claims.exp - claims.iat <= FAIL_OPEN_MAX_LIFETIME_S;

const verifyJwt = Effect.fnUntraced(function* (env: Env, token: string): Effect.fn.Return<Identity, AuthUnavailable> {
  const verified = yield* verifyLocally(env, token);
  if (Option.isNone(verified)) return refused;
  const claims = verified.value;
  // A sender-constrained token is not a bearer token; this server cannot check its proof.
  if (claims.cnf !== undefined) return refused;
  const subject = userSubject(claims);
  if (Option.isNone(subject)) return refused;
  return yield* introspect(env, token, true).pipe(
    Effect.map(answer => answer.active ? subject : refused),
    Effect.catchTag('IntrospectionUnavailable', error => mayFailOpen(claims, error.reason)
      ? countFailOpen(error.reason).pipe(Effect.as(subject))
      : Effect.fail(new AuthUnavailable({}))),
    // Never raised here: a JWT's introspection is not metered (no admit), because a forged one never gets this far.
    Effect.catchTag('IntrospectionThrottled', () => Effect.fail(new AuthUnavailable({}))),
  );
});

/** Introspection for a credential with nothing to check locally: no answer means 503, never a pass. Unlike a
 *  JWT, which must pass a signature check first, any random string reaches this, so each miss is metered. */
const vouch = (env: Env, token: string, accessToken: boolean, admit: Admit) => introspect(env, token, accessToken, admit).pipe(
  Effect.catchTag('IntrospectionUnavailable', () => Effect.fail(new AuthUnavailable({}))),
);

/** An opaque token has nothing to check locally, so introspection must vouch for every claim a JWT would carry. */
const verifyOpaque = Effect.fnUntraced(function* (env: Env, token: string, admit: Admit): Effect.fn.Return<Identity, AuthUnavailable | IntrospectionThrottled> {
  const answer = yield* vouch(env, token, true, admit);
  const now = yield* Clock.currentTimeMillis;
  if (!answer.active || answer.iss !== AUTH_ISSUER || !audiences(answer.aud).includes(resourceId(env))) return refused;
  if (answer.exp === undefined || answer.exp * 1_000 <= now) return refused;
  if (answer.cnf !== undefined || (answer.token_type !== undefined && answer.token_type.toLowerCase() !== 'bearer')) return refused;
  return userSubject(answer);
});

/** A dashboard key: release/r1's introspection hook answers `{ active, sub, token_type: 'api_key' }`. */
const verifyDashboardKey = Effect.fnUntraced(function* (env: Env, token: string, admit: Admit): Effect.fn.Return<Identity, AuthUnavailable | IntrospectionThrottled> {
  const answer = yield* vouch(env, token, false, admit);
  if (!answer.active || answer.token_type !== 'api_key' || answer.sub === undefined || !SUBJECT.test(answer.sub)) return refused;
  return Option.some(answer.sub);
});

/** Who an Authorization header that is not a legacy key belongs to. None means 401; AuthUnavailable means
 *  ctc-auth could not vouch for a credential that needs it (503); IntrospectionThrottled means the address has
 *  spent its introspections for the minute (429). */
export const identifyBearer = Effect.fn('identifyBearer')(function* (env: Env, header: string, admit: Admit): Effect.fn.Return<Identity, AuthUnavailable | IntrospectionThrottled> {
  const token = BEARER.exec(header)?.[1];
  if (token === undefined || token.length > MAX_TOKEN_LENGTH) return refused;
  if (DASHBOARD_KEY.test(token)) return yield* verifyDashboardKey(env, token, admit);
  // Any other ctc_ string is a mistyped key, not a token worth asking ctc-auth about.
  if (token.startsWith('ctc_')) return refused;
  // ctc-auth's opaque tokens carry no dots, so anything dotted is a JWT or junk; either way it is checked
  // locally, and a token that fails there (alg none, a missing signature) never reaches introspection.
  if (token.includes('.')) return yield* verifyJwt(env, token);
  return yield* verifyOpaque(env, token, admit);
});

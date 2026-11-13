import { Predicate } from 'effect';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import { vi } from 'vitest';

/** A stand-in for auth.comparethecloud.net: a JWKS from a key generated at run time, and RFC 7662
 *  introspection that answers the way release/r1 does (JWT payload plus `active`, the API-key hook's
 *  `{ active, sub, token_type: 'api_key' }`, `{ active: false }` for anything it does not know). No key or
 *  token is ever written down: gitleaks would rightly flag one. */
export const ISSUER = 'https://auth.comparethecloud.net';
export const RESOURCE = 'https://mcp.comparethecloud.net/auth/mcp';
export const USERINFO = `${ISSUER}/api/auth/oauth2/userinfo`;
export const CLIENT = { id: 'ctc-mcp', secret: 'test-introspection-secret' };

/** The fields of an RFC 7662 answer these tests set. */
export interface Introspected {
  active: boolean; sub?: string; aud?: string | string[]; iss?: string; exp?: number; iat?: number;
  client_id?: string; azp?: string; scope?: string; token_type?: string; cnf?: { jkt: string };
}
type Outage = { kind: 'none' } | { kind: 'unreachable' } | { kind: 'status'; status: number };
type Signer = { kid: string; privateKey: CryptoKey; jwk: JWK };
const signer = async (kid: string): Promise<Signer> => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { kid, privateKey, jwk: { ...await exportJWK(publicKey), kid, alg: 'EdDSA' } };
};

export async function testAuthServer() {
  let current = await signer('key-1');
  let published: Signer[] = [current];
  /** Tokens ctc-auth no longer considers active: revoked, or a session that ended. */
  const revoked = new Set<string>();
  /** Opaque tokens and dashboard keys, with what introspection says about each. */
  const records = new Map<string, Introspected>();
  /** How introspection fails, if it does: a thrown fetch (unreachable) or an HTTP status. */
  let outage: Outage = { kind: 'none' };
  let jwksDown = false;
  /** While set, JWKS answers wait on it, so a test can hold a fetch in flight. */
  let jwksHold: Promise<void> | undefined;
  const introspections: URLSearchParams[] = [];
  let jwksFetches = 0;

  const now = () => Math.floor(Date.now() / 1_000);
  /** A user access token as release/r1 mints it: typ at+jwt, both audiences when openid is granted. */
  const mint = async (claims: JWTPayload = {}, options: { typ?: string; alg?: string; key?: Signer; kid?: string } = {}) => {
    const key = options.key ?? current;
    return new SignJWT({ sub: 'user_123', aud: [RESOURCE, USERINFO], client_id: 'claude-ai', azp: 'claude-ai',
      scope: 'openid email offline_access mcp:read', iss: ISSUER, iat: now(), exp: now() + 900, ...claims })
      .setProtectedHeader({ alg: options.alg ?? 'EdDSA', kid: options.kid ?? key.kid, typ: options.typ ?? 'at+jwt' })
      .sign(key.privateKey);
  };
  /** Publish a new signing key and sign with it from now on; the old one stays published unless dropped. */
  const rotate = async (dropOld = false) => {
    current = await signer(`key-${published.length + 1}`);
    published = dropOld ? [current] : [...published, current];
    return current;
  };

  const jwksRoute = async () => {
    jwksFetches += 1;
    await jwksHold;
    if (jwksDown) throw new TypeError('fetch failed');
    return Response.json({ keys: published.map(entry => entry.jwk) });
  };
  /** What release/r1 says about a token once the caller has authenticated. */
  const answerFor = (token: string): Introspected => {
    if (revoked.has(token)) return { active: false };
    const record = records.get(token);
    if (record) return record;
    if (token.split('.').length !== 3) return { active: false };
    const payload = decodeJwt(token);
    if (Predicate.isNumber(payload.exp) && payload.exp < now()) return { active: false };
    return { ...payload, active: true, client_id: Predicate.isString(payload.azp) ? payload.azp : undefined, token_type: 'Bearer' };
  };
  const introspectRoute = async (request: Request) => {
    const form = new URLSearchParams(await request.text());
    introspections.push(form);
    if (outage.kind === 'unreachable') throw new TypeError('fetch failed');
    if (outage.kind === 'status') return Response.json({ error: 'server_error' }, { status: outage.status });
    if (form.get('client_id') !== CLIENT.id || form.get('client_secret') !== CLIENT.secret) {
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    }
    return Response.json(answerFor(form.get('token') ?? ''));
  };
  const handle = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/auth/jwks' && request.method === 'GET') return jwksRoute();
    if (pathname === '/api/auth/oauth2/introspect' && request.method === 'POST') return introspectRoute(request);
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  return {
    mint, rotate, revoked, records, introspections,
    publicKeys: () => published.map(entry => entry.jwk),
    /** A token's claims, to build an introspection answer that differs from them. */
    decode: (token: string): Introspected => ({ ...decodeJwt(token), active: true }),
    get jwksFetches() { return jwksFetches; },
    set outage(value: Outage) { outage = value; },
    set jwksDown(value: boolean) { jwksDown = value; },
    /** Hold every JWKS answer until the returned function is called. */
    holdJwks: () => {
      let release = () => {};
      jwksHold = new Promise(resolve => { release = resolve; });
      return () => { jwksHold = undefined; release(); };
    },
    /** A token from someone else's key, under a kid this server publishes or not. */
    forge: async (claims: JWTPayload = {}, kid = current.kid) => mint(claims, { key: await signer(kid), kid }),
    handle: vi.fn(handle),
  };
}
export type TestAuthServer = Awaited<ReturnType<typeof testAuthServer>>;

/** One fetch for the whole test: auth.comparethecloud.net goes to the test server, everything else to www. */
export const routeFetch = (server: TestAuthServer, upstream: (input: URL | string, init?: RequestInit) => Promise<Response>) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === ISSUER) return server.handle(request);
    return upstream(input instanceof Request ? input.url : input, init);
  });

/** A dashboard key the way release/r1 makes one: ctc_ plus 32 random bytes in base64url (43 characters). */
export const dashboardKey = () => `ctc_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;

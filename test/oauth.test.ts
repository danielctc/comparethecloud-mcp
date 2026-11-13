import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetOAuthCaches } from '../src/core/oauth';
import { CLIENT, dashboardKey, ISSUER, RESOURCE, routeFetch, testAuthServer, USERINFO, type Introspected, type TestAuthServer } from './auth-server';
import { createExecutionContext, mockEnv } from './helpers';

const origin = 'https://mcp.comparethecloud.net';
const METADATA = `${origin}/.well-known/oauth-protected-resource/auth/mcp`;
const CHALLENGE = `Bearer resource_metadata="${METADATA}"`;
const INVALID = `${CHALLENGE}, error="invalid_token"`;
const upstream = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
  Response.json({ hits: [{ name: 'Example', slug: 'example', location: 'London' }], estimatedTotalHits: 1 }));
const initialise = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1.0.0' } } });
const listTools = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const search = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_providers', arguments: { q: 'cloud' } } });

let server: TestAuthServer;
/** OAuth on unless a flag value (or its absence) is passed. */
const setup = (flag: { value?: string } = { value: 'true' }) => {
  const mocked = mockEnv();
  mocked.env.OAUTH_ENABLED = flag.value;
  mocked.env.CTC_MCP_CLIENT_ID = CLIENT.id;
  mocked.env.CTC_MCP_CLIENT_SECRET = CLIENT.secret;
  return mocked;
};
const headersFor = (token?: string) => {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'Mcp-Protocol-Version': '2025-11-25', Host: 'mcp.comparethecloud.net', 'CF-Connecting-IP': '192.0.2.20' });
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
  return headers;
};
const call = (env: ReturnType<typeof mockEnv>['env'], path: string, init: { token?: string; body?: string; method?: string } = {}) => {
  const method = init.method ?? 'POST';
  const headers = headersFor(init.token);
  const body = method === 'GET' || method === 'OPTIONS' ? null : init.body ?? initialise;
  return worker.fetch(new Request(`${origin}${path}`, { method, headers, body }), env, createExecutionContext());
};
const rlKeys = (env: ReturnType<typeof mockEnv>['env']) => vi.mocked(env.RL_KEY.limit).mock.calls.map(([options]) => options.key);
const authCalls = () => server.handle.mock.calls.length;
/** Let other requests' timers and I/O run: only Date is ever faked here, so this is real time. */
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
const sha256Hex = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');

beforeEach(async () => {
  resetOAuthCaches();
  server = await testAuthServer();
  vi.stubGlobal('fetch', routeFetch(server, upstream));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('protected resource metadata', () => {
  it('describes /auth/mcp only (RFC 9728)', async () => {
    const { env } = setup();
    const response = await call(env, '/.well-known/oauth-protected-resource/auth/mcp', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({
      resource: RESOURCE, authorization_servers: [ISSUER],
      scopes_supported: ['openid', 'email', 'offline_access', 'mcp:read'], bearer_methods_supported: ['header'],
    });
  });
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'])(
    'serves nothing at %s, so no client starts sign-in for /mcp', async path => {
      const { env } = setup();
      const response = await call(env, path, { method: 'GET' });
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
    });
  it.each([undefined, 'false', 'TRUE', '1'])('is absent, as is /auth/mcp, unless OAUTH_ENABLED is exactly "true" (%s)', async flag => {
    const { env } = setup({ value: flag });
    for (const [path, method] of [['/.well-known/oauth-protected-resource/auth/mcp', 'GET'], ['/auth/mcp', 'POST'], ['/auth/mcp', 'OPTIONS']] as const) {
      const response = await call(env, path, { method, token: method === 'POST' ? await server.mint() : undefined });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect([...response.headers.keys()], `${method} ${path}`).toEqual(['content-type']);
      expect(await response.text()).toBe('{"error":"not_found"}');
    }
    expect(authCalls()).toBe(0);
  });
});

describe('/auth/mcp', () => {
  it('challenges a caller with no token, without spending a rate-limit token', async () => {
    const { env } = setup();
    const response = await call(env, '/auth/mcp');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(CHALLENGE);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
    expect(env.RL_ANON.limit).not.toHaveBeenCalled(); expect(env.RL_KEY.limit).not.toHaveBeenCalled();
    expect(authCalls()).toBe(0);
  });
  it.each([['a Basic header', 'Basic Zm9vOmJhcg=='], ['an empty header', '']])(
    'treats %s as no bearer token: the plain challenge, with no error code (RFC 6750 3.1)', async (_name, authorization) => {
      const { env } = setup();
      const response = await worker.fetch(new Request(`${origin}/auth/mcp`, { method: 'POST', body: initialise,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: 'mcp.comparethecloud.net', Authorization: authorization } }),
      env, createExecutionContext());
      expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBe(CHALLENGE);
    });
  it('serves a legacy emailed key on /auth/mcp too, on its unchanged k: bucket', async () => {
    const { env, values } = setup(); const key = `ctc_${'b'.repeat(40)}`;
    values.set(`key:${await sha256Hex(key)}`, JSON.stringify({ name: 'Legacy', email: 'legacy@example.test', org: '', use: 'test',
      createdAt: '2026-11-06T12:00:00.000Z', tier: 'registered', status: 'active' }));
    const response = await call(env, '/auth/mcp', { token: key });
    expect(response.status).toBe(200); expect(rlKeys(env)).toEqual([`k:${await sha256Hex('legacy@example.test')}`]);
    expect(authCalls()).toBe(0);
  });
  it('answers a preflight with the challenge header exposed', async () => {
    const { env } = setup();
    const response = await call(env, '/auth/mcp', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
  });
  it('serves the same tools as /mcp at the signed-in tier, bucketed on the user', async () => {
    const { env } = setup();
    const token = await server.mint();
    const response = await call(env, '/auth/mcp', { token });
    expect(response.status).toBe(200);
    expect(response.headers.get('X-CTC-Tier')).toBe('registered');
    expect(response.headers.get('X-RateLimit-Policy')).toBe('600;w=60');
    const tools = await (await call(env, '/auth/mcp', { token, body: listTools })).text();
    const anonymous = await (await call(setup().env, '/mcp', { body: listTools })).text();
    expect(tools).toBe(anonymous);
    expect(new Set(rlKeys(env))).toEqual(new Set(['u:user_123']));
    expect(env.RL_ANON.limit).not.toHaveBeenCalled();
  });
  it('forwards the u: bucket to www and spends the u: quota', async () => {
    const { env } = setup();
    const response = await call(env, '/auth/mcp', { token: await server.mint(), body: search });
    expect(response.status).toBe(200); await response.text();
    const forwarded = upstream.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-CTC-RL-Key'));
    expect(forwarded.length).toBeGreaterThan(0);
    expect(new Set(forwarded)).toEqual(new Set(['u:user_123']));
    expect(vi.mocked(env.QUOTA.getByName).mock.calls.map(([name]) => name)).toEqual(['u:user_123']);
  });
  it('accepts a token whose only audience is the MCP resource', async () => {
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint({ aud: RESOURCE }) })).status).toBe(200);
  });

  const refusals: [string, (s: TestAuthServer) => Promise<string>][] = [
    ['a wrong audience', s => s.mint({ aud: 'https://other.comparethecloud.net' })],
    ['only the userinfo audience', s => s.mint({ aud: [USERINFO] })],
    ['no audience (a client that sent no resource)', s => s.mint({ aud: undefined })],
    ['a lookalike audience', s => s.mint({ aud: `${RESOURCE}/` })],
    ['an expired token', s => s.mint({ iat: Math.floor(Date.now() / 1_000) - 1_000, exp: Math.floor(Date.now() / 1_000) - 1 })],
    ['another issuer', s => s.mint({ iss: 'https://auth.comparethecloud.net/' })],
    ['an ID token (typ JWT)', s => s.mint({}, { typ: 'JWT' })],
    ['no subject', s => s.mint({ sub: undefined })],
    ['an empty subject', s => s.mint({ sub: '' })],
    ['a client-credentials token (sub is the client)', s => s.mint({ sub: 'claude-ai' })],
    ['no client id at all', s => s.mint({ client_id: undefined, azp: undefined })],
    ['a subject unsafe as a bucket name', s => s.mint({ sub: 'user 123\n' })],
    ['a sender-constrained (DPoP) token', s => s.mint({ cnf: { jkt: 'thumbprint' } })],
    ['a forged signature under a published kid', s => s.forge()],
    ['a token with no expiry', s => s.mint({ exp: undefined })],
  ];
  it.each(refusals)('refuses %s with 401 and the invalid_token challenge', async (_name, make) => {
    const { env } = setup();
    const response = await call(env, '/auth/mcp', { token: await make(server) });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(INVALID);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
    // A token that fails locally never reaches introspection, so junk cannot drive calls to ctc-auth.
    expect(server.introspections).toHaveLength(0);
    expect(env.RL_KEY.limit).not.toHaveBeenCalled();
  });
  it.each([
    ['alg none', () => `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user_123', aud: RESOURCE, iss: ISSUER, exp: 9_999_999_999, client_id: 'x' })).toString('base64url')}.`],
    ['HS256 keyed with the public key', async () => {
      const { SignJWT } = await import('jose');
      const [published] = server.publicKeys();
      return new SignJWT({ sub: 'user_123', aud: RESOURCE, iss: ISSUER, client_id: 'x' }).setProtectedHeader({ alg: 'HS256', kid: published.kid, typ: 'at+jwt' })
        .setExpirationTime('5m').sign(new TextEncoder().encode(published.x));
    }],
    ['a malformed token', async () => 'not.a.jwt'],
    ['a token over 8 KB', async () => `a${'b'.repeat(8_192)}`],
    ['a ctc_ token of neither key length', async () => `ctc_${'a'.repeat(41)}`],
  ])('refuses %s', async (_name, make) => {
    const { env } = setup();
    const response = await call(env, '/auth/mcp', { token: await make() });
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBe(INVALID);
    expect(server.introspections).toHaveLength(0);
  });
  it('turns away a signed-in user on the deny list', async () => {
    const { env, values } = setup(); values.set('deny:u:user_123', '1');
    const response = await call(env, '/auth/mcp', { token: await server.mint() });
    expect(response.status).toBe(403); expect(response.headers.get('X-CTC-Tier')).toBe('registered');
  });
});

describe('JWKS', () => {
  it('fetches the keys once and reuses them', async () => {
    const { env } = setup();
    for (let i = 0; i < 3; i += 1) expect((await call(env, '/auth/mcp', { token: await server.mint({ sub: `user_${i}` }) })).status).toBe(200);
    expect(server.jwksFetches).toBe(1);
  });
  it('follows a key rotation by refetching once on an unknown kid', async () => {
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    await server.rotate(true);
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    expect(server.jwksFetches).toBe(2);
  });
  it('refetches for unknown kids at most once a minute, so forged kids cannot drive calls', async () => {
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    expect((await call(env, '/auth/mcp', { token: await server.forge({}, 'unknown-0') })).status).toBe(401);
    // Inside the minute an unknown kid could be a rotation not yet fetched, so the answer is a retryable 503.
    for (let i = 1; i < 5; i += 1) expect((await call(env, '/auth/mcp', { token: await server.forge({}, `unknown-${i}`) })).status).toBe(503);
    expect(server.jwksFetches).toBe(2);
  });
  it('answers 503, not 401, for a token from a just-rotated key while the JWKS cannot be fetched', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    await server.rotate(); server.jwksDown = true;
    vi.setSystemTime(new Date('2026-11-13T12:02:00Z'));
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(503);
  });
  it('picks up a rotation within a minute even while forged kids keep arriving', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.forge({}, 'unknown') })).status).toBe(401);
    await server.rotate();
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(503);
    vi.setSystemTime(new Date('2026-11-13T12:01:00Z'));
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
  });
  it('fails closed with 503 when no keys have ever been fetched and ctc-auth is down, retrying after 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup(); server.jwksDown = true;
    for (let i = 0; i < 3; i += 1) {
      const response = await call(env, '/auth/mcp', { token: await server.mint() });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
    }
    expect(server.jwksFetches).toBe(1);
    server.jwksDown = false; vi.setSystemTime(new Date('2026-11-13T12:00:11Z'));
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    expect(server.jwksFetches).toBe(2);
  });
  it('keeps verifying with the last good keys while the JWKS cannot be refreshed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    server.jwksDown = true;
    vi.setSystemTime(new Date('2026-11-13T12:11:00Z'));
    expect((await call(env, '/auth/mcp', { token: await server.mint({ sub: 'user_999' }) })).status).toBe(200);
  });
  it('fetches no keys for a token with an unreadable header or a refused algorithm', async () => {
    const { env } = setup();
    for (const token of ['a.b.c', `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.e30.sig`]) {
      expect((await call(env, '/auth/mcp', { token })).status).toBe(401);
    }
    expect(server.jwksFetches).toBe(0);
  });

  describe('under concurrent requests', () => {
    /** Start every request with the JWKS answer held, so the first fetch is still in flight when the rest arrive. */
    const burst = async (env: ReturnType<typeof mockEnv>['env'], tokens: string[]) => {
      const release = server.holdJwks();
      const pending = tokens.map(token => call(env, '/auth/mcp', { token }));
      await settle();
      release();
      return (await Promise.all(pending)).map(response => response.status);
    };
    it('fetches the keys once for a burst of forged tokens at a cold start', async () => {
      const { env } = setup();
      const tokens = await Promise.all(Array.from({ length: 25 }, (_, i) => server.forge({ sub: `user_${i}` })));
      expect(await burst(env, tokens)).toEqual(Array(25).fill(401));
      expect(server.jwksFetches).toBe(1);
      expect(server.introspections).toHaveLength(0);
    });
    it('fetches once for a cold-start burst while ctc-auth is down, and holds the 10-second retry', async () => {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
      const { env } = setup(); server.jwksDown = true;
      const tokens = await Promise.all(Array.from({ length: 25 }, (_, i) => server.mint({ sub: `user_${i}` })));
      expect(await burst(env, tokens)).toEqual(Array(25).fill(503));
      expect(server.jwksFetches).toBe(1);
      vi.setSystemTime(new Date('2026-11-13T12:00:05Z'));
      expect((await call(env, '/auth/mcp', { token: tokens[0] })).status).toBe(503);
      expect(server.jwksFetches).toBe(1);
      server.jwksDown = false; vi.setSystemTime(new Date('2026-11-13T12:00:11Z'));
      expect((await call(env, '/auth/mcp', { token: tokens[0] })).status).toBe(200);
      expect(server.jwksFetches).toBe(2);
    });
    it('refreshes once for a burst when the keys fall due, serving the rest on the keys it holds', async () => {
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
      const { env } = setup();
      expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
      vi.setSystemTime(new Date('2026-11-13T12:11:00Z'));
      const tokens = await Promise.all(Array.from({ length: 25 }, (_, i) => server.mint({ sub: `user_${i}` })));
      expect(await burst(env, tokens)).toEqual(Array(25).fill(200));
      expect(server.jwksFetches).toBe(2);
    });
    it('refetches once for a burst from a just-rotated key: the rest get a retryable 503, never a 401', async () => {
      const { env } = setup();
      expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
      await server.rotate(true);
      const tokens = await Promise.all(Array.from({ length: 5 }, (_, i) => server.mint({ sub: `user_${i}` })));
      const statuses = await burst(env, tokens);
      // 200 for whoever saw the new keys, a retryable 503 for the rest; any other status fails.
      expect(statuses.filter(status => status !== 200 && status !== 503)).toEqual([]);
      expect(statuses).toContain(200);
      expect(server.jwksFetches).toBe(2);
    });
    it('lets at most 32 requests wait on a cold fetch: the rest get a retryable 503 at once, not a timer each', async () => {
      const { env } = setup();
      const tokens = await Promise.all(Array.from({ length: 40 }, (_, i) => server.forge({ sub: `user_${i}` })));
      const release = server.holdJwks();
      const early: number[] = [];
      const pending = tokens.map(token => call(env, '/auth/mcp', { token }).then(response => { early.push(response.status); return response.status; }));
      await settle();
      // The overflow is answered while the fetch is still held, so it never waited.
      expect(early).toEqual(Array(7).fill(503));
      release();
      const statuses = await Promise.all(pending);
      expect(statuses.filter(status => status === 401)).toHaveLength(33);
      expect(server.jwksFetches).toBe(1);
    });
  });
});

describe('JWKS after a failed fetch', () => {
  it('does not refetch for an unknown kid in the same request whose scheduled refresh just failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    server.jwksDown = true; vi.setSystemTime(new Date('2026-11-13T12:11:00Z'));
    expect((await call(env, '/auth/mcp', { token: await server.forge({}, 'unknown') })).status).toBe(503);
    expect(server.jwksFetches).toBe(2);
  });
  it('holds the failure backoff for an unknown kid that follows a failed scheduled refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
    server.jwksDown = true; vi.setSystemTime(new Date('2026-11-13T12:11:00Z'));
    expect((await call(env, '/auth/mcp', { token: await server.mint({ sub: 'user_2' }) })).status).toBe(200);
    expect(server.jwksFetches).toBe(2);
    vi.setSystemTime(new Date('2026-11-13T12:11:30Z'));
    expect((await call(env, '/auth/mcp', { token: await server.forge({}, 'unknown') })).status).toBe(503);
    expect(server.jwksFetches).toBe(2);
    // Once the backoff ends: the scheduled refresh, then the unknown kid's own refetch.
    server.jwksDown = false; vi.setSystemTime(new Date('2026-11-13T12:12:01Z'));
    expect((await call(env, '/auth/mcp', { token: await server.forge({}, 'unknown') })).status).toBe(401);
    expect(server.jwksFetches).toBe(4);
  });
});

describe('slow uploads', () => {
  /** A tools/call whose body arrives in two parts, the second only when `finish` is called. */
  const slowCall = (env: ReturnType<typeof mockEnv>['env'], token?: string, path = '/auth/mcp') => {
    const bytes = new TextEncoder().encode(search);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    controller?.enqueue(bytes.slice(0, 16));
    const response = worker.fetch(new Request(`${origin}${path}`, { method: 'POST', headers: headersFor(token), body, duplex: 'half' } as RequestInit),
      env, createExecutionContext());
    return { response, finish: () => { controller?.enqueue(bytes.slice(16)); controller?.close(); } };
  };
  /** The response if it arrives within a second of real time, otherwise 'pending': a refusal that waited for the
   *  body would never arrive, since these uploads are never finished. */
  const promptly = (response: Promise<Response>) =>
    Promise.race([response.then(r => r.status), new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 1_000))]);
  it.each<[string, (mocked: ReturnType<typeof setup>) => Promise<{ token?: string; path?: string; status: number }>]>([
    ['a no-token caller over its minute rate', async ({ env }) => {
      vi.mocked(env.RL_ANON.limit).mockResolvedValue({ success: false }); return { path: '/mcp', status: 429 };
    }],
    ['a no-token caller on the deny list', async ({ values }) => {
      values.set('deny:ip:192.0.2.20', '1'); return { path: '/mcp', status: 403 };
    }],
    ['a forged token', async () => ({ token: await server.forge(), status: 401 })],
    ['a signed-in caller over its minute rate', async ({ env }) => {
      vi.mocked(env.RL_KEY.limit).mockResolvedValue({ success: false }); return { token: await server.mint(), status: 429 };
    }],
  ])('refuses %s before reading any of its upload', async (_name, arrange) => {
    const mocked = setup();
    const { token, path, status } = await arrange(mocked);
    expect(await promptly(slowCall(mocked.env, token, path).response)).toBe(status);
  });
  it('answers 408 to an upload that has not finished within 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { env } = setup();
    const upload = slowCall(env, undefined, '/mcp');
    for (let i = 0; i < 50; i += 1) await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await upload.response;
    expect(response.status).toBe(408); expect(await response.json()).toEqual({ error: 'request_timeout' });
    expect(response.headers.get('X-CTC-Tier')).toBe('anonymous');
  });
  it('authorise once the body has arrived, so a grant withdrawn during the upload stops the tool', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup(); const token = await server.mint();
    expect((await call(env, '/auth/mcp', { token })).status).toBe(200);
    const served = upstream.mock.calls.length;
    const upload = slowCall(env, token);
    await settle();
    server.revoked.add(token);
    vi.setSystemTime(new Date('2026-11-13T12:02:00Z'));
    upload.finish();
    const response = await upload.response;
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBe(INVALID);
    expect(upstream.mock.calls.length).toBe(served);
  });
  it('still serve a slow upload from a caller whose grant stands', async () => {
    const { env } = setup(); const token = await server.mint();
    const served = upstream.mock.calls.length;
    const upload = slowCall(env, token);
    await settle();
    upload.finish();
    const response = await upload.response;
    expect(response.status).toBe(200); await response.text();
    expect(upstream.mock.calls.length).toBeGreaterThan(served);
  });
});

describe('introspection', () => {
  it('asks ctc-auth with the Worker credentials and the access-token hint', async () => {
    const { env } = setup(); const token = await server.mint();
    expect((await call(env, '/auth/mcp', { token })).status).toBe(200);
    expect(server.introspections).toHaveLength(1);
    expect(Object.fromEntries(server.introspections[0])).toEqual({ token, token_type_hint: 'access_token', client_id: CLIENT.id, client_secret: CLIENT.secret });
  });
  it('refuses a revoked token with 401', async () => {
    const { env } = setup(); const token = await server.mint(); server.revoked.add(token);
    const response = await call(env, '/auth/mcp', { token });
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBe(INVALID);
  });
  it('caches an answer for at most 60 seconds, so a revocation lands within the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const { env } = setup(); const token = await server.mint();
    expect((await call(env, '/auth/mcp', { token })).status).toBe(200);
    server.revoked.add(token);
    vi.setSystemTime(new Date('2026-11-13T12:00:30Z'));
    expect((await call(env, '/auth/mcp', { token })).status).toBe(200);
    expect(server.introspections).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-13T12:01:00.500Z'));
    expect((await call(env, '/auth/mcp', { token })).status).toBe(401);
    expect(server.introspections).toHaveLength(2);
  });
  it('caches a refusal too, so a replayed dead token does not hit ctc-auth each time', async () => {
    const { env } = setup(); const token = await server.mint(); server.revoked.add(token);
    for (let i = 0; i < 3; i += 1) expect((await call(env, '/auth/mcp', { token })).status).toBe(401);
    expect(server.introspections).toHaveLength(1);
  });

  // Revocation design (revocation-design-fable.md, MCP Worker): introspection is mandatory, so any failure to
  // get a clean answer is a deny, never a pass. There is no fail-open and no breaker.
  it.each<[string, (s: TestAuthServer, env: ReturnType<typeof mockEnv>['env']) => void]>([
    ['ctc-auth is unreachable', s => { s.outage = { kind: 'unreachable' }; }],
    ['ctc-auth answers 503', s => { s.outage = { kind: 'status', status: 503 }; }],
    ['ctc-auth rate limits the Worker', s => { s.outage = { kind: 'status', status: 429 }; }],
    ['ctc-auth refuses the Worker credentials', s => { s.outage = { kind: 'status', status: 401 }; }],
    ['ctc-auth answers 400', s => { s.outage = { kind: 'status', status: 400 }; }],
    ['the Worker credentials are missing', (_s, env) => { env.CTC_MCP_CLIENT_SECRET = undefined; }],
  ])('denies a valid JWT with 503 when %s', async (_name, fault) => {
    const { env } = setup(); fault(server, env);
    for (const sub of ['user_1', 'user_2', 'user_3', 'user_4']) {
      const response = await call(env, '/auth/mcp', { token: await server.mint({ sub }) });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
    }
    expect(env.RL_KEY.limit).not.toHaveBeenCalled();
  });
  it('denies with 503 when introspection answers 200 with something that is not an answer', async () => {
    const { env } = setup(); const token = await server.mint();
    server.handle.mockImplementation(async request => new URL(request.url).pathname === '/api/auth/oauth2/introspect'
      ? new Response('<html>maintenance</html>', { status: 200 }) : Response.json({ keys: server.publicKeys() }));
    expect((await call(env, '/auth/mcp', { token })).status).toBe(503);
  });
  it('asks ctc-auth again on the next request after a failure: failures are not cached', async () => {
    const { env } = setup(); const token = await server.mint(); server.outage = { kind: 'unreachable' };
    expect((await call(env, '/auth/mcp', { token })).status).toBe(503);
    server.outage = { kind: 'none' };
    expect((await call(env, '/auth/mcp', { token })).status).toBe(200);
    expect(server.introspections).toHaveLength(2);
  });
  it.each<[string, Partial<Introspected>]>([
    ['inactive', { active: false }],
    ['active but for another resource', { aud: ['https://other.example'] }],
    ['active with no audience', { aud: undefined }],
  ])('refuses a signature-valid JWT that introspection says is %s', async (_name, change) => {
    const { env } = setup(); const token = await server.mint();
    server.records.set(token, { ...server.decode(token), active: true, token_type: 'Bearer', ...change });
    const response = await call(env, '/auth/mcp', { token });
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBe(INVALID);
  });
  it('accepts a JWT with no iat: no clock is compared beyond exp', async () => {
    const { env } = setup();
    expect((await call(env, '/auth/mcp', { token: await server.mint({ iat: undefined }) })).status).toBe(200);
  });
  it('meters revocation checks per user, generously, and never for a cached answer', async () => {
    const { env } = setup(); const token = await server.mint();
    for (let i = 0; i < 3; i += 1) expect((await call(env, '/auth/mcp', { token })).status).toBe(200);
    expect(vi.mocked(env.RL_INTROSPECT.limit).mock.calls).toEqual([[{ key: 'u:user_123' }]]);
    vi.mocked(env.RL_INTROSPECT.limit).mockResolvedValue({ success: false });
    const response = await call(env, '/auth/mcp', { token: await server.mint({ jti: 'another' }) });
    expect(response.status).toBe(429); expect(server.introspections).toHaveLength(1);
  });
  it('refuses an expired JWT with 401 before asking ctc-auth', async () => {
    const { env } = setup(); server.outage = { kind: 'unreachable' };
    const now = Math.floor(Date.now() / 1_000);
    expect((await call(env, '/auth/mcp', { token: await server.mint({ iat: now - 1_000, exp: now - 1 }) })).status).toBe(401);
  });
});

describe('opaque access tokens', () => {
  const opaque = 'opaqueAccessToken0123456789abcdefABCDEF';
  const active = () => ({ active: true, sub: 'user_456', aud: [RESOURCE, USERINFO], iss: ISSUER, client_id: 'chatgpt', azp: 'chatgpt',
    exp: Math.floor(Date.now() / 1_000) + 600, iat: Math.floor(Date.now() / 1_000), token_type: 'Bearer', scope: 'openid mcp:read' });
  it('accepts one that introspection says is active for the MCP resource', async () => {
    const { env } = setup(); server.records.set(opaque, active());
    const response = await call(env, '/auth/mcp', { token: opaque });
    expect(response.status).toBe(200); expect(rlKeys(env)).toEqual(['u:user_456']);
    expect(server.introspections[0].get('token_type_hint')).toBe('access_token');
  });
  it.each([
    ['inactive', { active: false }],
    ['for another resource', { aud: ['https://other.example'] }],
    ['with no audience', { aud: undefined }],
    ['from another issuer', { iss: 'https://evil.example' }],
    ['with no user', { sub: undefined }],
    ['issued to a client for itself', { sub: 'chatgpt' }],
    ['already expired', { exp: Math.floor(Date.now() / 1_000) - 1 }],
    ['with no expiry', { exp: undefined }],
    ['bound to a DPoP key', { token_type: 'DPoP', cnf: { jkt: 'thumbprint' } }],
  ])('refuses one that is %s', async (_name, change) => {
    const { env } = setup(); server.records.set(opaque, { ...active(), ...change });
    const response = await call(env, '/auth/mcp', { token: opaque });
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBe(INVALID);
  });
  it('meters introspection misses per address, so random strings cannot flood ctc-auth', async () => {
    const { env } = setup(); server.records.set(opaque, active());
    vi.mocked(env.RL_ANON.limit).mockImplementation(async ({ key }) => ({ success: !key.startsWith('introspect:') }));
    const response = await call(env, '/auth/mcp', { token: 'randomOpaqueString0123456789' });
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
    expect(server.introspections).toHaveLength(0);
    expect(env.RL_ANON.limit).toHaveBeenCalledWith({ key: 'introspect:ip:192.0.2.20' });
    expect((await call(env, '/auth/mcp', { token: dashboardKey() })).status).toBe(429);
    // A JWT is checked locally first, so it is never metered this way.
    expect((await call(env, '/auth/mcp', { token: await server.mint() })).status).toBe(200);
  });
  it('spends nothing on a cached answer', async () => {
    const { env } = setup(); server.records.set(opaque, active());
    for (let i = 0; i < 3; i += 1) expect((await call(env, '/auth/mcp', { token: opaque })).status).toBe(200);
    expect(vi.mocked(env.RL_ANON.limit).mock.calls.filter(([{ key }]) => key.startsWith('introspect:'))).toHaveLength(1);
  });
  it('fails closed with 503 when ctc-auth cannot be asked', async () => {
    const { env } = setup(); server.records.set(opaque, active()); server.outage = { kind: 'unreachable' };
    const response = await call(env, '/auth/mcp', { token: opaque });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
  });
});

describe('dashboard API keys', () => {
  it('are checked by introspection and bucketed on the user', async () => {
    const { env } = setup(); const key = dashboardKey();
    server.records.set(key, { active: true, sub: 'user_789', token_type: 'api_key', scope: 'api_key', iat: 1 });
    for (const path of ['/mcp', '/auth/mcp']) {
      const response = await call(env, path, { token: key });
      expect(response.status, path).toBe(200); expect(response.headers.get('X-CTC-Tier')).toBe('registered');
    }
    expect(new Set(rlKeys(env))).toEqual(new Set(['u:user_789']));
    expect(server.introspections).toHaveLength(1);
    expect(Object.fromEntries(server.introspections[0])).toEqual({ token: key, client_id: CLIENT.id, client_secret: CLIENT.secret });
  });
  it.each([
    ['revoked', { active: false }],
    ['answered as some other token type', { active: true, sub: 'user_789', token_type: 'Bearer' }],
    ['answered with no user', { active: true, token_type: 'api_key' }],
  ])('are refused when %s', async (_name, record) => {
    const { env } = setup(); const key = dashboardKey(); server.records.set(key, record);
    expect((await call(env, '/auth/mcp', { token: key })).status).toBe(401);
    const legacy = await call(env, '/mcp', { token: key });
    expect(legacy.status).toBe(401); expect(await legacy.json()).toEqual({ error: 'invalid_key', register: `${origin}/register` });
  });
  it('fail closed with 503 when ctc-auth is down', async () => {
    const { env } = setup(); server.outage = { kind: 'unreachable' };
    expect((await call(env, '/mcp', { token: dashboardKey() })).status).toBe(503);
  });
});

describe('scope', () => {
  const SCOPE_CHALLENGE = `Bearer error="insufficient_scope", scope="mcp:read", resource_metadata="${METADATA}"`;
  it('refuses a JWT without mcp:read with 403 insufficient_scope, after introspecting it', async () => {
    const { env } = setup();
    const response = await call(env, '/auth/mcp', { token: await server.mint({ scope: 'openid email' }) });
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toBe(SCOPE_CHALLENGE);
    expect(await response.json()).toEqual({ error: 'insufficient_scope', scope: 'mcp:read' });
    expect(server.introspections).toHaveLength(1);
    expect(env.RL_KEY.limit).not.toHaveBeenCalled();
  });
  it('tells a revoked token without mcp:read to sign in again (401), not to ask for more scope', async () => {
    const { env } = setup(); const token = await server.mint({ scope: 'openid email' }); server.revoked.add(token);
    const response = await call(env, '/auth/mcp', { token });
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBe(INVALID);
  });
  it.each([['no scope at all', undefined], ['a lookalike scope', 'mcp:readwrite openid'], ['mcp:read as a substring', 'xmcp:read']])(
    'refuses a JWT with %s', async (_name, scope) => {
      const { env } = setup();
      expect((await call(env, '/auth/mcp', { token: await server.mint({ scope }) })).status).toBe(403);
    });
  it('refuses a JWT whose introspection answer lacks mcp:read, whatever the token itself claims', async () => {
    const { env } = setup(); const token = await server.mint();
    server.records.set(token, { ...server.decode(token), active: true, token_type: 'Bearer', scope: 'openid email' });
    expect((await call(env, '/auth/mcp', { token })).status).toBe(403);
  });
  it('refuses an opaque token without mcp:read', async () => {
    const { env } = setup(); const opaque = 'opaqueAccessTokenWithoutScope0123';
    server.records.set(opaque, { active: true, sub: 'user_456', aud: [RESOURCE], iss: ISSUER, client_id: 'chatgpt', azp: 'chatgpt',
      exp: Math.floor(Date.now() / 1_000) + 600, token_type: 'Bearer', scope: 'openid email' });
    const response = await call(env, '/auth/mcp', { token: opaque });
    expect(response.status).toBe(403); expect(response.headers.get('WWW-Authenticate')).toBe(SCOPE_CHALLENGE);
  });
  it('says insufficient_scope on /mcp too, with no challenge pointing at sign-in', async () => {
    const { env } = setup();
    const response = await call(env, '/mcp', { token: await server.mint({ scope: 'openid' }) });
    expect(response.status).toBe(403); expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'insufficient_scope', scope: 'mcp:read' });
  });
  it('accepts a dashboard key on its api_key marker: release/r1 gives keys scope "api_key", never mcp:read', async () => {
    const { env } = setup(); const key = dashboardKey();
    server.records.set(key, { active: true, sub: 'user_789', token_type: 'api_key', scope: 'api_key', iat: 1 });
    expect((await call(env, '/auth/mcp', { token: key })).status).toBe(200);
  });
});

describe('/mcp with OAuth on', () => {
  it('accepts an OAuth token at the signed-in tier', async () => {
    const { env } = setup();
    const response = await call(env, '/mcp', { token: await server.mint() });
    expect(response.status).toBe(200); expect(response.headers.get('X-CTC-Tier')).toBe('registered');
    expect(rlKeys(env)).toEqual(['u:user_123']);
  });
  it('refuses a bad token exactly as today, with no challenge pointing at sign-in', async () => {
    const { env } = setup();
    const response = await call(env, '/mcp', { token: await server.mint({ aud: 'https://other.example' }) });
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBeNull();
    expect(await response.json()).toEqual({ error: 'invalid_key', register: `${origin}/register` });
  });
});

describe('with OAuth off', () => {
  it.each([undefined, 'false'])('treats every non-legacy bearer as today: 401 invalid_key, no call to ctc-auth (%s)', async flag => {
    const { env } = setup({ value: flag });
    for (const token of [await server.mint(), dashboardKey(), 'opaqueAccessToken0123456789']) {
      const response = await call(env, '/mcp', { token });
      expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toBeNull();
      expect(await response.json()).toEqual({ error: 'invalid_key', register: `${origin}/register` });
    }
    expect(authCalls()).toBe(0);
  });
});

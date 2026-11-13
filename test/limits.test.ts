import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import worker from '../src/index';
import { hashKey, type KeyRecord } from '../src/core/keys';
import { CONSULTANT_URL, CONTACT_URL } from '../src/core/limits';
import { resetConnectorCache } from '../src/core/connectors';
import { createExecutionContext, mockEnv, quotaNamespace } from './helpers';

const origin = 'https://mcp.comparethecloud.net';
const record: KeyRecord = { name: 'Test Person', email: 'person@example.test', org: '', use: 'A research assistant',
  createdAt: '2026-11-06T12:00:00.000Z', tier: 'registered', status: 'active' };
const key = `ctc_${'a'.repeat(40)}`;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const message = (name: string, args: Record<string, Json>, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const post = (body: Json, headers: Record<string, string> = {}) => new Request(`${origin}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'Mcp-Protocol-Version': '2025-11-25', Host: 'mcp.comparethecloud.net', 'CF-Connecting-IP': '192.0.2.20', ...headers },
  body: JSON.stringify(body),
});
const upstream = vi.fn(async (input: URL | string) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/missing')) return Response.json({ error: 'not_found' }, { status: 404 });
  if (path.startsWith('/api/directory/listing/')) return Response.json({ listing: { name: 'Example', slug: 'example' } });
  if (path === '/api/directory/search') return Response.json({ hits: [{ name: 'Example', slug: 'example', description: 'x'.repeat(20_000) }], estimatedTotalHits: 1 });
  return Response.json({ hits: [], estimatedTotalHits: 0 });
});
const setup = () => {
  const mocked = mockEnv(); const quota = quotaNamespace(); mocked.env.QUOTA = quota.namespace;
  // Settles everything the request handed to waitUntil (the not-found count runs there), as workerd would.
  const send = async (request: Request) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, mocked.env, ctx);
    await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map(([promise]) => promise));
    return response;
  };
  return { ...mocked, quota, send };
};
const repeat = async (times: number, run: () => Promise<void>) => { for (let i = 0; i < times; i++) await run(); };
interface RpcError { jsonrpc: string; id: number | string | null; error: { code: number; message: string; data: Record<string, unknown> } }
/** A quota refusal is a JSON-RPC error, so an MCP client shows its message; the details ride in error.data. */
const refusalOf = async (response: Response) => {
  const parsed = await response.json() as RpcError | RpcError[];
  const body = Array.isArray(parsed) ? parsed[0]! : parsed;
  expect(body.jsonrpc).toBe('2.0'); expect(body.error.code).toBe(-32000);
  return { ...body.error.data, message: body.error.message, id: body.id, batch: Array.isArray(parsed) ? parsed.length : 0 };
};

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T18:00:00Z')); vi.stubGlobal('fetch', upstream); resetConnectorCache(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('refuses the 31st provider profile of the day with 429, Retry-After and the consultant link', async () => {
  const { send } = setup();
  await repeat(30, async () => { expect((await send(post(message('get_provider', { slug: 'example' })))).status).toBe(200); });
  const refused = await send(post(message('fetch', { id: 'provider:example' })));
  expect(refused.status).toBe(429);
  // 18:00 UTC to midnight is six hours.
  expect(refused.headers.get('Retry-After')).toBe('21600');
  expect(refused.headers.get('X-CTC-Tier')).toBe('anonymous');
  expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(refused.headers.get('Content-Type')).toMatch(/^application\/json/);
  const body = await refusalOf(refused);
  expect(body).toMatchObject({ id: 1, error: 'quota_exceeded', quota: 'provider_profiles', retry_after: 21_600, contact: CONSULTANT_URL });
  expect(body.message).toContain(CONSULTANT_URL);
  // Search still works once the profile cap is spent, but it never carries a full description.
  const search = await send(post(message('search_providers', { q: 'cloud' })));
  expect(search.status).toBe(200);
  const text = await search.text();
  expect(text).toContain('Example'); expect(text).not.toContain('x'.repeat(281));
});

it('refuses tool calls past the daily limit with the contact link', async () => {
  const { send, quota } = setup();
  await send(post(message('search_providers', { q: 'cloud' })));
  const { storage } = quota.objects.get('ip:192.0.2.20')!;
  storage.data.set('state', { ...storage.data.get('state') as object, toolCalls: 2_000 });
  const refused = await send(post(message('search_providers', { q: 'cloud' })));
  expect(refused.status).toBe(429);
  expect(await refusalOf(refused)).toMatchObject({ error: 'quota_exceeded', quota: 'tool_calls', contact: CONTACT_URL });
});

it('blocks an identity for an hour after 30 not-found lookups', async () => {
  const { send } = setup();
  await repeat(30, async () => { expect((await send(post(message('get_content', { type: 'article', slug: 'missing' })))).status).toBe(200); });
  const refused = await send(post(message('search_providers', { q: 'cloud' })));
  expect(refused.status).toBe(429); expect(refused.headers.get('Retry-After')).toBe('3600');
  expect(await refusalOf(refused)).toMatchObject({ quota: 'not_found_block', contact: CONTACT_URL });
});

it('counts every tools/call in a JSON-RPC batch', async () => {
  const { send, quota } = setup();
  await send(post([message('get_provider', { slug: 'example' }, 1), message('get_provider', { slug: 'example' }, 2)]));
  expect(quota.objects.get('ip:192.0.2.20')!.storage.data.get('state')).toMatchObject({ toolCalls: 2, providerProfiles: 2 });
});

it('keeps initialise and tools/list off the quota counter', async () => {
  const { send, quota } = setup();
  await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  expect(quota.getByName).not.toHaveBeenCalled();
});

it('fails closed with 503 when the quota counter is unavailable', async () => {
  const { env, send } = setup();
  env.QUOTA = { getByName: () => ({ consume: async () => { throw new Error('private diagnostic'); } }) } as unknown as typeof env.QUOTA;
  const response = await send(post(message('search_providers', { q: 'cloud' })));
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
});

it('buckets an anonymous IPv6 caller by its /64 for the limiter, the quota and www', async () => {
  const { env, send, quota } = setup();
  await send(post(message('search_providers', { q: 'cloud' }), { 'CF-Connecting-IP': '2001:db8:1:2::1' }));
  await send(post(message('search_providers', { q: 'cloud' }), { 'CF-Connecting-IP': '2001:db8:1:2:ffff::9' }));
  expect(env.RL_ANON.limit).toHaveBeenCalledWith({ key: 'ip:2001:db8:1:2::' });
  expect(quota.objects.get('ip:2001:db8:1:2::')!.storage.data.get('state')).toMatchObject({ toolCalls: 2 });
  const [, init] = upstream.mock.calls.at(-1) as unknown as [URL, RequestInit];
  expect(init.headers).toMatchObject({ 'X-CTC-RL-Key': 'ip:2001:db8:1:2::' });
});

it.each([
  ['an IPv4 address', 'deny:ip:192.0.2.20', '192.0.2.20'],
  ['an IPv6 /64', 'deny:ip:2001:db8:1:2::', '2001:db8:1:2::77'],
])('refuses %s on the KV deny list', async (_name, entry, ip) => {
  const { env, values, send } = setup(); values.set(entry, 'abuse report 13 November 2026');
  const response = await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'CF-Connecting-IP': ip }));
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'denied', contact: CONTACT_URL });
  expect(response.headers.get('X-CTC-Tier')).toBe('anonymous');
  expect(env.RL_ANON.limit).toHaveBeenCalledTimes(1);
});

it('runs the per-minute limiter before the deny list, so a flood costs no KV read', async () => {
  const { env, get, send } = setup(); vi.mocked(env.RL_ANON.limit).mockResolvedValue({ success: false });
  const response = await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  expect(response.status).toBe(429); expect(get).not.toHaveBeenCalled();
});

it('refuses a keyed caller whose identity or address is on the deny list', async () => {
  const { env, values, send } = setup();
  const hash = await Effect.runPromise(hashKey(key)); const identity = await Effect.runPromise(hashKey(record.email));
  values.set(`key:${hash}`, JSON.stringify(record));
  const keyed = { Authorization: `Bearer ${key}` };
  expect((await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, keyed))).status).toBe(200);
  values.set(`deny:k:${identity}`, '1');
  const byIdentity = await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, keyed));
  expect(byIdentity.status).toBe(403); expect(byIdentity.headers.get('X-CTC-Tier')).toBe('registered');
  values.delete(`deny:k:${identity}`); values.set('deny:ip:192.0.2.20', '1');
  expect((await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, keyed))).status).toBe(403);
  expect(env.RL_KEY.limit).toHaveBeenCalledTimes(3);
});

it('fails closed with 503 when the deny list cannot be read', async () => {
  const { get, send } = setup(); get.mockRejectedValue(new Error('private storage diagnostic'));
  const response = await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'service_unavailable' });
});

it('gives a published connector address its own 600-a-minute bucket and the connector quota', async () => {
  const { env, send, quota } = setup();
  const connector = { 'CF-Connecting-IP': '160.79.104.10' };
  await repeat(31, async () => { expect((await send(post(message('get_provider', { slug: 'example' }), connector))).status).toBe(200); });
  expect(env.RL_KEY.limit).toHaveBeenCalledWith({ key: 'ip:160.79.104.10' }); expect(env.RL_ANON.limit).not.toHaveBeenCalled();
  expect(quota.objects.get('ip:160.79.104.10')!.storage.data.get('state')).toMatchObject({ providerProfiles: 31 });
});

it('adds the contact link to the per-minute 429', async () => {
  const { env, send } = setup(); vi.mocked(env.RL_ANON.limit).mockResolvedValue({ success: false });
  const response = await send(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
  expect(await response.json()).toEqual({ error: 'rate_limited', retry_after: 60, register: `${origin}/register`, contact: CONTACT_URL });
});

it('never serves a tools/call whose body is too large to count', async () => {
  const { send } = setup(); upstream.mockClear();
  // Two-byte padding: 2.2 million characters is about 4.2 MiB but under 4 Mi characters, so a character-versus-byte slip would show.
  const padded = message('get_provider', { slug: 'example', padding: 'é'.repeat(2_200_000) });
  const response = await send(post(padded));
  expect(upstream).not.toHaveBeenCalled(); expect(response.status).toBe(413);
}, 30_000);

it('refuses a batch of lookups that would cross the not-found limit before any reaches upstream', async () => {
  const { send } = setup(); upstream.mockClear();
  const batch = Array.from({ length: 31 }, (_, i) => message('get_content', { type: 'article', slug: 'missing' }, i + 1));
  const refused = await send(post(batch));
  expect(refused.status).toBe(429); expect(refused.headers.get('Retry-After')).toMatch(/^\d+$/);
  expect(await refusalOf(refused)).toMatchObject({ quota: 'lookup_slots', retry_after: 60, contact: CONTACT_URL, id: 1, batch: 31 });
  expect(upstream).not.toHaveBeenCalled();
});

it('lets at most 30 concurrent not-found lookups reach upstream, then blocks', async () => {
  const { send } = setup(); upstream.mockClear();
  const responses = await Promise.all(Array.from({ length: 40 }, () => send(post(message('get_content', { type: 'article', slug: 'missing' })))));
  expect(upstream.mock.calls.length).toBeLessThanOrEqual(30);
  expect(responses.filter(response => response.status === 429).length).toBeGreaterThanOrEqual(10);
  const after = await send(post(message('search_providers', { q: 'cloud' })));
  expect(after.status).toBe(429); expect(await refusalOf(after)).toMatchObject({ quota: 'not_found_block' });
});

it('never blocks a connector address on not-found lookups, since one user would lock out everyone behind it', async () => {
  const { send, quota } = setup(); upstream.mockClear();
  const connector = { 'CF-Connecting-IP': '160.79.104.10' };
  const responses = await Promise.all(Array.from({ length: 40 }, () => send(post(message('get_content', { type: 'article', slug: 'missing' }), connector))));
  expect(responses.every(response => response.status === 200)).toBe(true); expect(upstream).toHaveBeenCalledTimes(40);
  expect((await send(post(message('search_providers', { q: 'cloud' }), connector))).status).toBe(200);
  expect(quota.objects.get('ip:160.79.104.10')!.storage.data.get('state')).toMatchObject({ misses: [], pending: [] });
});

it.each([
  ['a non-JSON Content-Type, which the transport refuses with 415', { 'Content-Type': 'text/plain' }, message('get_provider', { slug: 'example' })],
  ['a tools/call notification, which has no id and runs nothing', {}, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_provider', arguments: { slug: 'example' } } }],
  ['a message that is not JSON-RPC 2.0', {}, { jsonrpc: '1.0', id: 1, method: 'tools/call', params: { name: 'get_provider', arguments: { slug: 'example' } } }],
])('charges no quota for %s', async (_name, headers, body) => {
  const { send, quota } = setup(); upstream.mockClear();
  const response = await send(post(body, headers));
  expect(response.status).not.toBe(429); expect(quota.getByName).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
});

it.each([
  ['a batch with a message that is not JSON-RPC 2.0', [message('get_provider', { slug: 'example' }), { jsonrpc: '1.0', id: 2, method: 'ping' }]],
  ['a batch mixing initialize with a tool call', [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, message('get_provider', { slug: 'example' }, 2)]],
])('refunds %s that the transport refuses without running anything', async (_name, body) => {
  const { send, quota } = setup(); upstream.mockClear();
  const response = await send(post(body));
  expect(response.status).toBeGreaterThanOrEqual(400); expect(response.status).toBeLessThan(500);
  expect(upstream).not.toHaveBeenCalled();
  expect(quota.objects.get('ip:192.0.2.20')?.storage.data.get('state') ?? {}).toMatchObject({ toolCalls: 0, providerProfiles: 0, pending: [] });
});

it('refunds a call the transport refuses for a bad Accept header', async () => {
  const { send, quota } = setup(); upstream.mockClear();
  const response = await send(post(message('get_provider', { slug: 'example' }), { Accept: 'application/json' }));
  expect(response.status).toBe(406); expect(upstream).not.toHaveBeenCalled();
  expect(quota.objects.get('ip:192.0.2.20')!.storage.data.get('state')).toMatchObject({ toolCalls: 0, providerProfiles: 0, pending: [] });
});

import { afterEach, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import worker from '../src/index';
import { hashKey, type KeyRecord } from '../src/core/keys';
import { createExecutionContext, mockEnv } from './helpers';

const origin = 'https://mcp.comparethecloud.net';
const record: KeyRecord = { name: 'Test Person', email: 'person@example.test', org: '', use: 'A research assistant',
  createdAt: '2026-11-06T12:00:00.000Z', tier: 'registered', status: 'active' };
const request = (path: string, init?: RequestInit) => new Request(`${origin}${path}`, init);
afterEach(() => vi.unstubAllGlobals());
it('returns health, discovery and a JSON 404', async () => {
  const { env } = mockEnv();
  const health = await worker.fetch(request('/health'), env, createExecutionContext());
  expect(await health.json()).toEqual({ ok: true, version: '1.1.0', upstream: env.SITE_ORIGIN });
  expect(health.headers.get('Access-Control-Allow-Origin')).toBe('*');
  const card = await worker.fetch(request('/.well-known/mcp.json'), env, createExecutionContext());
  expect(await card.json()).toMatchObject({ endpoint: `${origin}/mcp`, transport: 'streamable-http', auth: 'optional bearer key', register: `${origin}/register` });
  const missing = await worker.fetch(request('/missing'), env, createExecutionContext());
  expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: 'not_found' });
});
it('lists the signed-in endpoint in the MCP card only while OAuth is on', async () => {
  const { env } = mockEnv();
  const off = await (await worker.fetch(request('/.well-known/mcp.json'), env, createExecutionContext())).json() as Record<string, unknown>;
  expect(off).not.toHaveProperty('signed_in_endpoint');
  env.OAUTH_ENABLED = 'true';
  const on = await (await worker.fetch(request('/.well-known/mcp.json'), env, createExecutionContext())).json();
  expect(on).toMatchObject({ endpoint: `${origin}/mcp`, signed_in_endpoint: `${origin}/auth/mcp`, signed_in_auth: 'oauth',
    oauth_protected_resource: `${origin}/.well-known/oauth-protected-resource/auth/mcp` });
});
it.each(['/mcp', '/health'])('handles CORS preflight on %s without consuming a bucket', async path => {
  const { env } = mockEnv();
  const response = await worker.fetch(request(path, { method: 'OPTIONS' }), env, createExecutionContext());
  expect(response.status).toBe(204); expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Mcp-Protocol-Version');
  expect(env.RL_ANON.limit).not.toHaveBeenCalled();
});
it('returns anonymous rate limiting details with CORS and a retry header', async () => {
  const { env } = mockEnv(); vi.mocked(env.RL_ANON.limit).mockResolvedValue({ success: false });
  const response = await worker.fetch(request('/mcp', { headers: { 'CF-Connecting-IP': '192.0.2.15' } }), env, createExecutionContext());
  expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
  expect(response.headers.get('X-CTC-Tier')).toBe('anonymous'); expect(response.headers.get('X-RateLimit-Policy')).toBe('60;w=60');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(await response.json()).toEqual({ error: 'rate_limited', retry_after: 60, register: `${origin}/register`, contact: 'https://www.comparethecloud.net/contact' });
  expect(env.RL_ANON.limit).toHaveBeenCalledWith({ key: 'ip:192.0.2.15' });
});
it('limits registered callers per email, not per key, and returns the higher policy', async () => {
  const { env, values } = mockEnv(); const key = `ctc_${'a'.repeat(40)}`; const hash = await Effect.runPromise(hashKey(key));
  const identity = await Effect.runPromise(hashKey(record.email));
  values.set(`key:${hash}`, JSON.stringify(record)); vi.mocked(env.RL_KEY.limit).mockResolvedValue({ success: false });
  const response = await worker.fetch(request('/mcp', { headers: { Authorization: `Bearer ${key}` } }), env, createExecutionContext());
  expect(response.status).toBe(429); expect(response.headers.get('X-CTC-Tier')).toBe('registered');
  expect(response.headers.get('X-RateLimit-Policy')).toBe('600;w=60');
  expect(env.RL_KEY.limit).toHaveBeenCalledWith({ key: `k:${identity}` }); expect(env.RL_ANON.limit).not.toHaveBeenCalled();
});
it.each(['Basic abc', 'Bearer bad', '', `Bearer ctc_${'a'.repeat(40)}`])('rejects malformed or unknown authorisation', async authorization => {
  const { env } = mockEnv();
  const response = await worker.fetch(request('/mcp', { headers: { Authorization: authorization } }), env, createExecutionContext());
  expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'invalid_key', register: `${origin}/register` });
  expect(env.RL_KEY.limit).not.toHaveBeenCalled(); expect(env.RL_ANON.limit).not.toHaveBeenCalled();
});
it.each(['revoked', 'corrupt'])('rejects a %s key record', async state => {
  const { env, values } = mockEnv(); const key = `ctc_${'a'.repeat(40)}`; const hash = await Effect.runPromise(hashKey(key));
  values.set(`key:${hash}`, state === 'corrupt' ? 'not JSON' : JSON.stringify({ ...record, status: 'revoked' }));
  expect((await worker.fetch(request('/mcp', { headers: { Authorization: `Bearer ${key}` } }), env, createExecutionContext())).status).toBe(401);
});
it('fails closed if KV is unavailable without exposing internal errors', async () => {
  const { env, get } = mockEnv(); get.mockRejectedValue(new Error('private storage diagnostic'));
  const response = await worker.fetch(request('/mcp', { headers: { Authorization: `Bearer ctc_${'a'.repeat(40)}` } }), env, createExecutionContext());
  expect(response.status).toBe(503); expect(response.headers.get('X-CTC-Tier')).toBe('anonymous');
  expect(await response.json()).toEqual({ error: 'service_unavailable' });
});
it('serves mobile-safe landing and registration HTML with security headers', async () => {
  const { env } = mockEnv();
  const landing = await worker.fetch(request('/'), env, createExecutionContext());
  const body = await landing.text(); expect(body).toContain('lang="en-GB"'); expect(body).toContain('name="viewport"');
  for (const client of ['Claude.ai', 'Claude Code', 'Cursor', 'Codex CLI', 'ChatGPT', 'mcp-remote']) expect(body).toContain(client);
  expect(landing.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
  const form = await worker.fetch(request('/register'), env, createExecutionContext());
  expect(await form.text()).toContain('<form method="post"'); expect(form.headers.get('Cache-Control')).toBe('no-store');
});

it('shows the signed-in endpoint on the landing page only while OAuth is on', async () => {
  const { env } = mockEnv();
  const off = await (await worker.fetch(request('/'), env, createExecutionContext())).text();
  expect(off).not.toContain('/auth/mcp');
  env.OAUTH_ENABLED = 'true';
  const on = await (await worker.fetch(request('/'), env, createExecutionContext())).text();
  expect(on).toContain(`${origin}/auth/mcp`); expect(on).toContain('Signed-in access');
  expect(on).toContain('claude mcp add --transport http ctc'); expect(on).toContain('my.comparethecloud.net');
  expect(on).toContain(`<code>${origin}/mcp</code>`);
});

it('serves only the exact OpenAI challenge token when configured', async () => {
  const { env } = mockEnv();
  const path = '/.well-known/openai-apps-challenge';
  expect((await worker.fetch(request(path), env, createExecutionContext())).status).toBe(404);
  env.OPENAI_APPS_CHALLENGE = 'token with spaces\n';
  const response = await worker.fetch(request(path), env, createExecutionContext());
  expect(response.headers.get('Content-Type')).toMatch(/^text\/plain/);
  expect(await response.text()).toBe(env.OPENAI_APPS_CHALLENGE);
});

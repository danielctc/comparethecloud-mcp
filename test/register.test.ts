import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext } from './helpers';
import { Effect } from 'effect';
import worker from '../src/index';
import { hashKey } from '../src/core/keys';
import { mockEnv, registrationRequest } from './helpers';

afterEach(() => vi.unstubAllGlobals());
describe('registration', () => {
  it('returns the success page for a honeypot without touching KV or sending email', async () => {
    const { env, values, get, put } = mockEnv();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await worker.fetch(registrationRequest({ website: 'https://example.test' }), env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Check your email');
    expect(values.size).toBe(0); expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('emails exactly once, stores only the hash, and never displays the key', async () => {
    const { env, values, put } = mockEnv();
    const fetch = vi.fn(async () => Response.json({ id: 'email-id' })); vi.stubGlobal('fetch', fetch);
    const response = await worker.fetch(registrationRequest({ email: 'Person@Example.test' }), env, createExecutionContext());
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const email = JSON.parse(init.body as string);
    const key = email.text.match(/ctc_[A-Za-z0-9]{40}/)[0];
    const hash = await Effect.runPromise(hashKey(key));
    expect(email.to).toEqual(['person@example.test']);
    expect(email.subject).toBe('Your Compare the Cloud MCP key');
    expect(email.text).toContain('600 requests/min'); expect(email.html).toContain(key);
    expect(values.get('email:person@example.test')).toBe(hash);
    expect(JSON.parse(values.get(`key:${hash}`)!)).toMatchObject({ status: 'active', tier: 'registered', name: 'Test Person' });
    expect(JSON.stringify([...values])).not.toContain(key);
    expect(await response.text()).not.toContain(key);
    expect(put.mock.calls.find(([name]) => name.startsWith('reg:'))?.[2]).toMatchObject({ expirationTtl: 3600 });
  });
  it('retains and revokes the old key on re-registration', async () => {
    const { env, values } = mockEnv();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'email-id' })));
    await worker.fetch(registrationRequest(), env, createExecutionContext());
    const oldHash = values.get('email:person@example.test')!;
    await worker.fetch(registrationRequest(), env, createExecutionContext());
    expect(values.get('email:person@example.test')).not.toBe(oldHash);
    expect(JSON.parse(values.get(`key:${oldHash}`)!)).toMatchObject({ status: 'revoked' });
    expect([...values.keys()].filter(key => key.startsWith('key:'))).toHaveLength(2);
  });
  it.each(['http', 'network'])('revokes a new key after an email %s failure', async failure => {
    const { env, values } = mockEnv();
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw new Error('email failed');
      return new Response('unavailable', { status: 503 });
    }));
    const response = await worker.fetch(registrationRequest(), env, createExecutionContext());
    expect(response.status).toBe(500); expect(await response.text()).toContain('Could not send, try again later');
    const hash = values.get('email:person@example.test');
    expect(JSON.parse(values.get(`key:${hash}`)!)).toMatchObject({ status: 'revoked' });
  });
  it.each<Record<string, string>>([{ name: 'A' }, { name: 'a'.repeat(81) }, { email: 'bad' }, { use: 'short' }, { use: 'a'.repeat(501) }])('rejects invalid details %j', async details => {
    const { env, values } = mockEnv(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await worker.fetch(registrationRequest(details), env, createExecutionContext());
    expect(response.status).toBe(400); expect(values.size).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });
  it('requires agreement to the terms', async () => {
    const { env } = mockEnv();
    const original = registrationRequest(); const form = new URLSearchParams(await original.text()); form.delete('terms');
    const request = new Request(original.url, { method: 'POST', headers: original.headers, body: form.toString() });
    expect((await worker.fetch(request, env, createExecutionContext())).status).toBe(400);
  });
  it('allows five registrations per IP then returns 429 without sending a sixth email', async () => {
    const { env } = mockEnv(); const fetch = vi.fn(async () => Response.json({ id: 'email-id' })); vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 5; i++) expect((await worker.fetch(registrationRequest(), env, createExecutionContext())).status).toBe(200);
    expect((await worker.fetch(registrationRequest(), env, createExecutionContext())).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('accepts a fresh registration after the fixed window expires', async () => {
    const { env, values } = mockEnv();
    values.set('reg:192.0.2.1', JSON.stringify({ count: 5, expiresAt: 0 }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'email-id' })));
    expect((await worker.fetch(registrationRequest(), env, createExecutionContext())).status).toBe(200);
  });
});

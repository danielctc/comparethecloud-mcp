import { vi } from 'vitest';
import type { Env } from '../src/env';
import { QuotaCounter } from '../src/core/quota';

export function mockEnv() {
  const values = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string, _options?: KVNamespacePutOptions) => { values.set(key, value); });
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const env: Env = {
    MCP_KEYS: { get, put } as unknown as KVNamespace,
    RL_ANON: { limit: vi.fn(async () => ({ success: true })) },
    RL_KEY: { limit: vi.fn(async () => ({ success: true })) },
    ASSETS: { fetch: vi.fn(async () => new Response('image')) } as unknown as Fetcher,
    // The service binding resolves the global fetch at call time, so vi.stubGlobal('fetch') still intercepts it.
    SITE: { fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init) } as unknown as Fetcher,
    SITE_ORIGIN: 'https://www.comparethecloud.net', PUBLIC_ORIGIN: 'https://mcp.comparethecloud.net',
    RESEND_FROM: 'Compare the Cloud <mcp@comparethecloud.net>',
    RESEND_API_KEY: 'test-email-token', UPSTREAM_SECRET: 'test-upstream-token',
    QUOTA: quotaNamespace().namespace,
  };
  return { env, values, put, get };
}
export const validDetails = { name: 'Test Person', email: 'person@example.test', org: 'Example Ltd',
  use: 'A directory research assistant', terms: 'yes' };
export const registrationRequest = (overrides: Record<string, string> = {}) => new Request('https://mcp.comparethecloud.net/register', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1' },
  body: new URLSearchParams({ ...validDetails, ...overrides }).toString(),
});

export function createExecutionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}

/** SQLite-backed Durable Object storage held in a Map: the synchronous kv API plus the one alarm a real object allows. */
export function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    get alarmAt() { return alarm; },
    kv: {
      get: vi.fn((key: string) => structuredClone(data.get(key))),
      put: vi.fn((key: string, value: unknown) => { data.set(key, structuredClone(value)); }),
      delete: vi.fn((key: string) => data.delete(key)),
    },
    deleteAll: vi.fn(async () => { data.clear(); }),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (at: number | Date) => { alarm = Number(at); }),
    deleteAlarm: vi.fn(async () => { alarm = null; }),
  };
}
/** A namespace that runs the real QuotaCounter in-process, one object per name, as getByName does. */
export function quotaNamespace() {
  const objects = new Map<string, { counter: QuotaCounter; storage: ReturnType<typeof fakeStorage> }>();
  const getByName = vi.fn((name: string) => {
    if (!objects.has(name)) {
      const storage = fakeStorage();
      objects.set(name, { counter: new QuotaCounter({ storage } as unknown as DurableObjectState, {} as Env), storage });
    }
    return objects.get(name)!.counter;
  });
  return { namespace: { getByName } as unknown as DurableObjectNamespace<QuotaCounter>, objects, getByName };
}

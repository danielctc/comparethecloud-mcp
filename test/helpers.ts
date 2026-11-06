import { vi } from 'vitest';
import type { Env } from '../src/env';

export function mockEnv() {
  const values = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string, _options?: KVNamespacePutOptions) => { values.set(key, value); });
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const env: Env = {
    MCP_KEYS: { get, put } as unknown as KVNamespace,
    RL_ANON: { limit: vi.fn(async () => ({ success: true })) },
    RL_KEY: { limit: vi.fn(async () => ({ success: true })) },
    ASSETS: { fetch: vi.fn(async () => new Response('image')) } as unknown as Fetcher,
    SITE_ORIGIN: 'https://www.comparethecloud.net', PUBLIC_ORIGIN: 'https://mcp.comparethecloud.net',
    RESEND_FROM: 'Compare the Cloud <mcp@comparethecloud.net>',
    RESEND_API_KEY: 'test-email-token', UPSTREAM_SECRET: 'test-upstream-token',
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

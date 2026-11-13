import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { ANTHROPIC_CONNECTOR_RANGES, connectorRanges, resetConnectorCache } from '../src/core/connectors';
import { inRanges } from '../src/core/ip';
import { mockEnv } from './helpers';

const URL_OPENAI = 'https://openai.com/chatgpt-connectors.json';
const manifest = { creationTime: '2026-11-06T18:26:55.215535', prefixes: [
  { ipv4Prefix: '100.31.168.162/32' }, { ipv4Prefix: '104.192.219.204/30' }, { ipv6Prefix: '2001:db8:42::/48' },
] };
const setup = () => {
  const { env, values } = mockEnv(); env.OPENAI_CONNECTOR_RANGES_URL = URL_OPENAI;
  const pending: Promise<unknown>[] = [];
  const ranges = () => Effect.runPromise(connectorRanges(env, promise => { pending.push(promise); }));
  return { env, values, pending, ranges, settle: () => Promise.all(pending.splice(0)) };
};

beforeEach(() => { resetConnectorCache(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('holds both published Anthropic connector ranges without any fetch', async () => {
  expect([...ANTHROPIC_CONNECTOR_RANGES]).toEqual(['160.79.104.0/21', '153.61.208.0/20']);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { env } = mockEnv();
  const ranges = await Effect.runPromise(connectorRanges(env, () => undefined));
  expect(inRanges('160.79.104.1', ranges)).toBe(true); expect(inRanges('153.61.208.1', ranges)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('fetches the OpenAI list off the request path, then serves it from memory for a day', async () => {
  const fetch = vi.fn(async () => Response.json(manifest)); vi.stubGlobal('fetch', fetch);
  const { ranges, settle } = setup();
  // The first request never waits on openai.com: it gets the static ranges and schedules a refresh.
  expect(inRanges('100.31.168.162', await ranges())).toBe(false);
  await settle();
  const loaded = await ranges();
  expect(inRanges('100.31.168.162', loaded)).toBe(true); expect(inRanges('104.192.219.207', loaded)).toBe(true);
  expect(inRanges('2001:db8:42:1::5', loaded)).toBe(true); expect(inRanges('160.79.104.1', loaded)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(String(url)).toBe(URL_OPENAI); expect(init.signal).toBeInstanceOf(AbortSignal);
  vi.setSystemTime(new Date('2026-11-14T11:59:00Z')); await ranges(); await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date('2026-11-14T12:00:01Z')); await ranges(); await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('starts only one refresh while one is in flight', async () => {
  const fetch = vi.fn(async () => Response.json(manifest)); vi.stubGlobal('fetch', fetch);
  const { ranges, settle } = setup();
  await ranges(); await ranges(); await ranges(); await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ['a network failure', async () => { throw new Error('offline'); }],
  ['an HTTP error', async () => new Response('nope', { status: 503 })],
  ['the wrong shape', async () => Response.json({ prefixes: 'all of them' })],
  ['invalid JSON', async () => new Response('{')],
  ['an oversized body', async () => new Response(' '.repeat(600_000) + JSON.stringify(manifest))],
])('falls back to no OpenAI ranges on %s and retries after five minutes, not on every request', async (_name, answer) => {
  const fetch = vi.fn(answer); vi.stubGlobal('fetch', fetch);
  const { ranges, settle } = setup();
  await ranges(); await settle();
  const after = await ranges();
  expect(inRanges('100.31.168.162', after)).toBe(false); expect(inRanges('160.79.104.1', after)).toBe(true);
  await ranges(); await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date('2026-11-13T12:05:01Z')); await ranges(); await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('drops malformed and implausibly broad prefixes but keeps the rest', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ prefixes: [
    { ipv4Prefix: '0.0.0.0/0' }, { ipv4Prefix: '10.0.0.0/8' }, { ipv6Prefix: '2000::/3' }, { ipv4Prefix: 'nonsense' },
    { somethingElse: '1.2.3.4/32' }, { ipv4Prefix: '100.31.168.162/32' },
  ] })));
  const { ranges, settle } = setup();
  await ranges(); await settle();
  const loaded = await ranges();
  expect(inRanges('100.31.168.162', loaded)).toBe(true);
  expect(inRanges('10.1.2.3', loaded)).toBe(false); expect(inRanges('8.8.8.8', loaded)).toBe(false);
  expect(inRanges('2001:db8::1', loaded)).toBe(false);
});

it('does not fetch at all when no source URL is configured', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { env } = mockEnv(); const pending: Promise<unknown>[] = [];
  await Effect.runPromise(connectorRanges(env, promise => { pending.push(promise); }));
  expect(pending).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});

it('stores a good list in KV, and a new isolate starts from it without fetching', async () => {
  const fetch = vi.fn(async () => Response.json(manifest)); vi.stubGlobal('fetch', fetch);
  const { values, ranges, settle } = setup();
  await ranges(); await settle();
  expect(JSON.parse(values.get('connectors:openai')!)).toEqual({ fetchedAt: Date.parse('2026-11-13T12:00:00Z'),
    prefixes: ['100.31.168.162/32', '104.192.219.204/30', '2001:db8:42::/48'] });
  resetConnectorCache();
  vi.setSystemTime(new Date('2026-11-13T20:00:00Z'));
  const loaded = await ranges();
  expect(inRanges('100.31.168.162', loaded)).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps the last good list when a refresh fails, so connector callers are not demoted mid-day', async () => {
  const fetch = vi.fn(async () => Response.json(manifest)); vi.stubGlobal('fetch', fetch);
  const { ranges, settle } = setup();
  await ranges(); await settle();
  fetch.mockRejectedValue(new Error('offline'));
  vi.setSystemTime(new Date('2026-11-14T12:00:01Z')); await ranges(); await settle();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(inRanges('100.31.168.162', await ranges())).toBe(true);
});

it('treats an unreadable KV copy as none and still answers', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const { env, ranges, settle } = setup(); vi.mocked(env.MCP_KEYS.get).mockRejectedValue(new Error('kv down'));
  const loaded = await ranges(); await settle();
  expect(inRanges('160.79.104.1', loaded)).toBe(true); expect(inRanges('100.31.168.162', loaded)).toBe(false);
});

it('drops a last good list once refreshes have failed for three days, and lets the KV copy expire with it', async () => {
  const fetch = vi.fn(async () => Response.json(manifest)); vi.stubGlobal('fetch', fetch);
  const { env, ranges, settle } = setup();
  await ranges(); await settle();
  expect(vi.mocked(env.MCP_KEYS.put).mock.calls.at(-1)![2]).toEqual({ expirationTtl: 259_200 });
  fetch.mockRejectedValue(new Error('offline'));
  vi.setSystemTime(new Date('2026-11-16T11:59:00Z')); await ranges(); await settle();
  expect(inRanges('100.31.168.162', await ranges())).toBe(true);
  vi.setSystemTime(new Date('2026-11-16T12:05:00Z')); await ranges(); await settle();
  expect(inRanges('100.31.168.162', await ranges())).toBe(false);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callsIn, QUOTAS, type Usage } from '../src/core/limits';

const usageOf = (body: string) => callsIn(body).usage;
import { quotaNamespace } from './helpers';

const call: Usage = { toolCalls: 1, providerProfiles: 0, contentReads: 0, lookups: 0 };
const profile: Usage = { toolCalls: 1, providerProfiles: 1, contentReads: 0, lookups: 1 };
const content: Usage = { toolCalls: 1, providerProfiles: 0, contentReads: 1, lookups: 1 };
const counter = () => { const { namespace, objects } = quotaNamespace(); namespace.getByName('ip:192.0.2.1'); return { counter: objects.get('ip:192.0.2.1')!.counter, objects }; };
const repeat = async (times: number, run: () => Promise<void>) => { for (let i = 0; i < times; i++) await run(); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

it('holds the limits Daniel set, as configuration', () => {
  expect(QUOTAS.anonymous).toMatchObject({ toolCalls: 2_000, providerProfiles: 30, contentReads: 300, notFoundPerHour: 30 });
  expect(QUOTAS.registered).toMatchObject({ toolCalls: 10_000, providerProfiles: 150, contentReads: 2_000, notFoundPerHour: 30 });
  expect(QUOTAS.connector).toMatchObject({ toolCalls: 20_000 });
});

it('allows tool calls up to the daily limit, then refuses until UTC midnight', async () => {
  const { counter: quota } = counter();
  const limits = { ...QUOTAS.anonymous, toolCalls: 3 };
  await repeat(3, async () => expect(await quota.consume(call, limits)).toMatchObject({ ok: true }));
  // 12:00 UTC to the next midnight is 12 hours.
  expect(await quota.consume(call, limits)).toEqual({ ok: false, quota: 'tool_calls', retryAfter: 43_200 });
  vi.setSystemTime(new Date('2026-11-14T00:00:01Z'));
  expect(await quota.consume(call, limits)).toMatchObject({ ok: true });
});

it('caps provider profiles at 30 a day for anonymous callers while other tools still work', async () => {
  const { counter: quota } = counter();
  await repeat(30, async () => expect(await quota.consume(profile, QUOTAS.anonymous)).toMatchObject({ ok: true }));
  expect(await quota.consume(profile, QUOTAS.anonymous)).toMatchObject({ ok: false, quota: 'provider_profiles' });
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: true });
});

it('caps provider profiles at 150 a day for signed-in callers', async () => {
  const { counter: quota } = counter();
  // Each lookup settles found, as it would in the Worker, so its not-found slot is released.
  await repeat(150, async () => {
    const verdict = await quota.consume(profile, QUOTAS.registered);
    expect(verdict).toMatchObject({ ok: true }); await quota.settleLookup(false, QUOTAS.registered, verdict.ok ? verdict.reservedAt : undefined);
  });
  expect(await quota.consume(profile, QUOTAS.registered)).toMatchObject({ ok: false, quota: 'provider_profiles' });
});

it('caps full content reads separately', async () => {
  const { counter: quota } = counter();
  const limits = { ...QUOTAS.anonymous, contentReads: 2 };
  await repeat(2, async () => expect(await quota.consume(content, limits)).toMatchObject({ ok: true }));
  expect(await quota.consume(content, limits)).toMatchObject({ ok: false, quota: 'content_reads' });
  expect(await quota.consume(profile, limits)).toMatchObject({ ok: true });
});

it('does not count a refused call, so a refusal never eats tomorrow\'s allowance', async () => {
  const { counter: quota, objects } = counter();
  const limits = { ...QUOTAS.anonymous, providerProfiles: 1 };
  await quota.consume(profile, limits);
  await quota.consume(profile, limits); await quota.consume(profile, limits);
  expect([...objects.values()][0]!.storage.data.get('state')).toMatchObject({ toolCalls: 1, providerProfiles: 1 });
});

it('counts a batch as every call in it', async () => {
  const { counter: quota } = counter();
  const limits = { ...QUOTAS.anonymous, toolCalls: 5 };
  expect(await quota.consume({ toolCalls: 6, providerProfiles: 0, contentReads: 0, lookups: 0 }, limits)).toMatchObject({ ok: false, quota: 'tool_calls' });
  expect(await quota.consume({ toolCalls: 5, providerProfiles: 0, contentReads: 0, lookups: 0 }, limits)).toMatchObject({ ok: true });
  expect(await quota.consume(call, limits)).toMatchObject({ ok: false });
});

it('blocks every tool call for an hour after 30 not-found lookups in an hour', async () => {
  const { counter: quota } = counter();
  await repeat(29, () => quota.settleLookup(true, QUOTAS.anonymous));
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: true });
  vi.setSystemTime(new Date('2026-11-13T12:10:00Z'));
  await quota.settleLookup(true, QUOTAS.anonymous);
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: false, quota: 'not_found_block', retryAfter: 3_600 });
  vi.setSystemTime(new Date('2026-11-13T13:09:59Z'));
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: false, quota: 'not_found_block', retryAfter: 1 });
  vi.setSystemTime(new Date('2026-11-13T13:10:00Z'));
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: true });
});

it('forgets not-found lookups older than the hour window', async () => {
  const { counter: quota } = counter();
  await repeat(29, () => quota.settleLookup(true, QUOTAS.anonymous));
  vi.setSystemTime(new Date('2026-11-13T13:00:01Z'));
  await repeat(29, () => quota.settleLookup(true, QUOTAS.anonymous));
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: true });
});

it('sets an alarm that clears an idle identity once every window has passed', async () => {
  const { counter: quota, objects } = counter();
  await quota.consume(call, QUOTAS.anonymous);
  const { storage } = [...objects.values()][0]!;
  expect(storage.alarmAt).toBe(Date.parse('2026-11-14T00:00:00Z'));
  await repeat(30, () => quota.settleLookup(true, QUOTAS.anonymous));
  vi.setSystemTime(new Date('2026-11-13T23:30:00Z'));
  await repeat(30, () => quota.settleLookup(true, QUOTAS.anonymous));
  // The block runs past midnight, so the alarm waits for it.
  expect(storage.alarmAt).toBe(Date.parse('2026-11-14T00:30:00Z'));
  vi.setSystemTime(new Date('2026-11-14T00:30:00Z'));
  await quota.alarm();
  expect(storage.data.size).toBe(0);
});

it('reschedules rather than clears when the alarm fires early', async () => {
  const { counter: quota, objects } = counter();
  await quota.consume(call, QUOTAS.anonymous);
  const { storage } = [...objects.values()][0]!;
  await quota.alarm();
  expect(storage.data.get('state')).toBeDefined(); expect(storage.alarmAt).toBe(Date.parse('2026-11-14T00:00:00Z'));
});

it('starts fresh when stored state does not decode', async () => {
  const { counter: quota, objects } = counter();
  await quota.consume(call, QUOTAS.anonymous);
  [...objects.values()][0]!.storage.data.set('state', { toolCalls: 'many' });
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: true });
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const rpc = (method: string, params: Record<string, Json> = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const tool = (name: string, args: Record<string, Json>) => rpc('tools/call', { name, arguments: args });
it.each([
  ['a normal tool call', tool('search_providers', { q: 'cloud' }), { toolCalls: 1, providerProfiles: 0, contentReads: 0, lookups: 0 }],
  ['get_provider', tool('get_provider', { slug: 'x' }), { toolCalls: 1, providerProfiles: 1, contentReads: 0, lookups: 1 }],
  ['fetch provider:', tool('fetch', { id: 'provider:x' }), { toolCalls: 1, providerProfiles: 1, contentReads: 0, lookups: 1 }],
  ['get_content', tool('get_content', { type: 'news', slug: 'x' }), { toolCalls: 1, providerProfiles: 0, contentReads: 1, lookups: 1 }],
  ['fetch article:', tool('fetch', { id: 'article:x' }), { toolCalls: 1, providerProfiles: 0, contentReads: 1, lookups: 1 }],
  ['fetch opinion:', tool('fetch', { id: 'opinion:x' }), { toolCalls: 1, providerProfiles: 0, contentReads: 1, lookups: 1 }],
  ['tools/list', rpc('tools/list'), { toolCalls: 0, providerProfiles: 0, contentReads: 0, lookups: 0 }],
  ['a tools/call with no params', { jsonrpc: '2.0', id: 1, method: 'tools/call' }, { toolCalls: 1, providerProfiles: 0, contentReads: 0, lookups: 0 }],
  ['a batch', [tool('get_provider', { slug: 'a' }), tool('fetch', { id: 'news:b' }), rpc('ping')], { toolCalls: 2, providerProfiles: 1, contentReads: 1, lookups: 2 }],
  ['similar_providers', tool('similar_providers', { slug: 'x' }), { toolCalls: 1, providerProfiles: 0, contentReads: 0, lookups: 1 }],
  ['a scalar', 7, { toolCalls: 0, providerProfiles: 0, contentReads: 0, lookups: 0 }],
])('classifies %s', (_name, message, usage) => {
  expect(usageOf(JSON.stringify(message))).toEqual(usage);
});
it('classifies an unparseable body as no usage, leaving the parse error to the MCP handler', () => {
  expect(usageOf('{"method": "tools/call"')).toEqual({ toolCalls: 0, providerProfiles: 0, contentReads: 0, lookups: 0 });
});

it('counts not-found lookups over a rolling hour, so a burst across a clock boundary still blocks', async () => {
  const { counter: quota } = counter();
  await quota.consume(call, QUOTAS.anonymous);
  vi.setSystemTime(new Date('2026-11-13T12:59:00Z'));
  await repeat(29, () => quota.settleLookup(true, QUOTAS.anonymous));
  vi.setSystemTime(new Date('2026-11-13T13:00:30Z'));
  await quota.settleLookup(true, QUOTAS.anonymous);
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: false, quota: 'not_found_block' });
});

// Admission reserves a not-found slot per lookup before any upstream call, so lookups admitted together, in one
// batch or in concurrent requests, can never take an identity past its hourly not-found limit.
const lookups = (n: number): Usage => ({ toolCalls: n, providerProfiles: 0, contentReads: n, lookups: n });
it('refuses a batch whose lookups would cross the not-found limit', async () => {
  const { counter: quota } = counter();
  await repeat(25, () => quota.settleLookup(true, QUOTAS.anonymous));
  // The oldest of the 25 misses, recorded at 12:00, frees its slot at 13:00.
  expect(await quota.consume(lookups(6), QUOTAS.anonymous)).toEqual({ ok: false, quota: 'lookup_slots', retryAfter: 3_600 });
  expect(await quota.consume(lookups(5), QUOTAS.anonymous)).toMatchObject({ ok: true });
  expect(await quota.consume(lookups(1), QUOTAS.anonymous)).toMatchObject({ ok: false, quota: 'lookup_slots' });
});
it('lets only one of two concurrent lookups through at the last slot, and frees the slot when it is found', async () => {
  const { counter: quota } = counter();
  await repeat(29, () => quota.settleLookup(true, QUOTAS.anonymous));
  const [first, second] = await Promise.all([quota.consume(content, QUOTAS.anonymous), quota.consume(content, QUOTAS.anonymous)]);
  const admitted = [first!, second!].filter(verdict => verdict.ok);
  expect(admitted).toHaveLength(1);
  await quota.settleLookup(false, QUOTAS.anonymous, admitted[0]!.reservedAt);
  expect(await quota.consume(content, QUOTAS.anonymous)).toMatchObject({ ok: true });
});
it('blocks when a reserved lookup comes back not found at the threshold', async () => {
  const { counter: quota } = counter();
  await repeat(29, () => quota.settleLookup(true, QUOTAS.anonymous));
  const verdict = await quota.consume(content, QUOTAS.anonymous);
  expect(verdict).toMatchObject({ ok: true });
  await quota.settleLookup(true, QUOTAS.anonymous, verdict.ok ? verdict.reservedAt : undefined);
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: false, quota: 'not_found_block', retryAfter: 3_600 });
});
it('gives a finite Retry-After to a batch larger than the hourly limit on a clean identity', async () => {
  const { counter: quota } = counter();
  expect(await quota.consume(lookups(31), QUOTAS.anonymous)).toEqual({ ok: false, quota: 'lookup_slots', retryAfter: 60 });
});
it('drops a reservation that was never settled after a minute', async () => {
  const { counter: quota } = counter();
  expect(await quota.consume(lookups(30), QUOTAS.anonymous)).toMatchObject({ ok: true });
  expect(await quota.consume(content, QUOTAS.anonymous)).toEqual({ ok: false, quota: 'lookup_slots', retryAfter: 60 });
  vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
  expect(await quota.consume(content, QUOTAS.anonymous)).toMatchObject({ ok: true });
});

it('reports a reservation time for lookups and none for other calls', async () => {
  const { counter: quota } = counter();
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: true });
  expect(await quota.consume(content, QUOTAS.anonymous)).toEqual({ ok: true, reservedAt: Date.parse('2026-11-13T12:00:00Z') });
});
it('settles only its own reservation, so a late settle cannot free a slot another request holds', async () => {
  const { counter: quota, objects } = counter();
  const early = await quota.consume(content, QUOTAS.anonymous);
  vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
  await quota.consume(content, QUOTAS.anonymous);
  await quota.settleLookup(false, QUOTAS.anonymous, early.ok ? early.reservedAt : undefined);
  expect([...objects.values()][0]!.storage.data.get('state')).toMatchObject({ pending: [Date.parse('2026-11-13T12:01:01Z')] });
});
it('tells a refused batch when enough slots for all of it are free, not just the first', async () => {
  const { counter: quota } = counter();
  await quota.settleLookup(true, QUOTAS.anonymous);
  vi.setSystemTime(new Date('2026-11-13T12:10:00Z'));
  await repeat(27, () => quota.settleLookup(true, QUOTAS.anonymous));
  vi.setSystemTime(new Date('2026-11-13T12:20:00Z'));
  // 28 misses plus 4 lookups is 2 over: the second-oldest miss (12:10) frees the second slot at 13:10.
  expect(await quota.consume(lookups(4), QUOTAS.anonymous)).toEqual({ ok: false, quota: 'lookup_slots', retryAfter: 3_000 });
});
it('never starts a block on a lookup that was found', async () => {
  const { counter: quota } = counter();
  const roomy = { ...QUOTAS.anonymous, notFoundPerHour: 100 };
  await repeat(40, () => quota.settleLookup(true, roomy));
  await quota.settleLookup(false, QUOTAS.anonymous);
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: true });
});
it('keeps no not-found slots or block for a quota without a not-found limit', async () => {
  const { counter: quota, objects } = counter();
  expect(QUOTAS.connector.notFoundPerHour).toBeNull();
  expect(await quota.consume(lookups(500), { ...QUOTAS.connector })).toEqual({ ok: true });
  await repeat(400, () => quota.settleLookup(true, QUOTAS.connector));
  expect(await quota.consume(content, QUOTAS.connector)).toEqual({ ok: true });
  expect([...objects.values()][0]!.storage.data.get('state')).toMatchObject({ misses: [], pending: [], blockedUntil: 0 });
});

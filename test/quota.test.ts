import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QUOTAS, usageOf, type Usage } from '../src/core/limits';
import { quotaNamespace } from './helpers';

const call: Usage = { toolCalls: 1, providerProfiles: 0, contentReads: 0 };
const profile: Usage = { toolCalls: 1, providerProfiles: 1, contentReads: 0 };
const content: Usage = { toolCalls: 1, providerProfiles: 0, contentReads: 1 };
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
  await repeat(3, async () => expect(await quota.consume(call, limits)).toEqual({ ok: true }));
  // 12:00 UTC to the next midnight is 12 hours.
  expect(await quota.consume(call, limits)).toEqual({ ok: false, quota: 'tool_calls', retryAfter: 43_200 });
  vi.setSystemTime(new Date('2026-11-14T00:00:01Z'));
  expect(await quota.consume(call, limits)).toEqual({ ok: true });
});

it('caps provider profiles at 30 a day for anonymous callers while other tools still work', async () => {
  const { counter: quota } = counter();
  await repeat(30, async () => expect(await quota.consume(profile, QUOTAS.anonymous)).toEqual({ ok: true }));
  expect(await quota.consume(profile, QUOTAS.anonymous)).toMatchObject({ ok: false, quota: 'provider_profiles' });
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: true });
});

it('caps provider profiles at 150 a day for signed-in callers', async () => {
  const { counter: quota } = counter();
  await repeat(150, async () => expect(await quota.consume(profile, QUOTAS.registered)).toEqual({ ok: true }));
  expect(await quota.consume(profile, QUOTAS.registered)).toMatchObject({ ok: false, quota: 'provider_profiles' });
});

it('caps full content reads separately', async () => {
  const { counter: quota } = counter();
  const limits = { ...QUOTAS.anonymous, contentReads: 2 };
  await repeat(2, async () => expect(await quota.consume(content, limits)).toEqual({ ok: true }));
  expect(await quota.consume(content, limits)).toMatchObject({ ok: false, quota: 'content_reads' });
  expect(await quota.consume(profile, limits)).toEqual({ ok: true });
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
  expect(await quota.consume({ toolCalls: 6, providerProfiles: 0, contentReads: 0 }, limits)).toMatchObject({ ok: false, quota: 'tool_calls' });
  expect(await quota.consume({ toolCalls: 5, providerProfiles: 0, contentReads: 0 }, limits)).toEqual({ ok: true });
  expect(await quota.consume(call, limits)).toMatchObject({ ok: false });
});

it('blocks every tool call for an hour after 30 not-found lookups in an hour', async () => {
  const { counter: quota } = counter();
  await repeat(29, () => quota.recordNotFound(QUOTAS.anonymous));
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: true });
  vi.setSystemTime(new Date('2026-11-13T12:10:00Z'));
  await quota.recordNotFound(QUOTAS.anonymous);
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: false, quota: 'not_found_block', retryAfter: 3_600 });
  vi.setSystemTime(new Date('2026-11-13T13:09:59Z'));
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: false, quota: 'not_found_block', retryAfter: 1 });
  vi.setSystemTime(new Date('2026-11-13T13:10:00Z'));
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: true });
});

it('forgets not-found lookups older than the hour window', async () => {
  const { counter: quota } = counter();
  await repeat(29, () => quota.recordNotFound(QUOTAS.anonymous));
  vi.setSystemTime(new Date('2026-11-13T13:00:01Z'));
  await repeat(29, () => quota.recordNotFound(QUOTAS.anonymous));
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: true });
});

it('sets an alarm that clears an idle identity once every window has passed', async () => {
  const { counter: quota, objects } = counter();
  await quota.consume(call, QUOTAS.anonymous);
  const { storage } = [...objects.values()][0]!;
  expect(storage.alarmAt).toBe(Date.parse('2026-11-14T00:00:00Z'));
  await repeat(30, () => quota.recordNotFound(QUOTAS.anonymous));
  vi.setSystemTime(new Date('2026-11-13T23:30:00Z'));
  await repeat(30, () => quota.recordNotFound(QUOTAS.anonymous));
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
  expect(await quota.consume(call, QUOTAS.anonymous)).toEqual({ ok: true });
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const rpc = (method: string, params: Record<string, Json> = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const tool = (name: string, args: Record<string, Json>) => rpc('tools/call', { name, arguments: args });
it.each([
  ['a normal tool call', tool('search_providers', { q: 'cloud' }), { toolCalls: 1, providerProfiles: 0, contentReads: 0 }],
  ['get_provider', tool('get_provider', { slug: 'x' }), { toolCalls: 1, providerProfiles: 1, contentReads: 0 }],
  ['fetch provider:', tool('fetch', { id: 'provider:x' }), { toolCalls: 1, providerProfiles: 1, contentReads: 0 }],
  ['get_content', tool('get_content', { type: 'news', slug: 'x' }), { toolCalls: 1, providerProfiles: 0, contentReads: 1 }],
  ['fetch article:', tool('fetch', { id: 'article:x' }), { toolCalls: 1, providerProfiles: 0, contentReads: 1 }],
  ['fetch opinion:', tool('fetch', { id: 'opinion:x' }), { toolCalls: 1, providerProfiles: 0, contentReads: 1 }],
  ['tools/list', rpc('tools/list'), { toolCalls: 0, providerProfiles: 0, contentReads: 0 }],
  ['a tools/call with no params', { jsonrpc: '2.0', id: 1, method: 'tools/call' }, { toolCalls: 1, providerProfiles: 0, contentReads: 0 }],
  ['a batch', [tool('get_provider', { slug: 'a' }), tool('fetch', { id: 'news:b' }), rpc('ping')], { toolCalls: 2, providerProfiles: 1, contentReads: 1 }],
  ['a scalar', 7, { toolCalls: 0, providerProfiles: 0, contentReads: 0 }],
])('classifies %s', (_name, message, usage) => {
  expect(usageOf(JSON.stringify(message))).toEqual(usage);
});
it('classifies an unparseable body as no usage, leaving the parse error to the MCP handler', () => {
  expect(usageOf('{"method": "tools/call"')).toEqual({ toolCalls: 0, providerProfiles: 0, contentReads: 0 });
});

it('counts not-found lookups over a rolling hour, so a burst across a clock boundary still blocks', async () => {
  const { counter: quota } = counter();
  await quota.consume(call, QUOTAS.anonymous);
  vi.setSystemTime(new Date('2026-11-13T12:59:00Z'));
  await repeat(29, () => quota.recordNotFound(QUOTAS.anonymous));
  vi.setSystemTime(new Date('2026-11-13T13:00:30Z'));
  await quota.recordNotFound(QUOTAS.anonymous);
  expect(await quota.consume(call, QUOTAS.anonymous)).toMatchObject({ ok: false, quota: 'not_found_block' });
});

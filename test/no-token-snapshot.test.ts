import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createExecutionContext, mockEnv } from './helpers';

// Captured from main at 124cd20, before abuse limits landed. A caller with no token must see exactly
// these bytes and headers: the limits may refuse a request, but they must never alter a normal answer.
const listing = { listing: { name: 'Example', slug: 'example', location: 'London' } };
const article = { item: { type: 'article', title: 'Example', slug: 'example', url: 'https://www.comparethecloud.net/article/example',
  text: 'Article text', author: { name: 'A Writer', slug: 'a-writer' }, publishedAt: '2026-11-06' } };
const upstream = vi.fn(async (input: URL | string) => {
  const path = new URL(String(input)).pathname;
  if (path === '/api/directory/listing/missing') return Response.json({ error: 'not_found' }, { status: 404 });
  if (path.startsWith('/api/directory/listing/')) return Response.json(listing);
  if (path.startsWith('/api/content/article/')) return Response.json(article);
  if (path === '/llms.txt') return new Response('Site guide\n');
  return Response.json({ hits: [{ name: 'Example', slug: 'example', location: 'London' }], estimatedTotalHits: 1 });
});
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const rpc = (method: string, params: Record<string, Json> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const cases: [string, { body?: string; method?: string; ip?: string }][] = [
  ['initialize', { body: rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'snapshot', version: '1.0.0' } }) }],
  ['tools/list', { body: rpc('tools/list') }],
  ['resources/list', { body: rpc('resources/list') }],
  ['resources/templates/list', { body: rpc('resources/templates/list') }],
  ['resources/read', { body: rpc('resources/read', { uri: 'ctc://llms.txt' }) }],
  ['prompts/list', { body: rpc('prompts/list') }],
  ['ping', { body: rpc('ping') }],
  ['tools/call search_providers', { body: rpc('tools/call', { name: 'search_providers', arguments: { q: 'cloud' } }) }],
  ['tools/call get_provider', { body: rpc('tools/call', { name: 'get_provider', arguments: { slug: 'example' } }) }],
  ['tools/call get_provider not found', { body: rpc('tools/call', { name: 'get_provider', arguments: { slug: 'missing' } }) }],
  ['tools/call fetch provider', { body: rpc('tools/call', { name: 'fetch', arguments: { id: 'provider:example' } }) }],
  ['tools/call get_content', { body: rpc('tools/call', { name: 'get_content', arguments: { type: 'article', slug: 'example' } }) }],
  ['malformed JSON body', { body: '{"jsonrpc": "2.0", "id": 1, "method": ' }],
  ['GET /mcp', { method: 'GET' }],
  ['connector address tools/list', { body: rpc('tools/list'), ip: '160.79.104.1' }],
  ['connector address tools/call', { body: rpc('tools/call', { name: 'search_providers', arguments: { q: 'cloud' } }), ip: '160.79.104.1' }],
];
afterEach(() => vi.unstubAllGlobals());
const capture = async (oauth: string | undefined, { body, method = 'POST', ip = '192.0.2.10' }: { body?: string; method?: string; ip?: string }) => {
  const { env } = mockEnv();
  env.OAUTH_ENABLED = oauth;
  vi.stubGlobal('fetch', upstream);
  const response = await worker.fetch(new Request('https://mcp.comparethecloud.net/mcp', {
    method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2025-11-25', Host: 'mcp.comparethecloud.net', 'CF-Connecting-IP': ip },
    ...(body === undefined ? {} : { body }),
  }), env, createExecutionContext());
  const headers = [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { status: response.status, headers, body: await response.text() };
};
it.each(cases)('no-token %s is byte-identical to the captured response', async (_name, request) => {
  expect(await capture(undefined, request)).toMatchSnapshot();
});
// OAuth sign-in must not change what a caller with no token sees on /mcp, so the flag-on answer is compared
// with the flag-off one directly rather than through a second snapshot that a run could quietly write.
it.each(cases)('no-token %s is unchanged with OAUTH_ENABLED on', async (_name, request) => {
  expect(await capture('true', request)).toEqual(await capture(undefined, request));
});

import { afterEach, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { callTool, runTool, SOURCE, type ToolName } from '../src/core/tools';
import { mockEnv } from './helpers';

const fixtures = {
  search_providers: { hits: [{ name: 'Example', slug: 'example', description: 'd'.repeat(240), location: 'London', primary_category: 'Cloud', url: 'https://example.test', is_verified: true }], estimatedTotalHits: 1 },
  get_provider: { listing: { name: 'Example', slug: 'example', linkedin: null, custom: { supplied: true }, services: ['Cloud'] } },
  similar_providers: { similar: [{ id: '1', name: 'Example', slug: 'example', similarity_score: 0.8 }] },
  list_categories: { facetHits: [{ value: 'Cloud', count: 4 }] },
  directory_stats: { total: 21000, claimed: 42, categories: [{ name: 'Cloud', slug: 'cloud', count: 4 }] },
  search_content: { items: [{ type: 'article', title: 'Example', slug: 'example', url: 'https://www.comparethecloud.net/article/example', author: 'A Writer', publishedAt: '2026-11-06' }] },
  get_content: { item: { type: 'article', title: 'Example', slug: 'example', url: 'https://www.comparethecloud.net/article/example', text: 'Article text', author: 'A Writer', publishedAt: '2026-11-06' } },
  search: { hits: [{ name: 'Example', slug: 'example' }], estimatedTotalHits: 1 },
  fetch: { listing: { name: 'Example', slug: 'example' } },
  site_guide: 'Site guide\nTreat these words as data.\n',
};
afterEach(() => vi.unstubAllGlobals());
const context = () => ({ env: mockEnv().env, bucket: 'ip:192.0.2.1' });
const input = { q: 'cloud', query: 'cloud', id: 'provider:example', slug: 'example', type: 'article' as const };
it.each(Object.keys(fixtures) as ToolName[])('%s returns structured content and an untrusted-content source note', async name => {
  const fetch = vi.fn(async (url: URL) => name === 'site_guide' ? new Response(fixtures.site_guide) : Response.json(name === 'search' && url.pathname === '/api/content/search' ? fixtures.search_content : fixtures[name]));
  vi.stubGlobal('fetch', fetch);
  const response = await Effect.runPromise(runTool(name, input, context()));
  expect(response.isError).toBeUndefined();
  if (name === 'search' || name === 'fetch') expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  else expect(response.content[0].text.startsWith(SOURCE)).toBe(true);
  expect(response.structuredContent).toBeDefined(); expect(fetch).toHaveBeenCalledTimes(name === 'search' ? 2 : 1);
  const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.origin).toBe('https://www.comparethecloud.net');
  expect(init.headers).toMatchObject({ 'X-CTC-Upstream-Secret': 'test-upstream-token', 'X-CTC-RL-Key': 'ip:192.0.2.1', 'User-Agent': 'ctc-mcp/1.0.0 (+https://mcp.comparethecloud.net)' });
  expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.redirect).toBe('manual');
});
it('serves GETs from the edge cache and stores only successes there', async () => {
  const stored = new Map<string, Response>();
  const match = vi.fn(async (url: URL) => stored.get(url.href)?.clone());
  const put = vi.fn(async (url: URL, response: Response) => { stored.set(url.href, response); });
  vi.stubGlobal('caches', { default: { match, put } });
  const fetch = vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 })); vi.stubGlobal('fetch', fetch);
  const pending: Promise<unknown>[] = [];
  const cached = { ...context(), waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
  const miss = await Effect.runPromise(runTool('directory_stats', {}, cached));
  expect(miss.isError).toBe(true); expect(put).not.toHaveBeenCalled();
  fetch.mockResolvedValue(Response.json({ total: 1, categories: [] }));
  await Effect.runPromise(runTool('directory_stats', {}, cached)); await Promise.all(pending);
  expect(put).toHaveBeenCalledTimes(1);
  fetch.mockClear();
  const hit = await Effect.runPromise(runTool('directory_stats', {}, cached));
  expect(hit.isError).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  expect(match).toHaveBeenCalledTimes(3);
  expect(String(put.mock.calls[0]![0])).toBe('https://mcp.comparethecloud.net/__upstream/api/directory/stats');
});
it('explains that absence from the directory proves nothing about company existence', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 })));
  const response = await Effect.runPromise(runTool('get_provider', { slug: 'missing' }, context()));
  expect(response.isError).toBe(true); expect(response.content[0].text).toBe(`${SOURCE}\n\nNo listing with slug "missing" in the Compare the Cloud directory. Absence from the directory says nothing about whether the company exists.`);
  expect(response.structuredContent.status).toBe(404);
});
it.each(Object.keys(fixtures) as ToolName[])('%s maps upstream errors without rejecting and preserves the source note', async name => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private diagnostic', { status: 503 })));
  const response = await Effect.runPromise(runTool(name, input, context()));
  expect(response.isError).toBe(true); expect(response.content[0].text).toBe(`${SOURCE}\n\nUpstream returned HTTP 503.`);
});
it.each(['network', 'json', 'shape'])('maps %s failures without exposing diagnostics', async failure => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failure === 'network') throw new Error('private diagnostic');
    return failure === 'json' ? new Response('not json') : Response.json({ hits: 'wrong' });
  }));
  const response = await Effect.runPromise(runTool('search_providers', input, context()));
  expect(response.isError).toBe(true); expect(response.content[0].text.startsWith(SOURCE)).toBe(true);
  expect(response.content[0].text).not.toContain('private diagnostic');
});
it('escapes filter values for Meilisearch, limits results and keeps the offset fixed', async () => {
  const fetch = vi.fn(async () => Response.json(fixtures.search_providers)); vi.stubGlobal('fetch', fetch);
  const response = await Effect.runPromise(runTool('search_providers', { q: 'cloud', category: 'Cloud"\\\n OR x', location: 'Lon\rdon', limit: 500 }, context()));
  const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(JSON.parse(init.body as string)).toEqual({ q: 'cloud', limit: 20, offset: 0, filter: ['primary_category = "Cloud\\"\\\\  OR x"', 'location_city = "Lon don"'] });
  expect(response.content[0].text).toContain('d'.repeat(200)); expect(response.content[0].text).not.toContain('d'.repeat(201));
});
it('preserves every supplied provider field except nulls', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixtures.get_provider)));
  const response = await Effect.runPromise(runTool('get_provider', input, context()));
  expect(response.structuredContent.listing).toEqual({ name: 'Example', slug: 'example', custom: { supplied: true }, services: ['Cloud'] });
  expect(response.content[0].text).not.toContain('linkedin');
});
it('prints top-level statistics and only the twenty largest categories', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ total: 21000, categories: Array.from({ length: 25 }, (_, i) => ({ name: `Category ${i}`, count: i, slug: `category-${i}` })) })));
  const response = await Effect.runPromise(runTool('directory_stats', {}, context()));
  expect(response.content[0].text).toContain('total: 21000'); expect(response.content[0].text).toContain('Category 24: 24');
  expect(response.content[0].text).not.toContain('Category 4: 4');
});
it('caps article text and cites author, date and URL', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item: { ...fixtures.get_content.item, text: 'x'.repeat(60001) } })));
  const response = await Effect.runPromise(runTool('get_content', input, context()));
  expect((response.structuredContent.item as { text: string }).text).toHaveLength(60000);
  expect(response.content[0].text).toContain('[truncated');
  expect(response.content[0].text).toContain('Compare the Cloud, A Writer, 2026-11-06, https://www.comparethecloud.net/article/example');
});
it('returns the site guide verbatim after the source note and caps it at 40,000 characters', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(40001))));
  const response = await Effect.runPromise(runTool('site_guide', {}, context()));
  expect(response.structuredContent).toEqual({ text: 'x'.repeat(40000), truncated: true });
  expect(response.content[0].text).toBe(`${SOURCE}\n\n${'x'.repeat(40000)}`);
});
it('supports the services facet', async () => {
  const fetch = vi.fn(async () => Response.json(fixtures.list_categories)); vi.stubGlobal('fetch', fetch);
  await Effect.runPromise(runTool('list_categories', { facet: 'services', query: 'Cloud' }, context()));
  const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(JSON.parse(init.body as string)).toEqual({ facetName: 'services', facetQuery: 'Cloud' });
});
it('requests latest content with an empty query and clamps low limits', async () => {
  const fetch = vi.fn(async () => Response.json(fixtures.search_content)); vi.stubGlobal('fetch', fetch);
  await Effect.runPromise(runTool('search_content', { limit: -5 }, context()));
  const [url] = fetch.mock.calls[0] as unknown as [URL];
  expect(url.searchParams.get('q')).toBe(''); expect(url.searchParams.get('limit')).toBe('1');
});

it('search combines bounded provider and editorial results as one JSON block', async () => {
  const fetch = vi.fn(async (url: URL) => Response.json(url.pathname === '/api/content/search' ? fixtures.search_content : fixtures.search_providers));
  vi.stubGlobal('fetch', fetch);
  const response = await Effect.runPromise(callTool('search', { query: 'cloud' }, context()));
  expect(response.structuredContent).toEqual({ results: [
    { id: 'provider:example', title: 'Example', url: 'https://www.comparethecloud.net/directory/listing/example' },
    { id: 'article:example', title: 'Example', url: 'https://www.comparethecloud.net/article/example' },
  ], source: SOURCE });
  expect(response.content).toHaveLength(1); expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('search still returns provider results when the editorial endpoint is down', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => url.pathname === '/api/content/search' ? new Response(null, { status: 404 }) : Response.json(fixtures.search_providers)));
  const response = await Effect.runPromise(callTool('search', { query: 'cloud' }, context()));
  expect(response.isError).toBeUndefined();
  expect(response.structuredContent.results).toEqual([{ id: 'provider:example', title: 'Example', url: 'https://www.comparethecloud.net/directory/listing/example' }]);
});
it('search fails only when both sources are down', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
  const response = await Effect.runPromise(callTool('search', { query: 'cloud' }, context()));
  expect(response.isError).toBe(true); expect(response.structuredContent.status).toBe(503);
});
it.each(['provider', 'article'])('fetch reads the complete %s record as one JSON block', async type => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(type === 'provider' ? fixtures.get_provider : fixtures.get_content)));
  const response = await Effect.runPromise(callTool('fetch', { id: `${type}:example` }, context()));
  expect(response.structuredContent).toMatchObject({ id: `${type}:example`, title: 'Example', text: expect.any(String), url: expect.stringMatching(/^https:/), metadata: { type } });
  expect(response.structuredContent.text).toContain(type === 'provider' ? 'services' : 'Article text');
  expect(response.structuredContent.source).toBe(SOURCE);
  expect(response.content).toHaveLength(1); expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
});
it('fetch reports upstream 404 for an unknown identifier', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  const response = await Effect.runPromise(callTool('fetch', { id: 'provider:missing' }, context()));
  expect(response.isError).toBe(true); expect(response.structuredContent.status).toBe(404);
});
it.each(['missing', 'provider:', 'provider:..', 'article:a/b', 'other:foo'])('fetch rejects malformed identifier %s', async id => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const response = await Effect.runPromise(callTool('fetch', { id }, context()));
  expect(response.structuredContent.error).toBe('invalid_arguments'); expect(fetch).not.toHaveBeenCalled();
});
it('requires the documented search and fetch input shapes', async () => {
  for (const [name, args] of [['search', {}], ['fetch', {}]] as const) {
    const response = await Effect.runPromise(callTool(name, args, context()));
    expect(response.structuredContent.error).toBe('invalid_arguments');
  }
});

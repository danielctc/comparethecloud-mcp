import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { SOURCE } from '../src/core/tools';
import { createExecutionContext, mockEnv } from './helpers';

async function call(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const { env } = mockEnv();
  const response = await worker.fetch(new Request('https://mcp.comparethecloud.net/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2025-11-25', Host: 'mcp.comparethecloud.net', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env, createExecutionContext());
  const text = await response.text();
  const data = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5)) : JSON.parse(text);
  return { response, data };
}
afterEach(() => vi.unstubAllGlobals());
it('passes SDK-validated inputs to the Effect core and returns text plus structured JSON', async () => {
  const fetch = vi.fn(async () => Response.json({ hits: [{ name: 'Example', slug: 'example' }], estimatedTotalHits: 1 }));
  vi.stubGlobal('fetch', fetch);
  const { response, data } = await call('tools/call', { name: 'search_providers', arguments: { q: 'cloud', limit: 99 } });
  expect(response.status).toBe(200); expect(data.error).toBeUndefined(); expect(data.result.isError).toBeUndefined();
  expect(data.result.content[0].text).toContain(SOURCE);
  expect(data.result.structuredContent.estimatedTotalHits).toBe(1);
  const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(JSON.parse(init.body as string)).toMatchObject({ q: 'cloud', limit: 20 });
});
it('returns the missing-listing message as an MCP tool error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'missing' }, { status: 404 })));
  const { data } = await call('tools/call', { name: 'get_provider', arguments: { slug: 'missing' } });
  expect(data.result.isError).toBe(true);
  expect(data.result.content[0].text).toContain('Absence from the directory says nothing');
  expect(data.result.content[0].text.startsWith(SOURCE)).toBe(true);
});
it('reads the site-guide resource verbatim and caps it at 40,000 characters', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('guide\n'.repeat(10000))));
  const { data } = await call('resources/read', { uri: 'ctc://llms.txt' });
  expect(data.result.contents).toEqual([{ uri: 'ctc://llms.txt', mimeType: 'text/plain', text: 'guide\n'.repeat(10000).slice(0, 40000) }]);
});
it.each(['.', '..'])('rejects path traversal slug %s before making an upstream request', async slug => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { response, data } = await call('tools/call', { name: 'get_provider', arguments: { slug } });
  expect(response.status).toBe(200);
  expect(data.result.isError).toBe(true); expect(data.result.content[0].text.startsWith(SOURCE)).toBe(true);
  expect(data.result.structuredContent.error).toBe('invalid_arguments'); expect(fetch).not.toHaveBeenCalled();
});
it('accepts a browser origin for the public, cookie-free API', async () => {
  const { response, data } = await call('tools/list', {}, { Origin: 'https://client.example.test' });
  expect(response.status).toBe(200); expect(data.result.tools).toHaveLength(8);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
});
it.each(['null', 'not an origin', 'ftp://example.test', 'https://example.test/path'])('rejects invalid browser origin %s', async origin => {
  const { response } = await call('tools/list', {}, { Origin: origin });
  expect(response.status).toBe(403); expect(response.headers.get('X-CTC-Tier')).toBe('anonymous');
});

it.each([
  ['search_providers', { q: '' }],
  ['search_providers', { q: 'x'.repeat(201) }],
  ['get_content', { type: 'unknown', slug: 'example' }],
  ['unknown_tool', {}],
])('keeps the source note and structured errors for invalid calls to %s', async (name, args) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { response, data } = await call('tools/call', { name, arguments: args });
  expect(response.status).toBe(200); expect(data.result.isError).toBe(true);
  expect(data.result.content[0].text.startsWith(SOURCE)).toBe(true);
  expect(data.result.structuredContent.error).toBeDefined(); expect(fetch).not.toHaveBeenCalled();
});

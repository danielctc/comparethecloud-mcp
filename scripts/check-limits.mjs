import assert from 'node:assert/strict';
import { withDevServer, wrangler, rpc } from './dev-server.mjs';

// Runs the real QuotaCounter Durable Object and KV deny list in workerd, with a stand-in www Worker behind the
// SITE service binding, because a call that served nothing gets its profile charge back.
const call = (origin, ip, name, args) => rpc(origin, 'tools/call', { name, arguments: args }, { 'CF-Connecting-IP': ip });
await withDevServer(async origin => {
  for (let i = 0; i < 30; i++) {
    const { response } = await call(origin, '2001:db8:7:7::1', 'get_provider', { slug: 'example' });
    assert.equal(response.status, 200, `profile ${i + 1}`);
  }
  // Another address in the same IPv6 /64 shares the allowance.
  const refused = await call(origin, '2001:db8:7:7::ffff', 'fetch', { id: 'provider:example' });
  assert.equal(refused.response.status, 429);
  // A JSON-RPC error, so the MCP client shows the message.
  assert.equal(refused.data.error.data.quota, 'provider_profiles');
  assert.equal(refused.data.error.data.contact, 'https://www.comparethecloud.net/consultant');
  assert.ok(refused.data.error.message.includes('/consultant'));
  assert.ok(Number(refused.response.headers.get('Retry-After')) > 0);
  const other = await call(origin, '2001:db8:7:8::1', 'get_provider', { slug: 'example' });
  assert.equal(other.response.status, 200);
  assert.equal(other.data.result.structuredContent.listing.name, 'Gate listing');
  // 30 lookups of an unpublished slug block the address for an hour. Settling runs after each reply, so the
  // block is polled for rather than expected on the very next request.
  for (let i = 0; i < 30; i++) {
    const { response } = await call(origin, '192.0.2.50', 'get_provider', { slug: 'missing' });
    assert.equal(response.status, 200, `miss ${i + 1}`);
  }
  let blocked;
  for (let attempt = 0; attempt < 20 && blocked?.data?.error?.data?.quota !== 'not_found_block'; attempt++) {
    blocked = await call(origin, '192.0.2.50', 'search_providers', { q: 'cloud' });
    if (blocked.data?.error?.data?.quota !== 'not_found_block') await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(blocked.response.status, 429); assert.equal(blocked.data.error.data.quota, 'not_found_block');
  assert.equal(blocked.response.headers.get('Retry-After'), '3600');
  const listed = await rpc(origin, 'tools/list', {}, { 'CF-Connecting-IP': '2001:db8:7:7::1' });
  assert.equal(listed.response.status, 200);
  const denied = await rpc(origin, 'tools/list', {}, { 'CF-Connecting-IP': '192.0.2.99' });
  assert.equal(denied.response.status, 403); assert.equal(denied.data.error, 'denied');
  console.log('Profile quota tripped across one IPv6 /64, next /64 unaffected, 30 misses blocked an address for an hour, tools/list exempt, KV deny list refused.');
  console.log('LIMITS CHECK PASSED');
}, persistence => {
  wrangler(['kv', 'key', 'put', 'deny:ip:192.0.2.99', 'gate check', '--binding', 'MCP_KEYS', '--local', '--persist-to', persistence]);
}, ['scripts/upstream-stub/wrangler.jsonc']);

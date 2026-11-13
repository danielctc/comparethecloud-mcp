import assert from 'node:assert/strict';
import { withDevServer, wrangler, rpc } from './dev-server.mjs';

// Runs the real QuotaCounter Durable Object and KV deny list in workerd. The www service binding is not
// running locally, so tool calls report an upstream error; the quota still counts them, which is the point.
const call = (origin, ip, name, args) => rpc(origin, 'tools/call', { name, arguments: args }, { 'CF-Connecting-IP': ip });
await withDevServer(async origin => {
  for (let i = 0; i < 30; i++) {
    const { response } = await call(origin, '2001:db8:7:7::1', 'get_provider', { slug: 'example' });
    assert.equal(response.status, 200, `profile ${i + 1}`);
  }
  // Another address in the same IPv6 /64 shares the allowance.
  const refused = await call(origin, '2001:db8:7:7::ffff', 'fetch', { id: 'provider:example' });
  assert.equal(refused.response.status, 429);
  assert.equal(refused.data.quota, 'provider_profiles');
  assert.equal(refused.data.contact, 'https://www.comparethecloud.net/consultant');
  assert.ok(Number(refused.response.headers.get('Retry-After')) > 0);
  const other = await call(origin, '2001:db8:7:8::1', 'get_provider', { slug: 'example' });
  assert.equal(other.response.status, 200);
  const listed = await rpc(origin, 'tools/list', {}, { 'CF-Connecting-IP': '2001:db8:7:7::1' });
  assert.equal(listed.response.status, 200);
  const denied = await rpc(origin, 'tools/list', {}, { 'CF-Connecting-IP': '192.0.2.99' });
  assert.equal(denied.response.status, 403); assert.equal(denied.data.error, 'denied');
  console.log('Profile quota tripped across one IPv6 /64, next /64 unaffected, tools/list exempt, KV deny list refused.');
  console.log('LIMITS CHECK PASSED');
}, persistence => {
  wrangler(['kv', 'key', 'put', 'deny:ip:192.0.2.99', 'gate check', '--binding', 'MCP_KEYS', '--local', '--persist-to', persistence]);
});

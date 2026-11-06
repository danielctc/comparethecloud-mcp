import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { withDevServer, wrangler, rpc, initialiseParams } from './dev-server.mjs';

const key = `ctc_${randomBytes(20).toString('hex')}`;
const hash = createHash('sha256').update(key).digest('hex');
await withDevServer(async origin => {
  const anonymous = await rpc(origin, 'initialize', initialiseParams);
  assert.equal(anonymous.response.status, 200);
  assert.equal(anonymous.response.headers.get('X-CTC-Tier'), 'anonymous');
  assert.equal(anonymous.response.headers.get('X-RateLimit-Policy'), '60;w=60');
  const bad = await rpc(origin, 'initialize', initialiseParams, { Authorization: `Bearer ctc_${'z'.repeat(40)}` });
  assert.equal(bad.response.status, 401); assert.equal(bad.data.error, 'invalid_key');
  assert.equal(bad.response.headers.get('Access-Control-Allow-Origin'), '*');
  const good = await rpc(origin, 'initialize', initialiseParams, { Authorization: `Bearer ${key}` });
  assert.equal(good.response.status, 200);
  assert.equal(good.response.headers.get('X-CTC-Tier'), 'registered');
  assert.equal(good.response.headers.get('X-RateLimit-Policy'), '600;w=60');
  console.log('Anonymous, unknown key and hashed key seeded in local KV verified.');
  console.log('AUTH CHECK PASSED');
}, persistence => {
  wrangler(['kv', 'key', 'put', `key:${hash}`, JSON.stringify({ name: 'Gate check', email: 'gate@example.test',
    org: 'Local test', use: 'Checking local authentication', createdAt: new Date().toISOString(),
    tier: 'registered', status: 'active' }), '--binding', 'MCP_KEYS', '--local', '--persist-to', persistence]);
});

import assert from 'node:assert/strict';
import { withDevServer, rpc, initialiseParams } from './dev-server.mjs';

await withDevServer(async origin => {
  const initial = await rpc(origin, 'initialize', initialiseParams);
  assert.equal(initial.response.status, 200); assert.ok(!initial.data.error, JSON.stringify(initial.data));
  assert.equal(initial.data.result.serverInfo.name, 'comparethecloud');
  assert.equal(initial.data.result.serverInfo.title, 'Compare the Cloud');
  assert.equal(initial.data.result.instructions.split('\n').length, 3);
  const { response, data } = await rpc(origin, 'tools/list');
  assert.equal(response.status, 200); assert.ok(!data.error, JSON.stringify(data));
  const tools = data.result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'search_providers', 'get_provider', 'similar_providers', 'list_categories',
    'directory_stats', 'search_content', 'get_content', 'site_guide',
  ].sort());
  for (const tool of tools) {
    assert.ok(tool.title); assert.ok(tool.annotations.title);
    assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true); assert.equal(tool.annotations.openWorldHint, true);
  }
  const resources = await rpc(origin, 'resources/list');
  assert.equal(resources.data.result.resources[0].uri, 'ctc://llms.txt');
  assert.equal(resources.data.result.resources[0].mimeType, 'text/plain');
  for (const method of ['GET', 'DELETE']) {
    const response = await fetch(`${origin}/mcp`, { method });
    assert.equal(response.status, 405); await response.text();
  }
  for (const file of ['logo.png', 'logo-512.png', 'logo-400.png']) {
    const response = await fetch(`${origin}/${file}`); assert.equal(response.status, 200);
    assert.ok(response.headers.get('Content-Type').includes('image/png')); await response.arrayBuffer();
  }
  console.log('Initialise, eight annotated tools, site-guide resource, stateless methods and static logos verified.');
  console.log('TOOLS CHECK PASSED');
});

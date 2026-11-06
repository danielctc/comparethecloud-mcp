import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { version } from '../package.json';
import { TIERS } from '../src/env';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const ENDPOINT = 'https://mcp.comparethecloud.net/mcp';

it.each(['.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', 'gemini-extension.json'])('%s carries the package version', path => {
  expect(json(path).version).toBe(version);
});
it.each(['.mcp.json', 'mcp.json', 'gemini-extension.json'])('%s points at the live endpoint', path => {
  const servers = json(path).mcpServers as Record<string, { url: string }>;
  expect(Object.values(servers).map(server => server.url)).toEqual([ENDPOINT]);
});
it('advertises the limits the ratelimit bindings enforce', () => {
  // wrangler.jsonc allows comments, so the bindings are read with a regex rather than JSON.parse.
  const config = read('wrangler.jsonc');
  for (const { binding, limit, window } of Object.values(TIERS)) {
    const line = new RegExp(`"name": "${binding}".*"simple": \\{ "limit": (\\d+), "period": (\\d+) \\}`).exec(config);
    expect(line, binding).not.toBeNull();
    expect([Number(line![1]), Number(line![2])]).toEqual([limit, window]);
  }
});

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The retired Workers pool bundles a runtime older than our compatibility date.
// Unit tests mock network and bindings; gate scripts exercise the current runtime.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': resolve(dirname(fileURLToPath(import.meta.url)), 'test/stubs/cloudflare-workers.ts') } },
  test: { include: ['test/**/*.test.ts'], restoreMocks: true },
});

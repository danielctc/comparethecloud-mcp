import { defineConfig } from 'vitest/config';

// The retired Workers pool bundles a runtime older than our compatibility date.
// Unit tests mock network and bindings; gate scripts exercise the current runtime.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], restoreMocks: true },
});

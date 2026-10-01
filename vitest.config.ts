import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Satellite package tests run against this checkout's source, not dist/.
    alias: [{ find: /^@smallchat\/core$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }],
  },
  test: {
    include: ['src/**/*.test.ts', 'bench/**/*.test.ts', 'packages/{nextjs,react,playground}/src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});

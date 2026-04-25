import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Unit tests only — these adapters are pure logic (binding wrappers,
// metadata stamping, prefix munging). Each suite mocks
// `cloudflare:workers` so we never need real CF resources to run.

const cfWorkersMock = fileURLToPath(new URL('./tests/_cf-workers-mock.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': cfWorkersMock,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})

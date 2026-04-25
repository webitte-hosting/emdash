// vectorizeTenantPlugin runtime: every upsert gets `tenant_id` stamped
// in metadata + ID-prefix; every query gets `filter: { tenant_id }`
// forced. Mocks AI + Vectorize bindings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setEnv } from '../_cf-workers-mock.js'
import { createPlugin } from '../../src/vectorize/runtime.js'

const TENANT = 'ten_alpha'

function makeBindings() {
  return {
    AI: {
      run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })),
    },
    VECTORIZE: {
      upsert: vi.fn(async () => undefined),
      deleteByIds: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ matches: [] })),
    },
    TENANT_ID: TENANT,
  }
}

let bindings: ReturnType<typeof makeBindings>

beforeEach(() => {
  bindings = makeBindings()
  setEnv(bindings)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Astro on CF exposes env via a Symbol-keyed locals object on the
// request. Helper to fake it in plugin tests.
function fakeRequest(env: unknown): { url: string; headers: { get(name: string): string | null } } {
  const req = { url: 'https://test/_emdash/api/plugins/vectorize-tenant/query', headers: { get: () => null } } as Record<string, unknown>
  ;(req as Record<symbol, unknown>)[Symbol.for('astro.locals')] = { runtime: { env } }
  return req as { url: string; headers: { get(name: string): string | null } }
}

describe('vectorizeTenantPlugin runtime', () => {
  it('plugin definition has expected hooks + routes', () => {
    const plugin = createPlugin({ binding: 'VECTORIZE', tenantIdEnvVar: 'TENANT_ID' })
    expect(plugin.id).toBe('webitte-vectorize-tenant')
    expect(plugin.hooks?.['content:afterSave']).toBeDefined()
    expect(plugin.hooks?.['content:afterDelete']).toBeDefined()
    expect(plugin.routes?.query).toBeDefined()
  })

  it('query route forces filter.tenant_id', async () => {
    const plugin = createPlugin({ binding: 'VECTORIZE', tenantIdEnvVar: 'TENANT_ID' })
    // Prime cachedEnv via a query call.
    await plugin.routes!.query.handler({
      request: fakeRequest(bindings),
      input: { q: 'hello' },
    } as unknown as Parameters<typeof plugin.routes.query.handler>[0])
    expect(bindings.VECTORIZE.query).toHaveBeenCalledTimes(1)
    const opts = bindings.VECTORIZE.query.mock.calls[0]![1]
    expect(opts.filter).toMatchObject({ tenant_id: TENANT })
  })

  it('query route DOES NOT let caller override filter.tenant_id', async () => {
    const plugin = createPlugin({ binding: 'VECTORIZE', tenantIdEnvVar: 'TENANT_ID' })
    // Caller tries to spoof a different tenant.
    await plugin.routes!.query.handler({
      request: fakeRequest(bindings),
      input: { q: 'hi', filter: { tenant_id: 'ten_other' } },
    } as unknown as Parameters<typeof plugin.routes.query.handler>[0])
    const opts = bindings.VECTORIZE.query.mock.calls[0]![1]
    // Forced override stays in place even if caller passed a different tenant_id.
    expect(opts.filter.tenant_id).toBe(TENANT)
  })

  it('content:afterSave hook upserts with tenant-scoped ID + metadata', async () => {
    const plugin = createPlugin({ binding: 'VECTORIZE', tenantIdEnvVar: 'TENANT_ID' })
    // Prime cachedEnv first via a route call.
    await plugin.routes!.query.handler({
      request: fakeRequest(bindings),
      input: { q: 'prime' },
    } as unknown as Parameters<typeof plugin.routes.query.handler>[0])
    bindings.VECTORIZE.upsert.mockClear()

    await plugin.hooks!['content:afterSave'].handler(
      {
        content: { id: 'post_42', title: 'hello', slug: 'hello-world', body: 'lorem ipsum' },
        collection: 'posts',
      } as unknown,
      undefined as unknown,
    )
    expect(bindings.VECTORIZE.upsert).toHaveBeenCalledTimes(1)
    const records = bindings.VECTORIZE.upsert.mock.calls[0]![0]
    expect(records.length).toBe(1)
    expect(records[0].id).toBe(`${TENANT}:post_42`)
    expect(records[0].metadata).toMatchObject({
      tenant_id: TENANT,
      collection: 'posts',
      original_id: 'post_42',
      slug: 'hello-world',
      title: 'hello',
    })
  })

  it('content:afterDelete uses scoped id', async () => {
    const plugin = createPlugin({ binding: 'VECTORIZE', tenantIdEnvVar: 'TENANT_ID' })
    // Prime cachedEnv.
    await plugin.routes!.query.handler({
      request: fakeRequest(bindings),
      input: { q: 'prime' },
    } as unknown as Parameters<typeof plugin.routes.query.handler>[0])
    bindings.VECTORIZE.deleteByIds.mockClear()

    await plugin.hooks!['content:afterDelete'].handler(
      { id: 'post_42', collection: 'posts' } as unknown,
      undefined as unknown,
    )
    expect(bindings.VECTORIZE.deleteByIds).toHaveBeenCalledWith([`${TENANT}:post_42`])
  })

  it('query before any route call (no cached env) returns binding-unavailable error', async () => {
    // Fresh plugin instance; no cachedEnv.
    const plugin = createPlugin({ binding: 'VECTORIZE', tenantIdEnvVar: 'TENANT_ID' })
    // Strip cached env path: pass request with NO astro.locals shim.
    const r = await plugin.routes!.query.handler({
      request: { url: '', headers: { get: () => null } },
      input: { q: 'hello' },
    } as unknown as Parameters<typeof plugin.routes.query.handler>[0])
    expect((r as { error?: string }).error).toMatch(/binding/i)
  })
})

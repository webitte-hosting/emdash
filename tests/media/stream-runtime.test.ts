// tenantCloudflareStream runtime: same shape of guarantees as Images.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setEnv } from '../_cf-workers-mock.js'
import { createMediaProvider } from '../../src/media/stream-runtime.js'

const TENANT = 'ten_alpha'

beforeEach(() => {
  setEnv({
    TENANT_ID: TENANT,
    CF_ACCOUNT_ID: 'acct_x',
    CF_STREAM_TOKEN: 'cf_stream_xxx',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl) as unknown as typeof fetch
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('tenantCloudflareStream runtime', () => {
  it('upload sends meta.tenant_id on direct_upload', async () => {
    const seen: unknown[] = []
    mockFetch(async (url, init) => {
      if (url.endsWith('/direct_upload')) {
        const body = JSON.parse(init?.body as string)
        seen.push(body)
        return new Response(
          JSON.stringify({ success: true, result: { uid: 'vid_1', uploadURL: 'https://upload.example/x' } }),
        )
      }
      if (url.startsWith('https://upload.example/')) {
        return new Response('', { status: 200 })
      }
      // Post-upload GET
      return new Response(
        JSON.stringify({
          success: true,
          result: { uid: 'vid_1', meta: { tenant_id: TENANT, name: 'pic.mp4' }, uploaded: 't' },
        }),
      )
    })
    const provider = createMediaProvider({})
    await provider.upload({ file: new Blob(['x']), filename: 'pic.mp4' })
    expect((seen[0] as { meta: { tenant_id: string } }).meta.tenant_id).toBe(TENANT)
  })

  it('list filters by tenant_id metadata', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            { uid: 'a', meta: { tenant_id: TENANT, name: 'mine' }, uploaded: '2026-01-01' },
            { uid: 'b', meta: { tenant_id: 'ten_other' }, uploaded: '2026-01-02' },
            { uid: 'c', uploaded: '2026-01-03' /* no meta */ },
          ],
        }),
      ),
    )
    const provider = createMediaProvider({})
    const r = await provider.list({})
    expect(r.items.map((i) => i.id)).toEqual(['a'])
  })

  it('get returns null on cross-tenant uid', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { uid: 'b', meta: { tenant_id: 'ten_other' }, uploaded: 't' },
        }),
      ),
    )
    const provider = createMediaProvider({})
    expect(await provider.get('b')).toBeNull()
  })

  it('delete refuses cross-tenant', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { uid: 'b', meta: { tenant_id: 'ten_other' }, uploaded: 't' },
        }),
      ),
    )
    const provider = createMediaProvider({})
    await expect(provider.delete('b')).rejects.toThrow(/does not belong to this tenant/)
  })

  it('throws when TENANT_ID missing', async () => {
    setEnv({ CF_ACCOUNT_ID: 'acct_x', CF_STREAM_TOKEN: 'tok' })
    const provider = createMediaProvider({})
    await expect(provider.list({})).rejects.toThrow(/TENANT_ID/)
  })
})

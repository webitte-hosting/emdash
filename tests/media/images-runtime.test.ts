// tenantCloudflareImages runtime: every CF Images API call should be
// scoped by `metadata.tenant_id`. Mock fetch to inspect upload bodies
// + filter behavior on list/get.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setEnv } from '../_cf-workers-mock.js'
import { createMediaProvider } from '../../src/media/images-runtime.js'

const TENANT = 'ten_alpha'

beforeEach(() => {
  setEnv({
    TENANT_ID: TENANT,
    CF_ACCOUNT_ID: 'acct_x',
    CF_IMAGES_TOKEN: 'cf_images_xxx',
    CF_IMAGES_ACCOUNT_HASH: 'hashy',
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

describe('tenantCloudflareImages runtime', () => {
  it('upload stamps metadata.tenant_id and ID prefix', async () => {
    const seen: { url: string; body: FormData }[] = []
    mockFetch(async (url, init) => {
      seen.push({ url, body: init?.body as FormData })
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: `${TENANT}/abc123`, uploaded: 'now', requireSignedURLs: false, variants: [] },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const provider = createMediaProvider({})
    await provider.upload({ file: new Blob(['x']), filename: 'pic.jpg' })
    expect(seen.length).toBeGreaterThan(0)
    const first = seen[0]!
    const id = first.body.get('id') as string
    const meta = JSON.parse(first.body.get('metadata') as string)
    expect(id.startsWith(`${TENANT}/`)).toBe(true)
    expect(meta.tenant_id).toBe(TENANT)
  })

  it('list filters out images that do NOT match tenant_id', async () => {
    mockFetch(async (url) => {
      if (url.includes('format=json')) {
        return new Response(JSON.stringify({ width: 100, height: 100 }))
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            images: [
              { id: `${TENANT}/mine`, uploaded: 't', requireSignedURLs: false, variants: [], meta: { tenant_id: TENANT } },
              { id: 'ten_other/theirs', uploaded: 't', requireSignedURLs: false, variants: [], meta: { tenant_id: 'ten_other' } },
              { id: 'ten_other/anon', uploaded: 't', requireSignedURLs: false, variants: [] /* no meta */ },
            ],
          },
        }),
      )
    })
    const provider = createMediaProvider({})
    const r = await provider.list({})
    expect(r.items.map((i) => i.id)).toEqual([`${TENANT}/mine`])
  })

  it('get returns null when image belongs to a different tenant', async () => {
    mockFetch(async (url) => {
      if (url.includes('format=json')) {
        return new Response(JSON.stringify({ width: 1, height: 1 }))
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: 'ten_other/x', uploaded: 't', requireSignedURLs: false, variants: [], meta: { tenant_id: 'ten_other' } },
        }),
      )
    })
    const provider = createMediaProvider({})
    const r = await provider.get('ten_other/x')
    expect(r).toBeNull()
  })

  it('delete refuses cross-tenant id', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { id: 'ten_other/x', uploaded: 't', requireSignedURLs: false, variants: [], meta: { tenant_id: 'ten_other' } },
        }),
      ),
    )
    const provider = createMediaProvider({})
    await expect(provider.delete('ten_other/x')).rejects.toThrow(
      /does not belong to this tenant/,
    )
  })

  it('delete proceeds for own id', async () => {
    let deleteCalled = false
    mockFetch(async (url, init) => {
      if (init?.method === 'DELETE') {
        deleteCalled = true
        return new Response(JSON.stringify({ success: true }))
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: `${TENANT}/x`, uploaded: 't', requireSignedURLs: false, variants: [], meta: { tenant_id: TENANT } },
        }),
      )
    })
    const provider = createMediaProvider({})
    await provider.delete(`${TENANT}/x`)
    expect(deleteCalled).toBe(true)
  })

  it('throws when TENANT_ID env var is missing', async () => {
    setEnv({
      CF_ACCOUNT_ID: 'acct_x',
      CF_IMAGES_TOKEN: 'tok',
      CF_IMAGES_ACCOUNT_HASH: 'hashy',
    })
    const provider = createMediaProvider({})
    await expect(provider.list({})).rejects.toThrow(/TENANT_ID/)
  })
})

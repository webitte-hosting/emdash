// prefixedR2 runtime: every key on its way through the bucket gets
// `${env.TENANT_PREFIX}` stamped on; on the way back out the prefix is
// stripped. These tests mock R2Bucket and assert the call arguments.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setEnv } from '../_cf-workers-mock.js'
import { createStorage } from '../../src/storage/r2-runtime.js'

const TENANT = 'ten_alpha/'

function makeBucket() {
  return {
    put: vi.fn(async (_key: string, _body: unknown, _opts: unknown) => ({ size: 123 })),
    get: vi.fn(async (_key: string) => ({
      body: 'stream-stub' as unknown as ReadableStream<Uint8Array>,
      httpMetadata: { contentType: 'image/png' },
      size: 99,
    })),
    head: vi.fn(async (_key: string) => ({})),
    delete: vi.fn(async (_key: string) => undefined),
    list: vi.fn(async (_opts: { prefix?: string; limit?: number; cursor?: string }) => ({
      objects: [
        { key: TENANT + 'foo.jpg', size: 1, uploaded: new Date(0), etag: 'a' },
        { key: TENANT + 'sub/bar.jpg', size: 2, uploaded: new Date(0), etag: 'b' },
      ],
      truncated: false,
    })),
  }
}

let bucket: ReturnType<typeof makeBucket>

beforeEach(() => {
  bucket = makeBucket()
  setEnv({ MEDIA: bucket, TENANT_PREFIX: TENANT })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('prefixedR2 runtime', () => {
  it('upload prepends the tenant prefix to the key', async () => {
    const storage = createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })
    const result = await storage.upload({
      key: 'foo.jpg',
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
    })
    expect(bucket.put).toHaveBeenCalledTimes(1)
    expect(bucket.put.mock.calls[0]![0]).toBe(`${TENANT}foo.jpg`)
    expect(result.key).toBe('foo.jpg') // user gets back the un-prefixed key
    expect(result.size).toBe(123)
  })

  it('download fetches with the prefixed key', async () => {
    const storage = createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })
    const r = await storage.download('foo.jpg')
    expect(bucket.get).toHaveBeenCalledWith(`${TENANT}foo.jpg`)
    expect(r.contentType).toBe('image/png')
    expect(r.size).toBe(99)
  })

  it('delete + exists prepend prefix', async () => {
    const storage = createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })
    await storage.delete('zap.bin')
    expect(bucket.delete).toHaveBeenCalledWith(`${TENANT}zap.bin`)
    await storage.exists('zap.bin')
    expect(bucket.head).toHaveBeenCalledWith(`${TENANT}zap.bin`)
  })

  it('list anchors prefix in tenant slot AND strips it from results', async () => {
    const storage = createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })
    const r = await storage.list({ prefix: 'sub/' })
    expect(bucket.list).toHaveBeenCalledWith({
      prefix: `${TENANT}sub/`,
      limit: undefined,
      cursor: undefined,
    })
    // Returned keys must NOT include the tenant prefix.
    expect(r.files.map((f) => f.key)).toEqual(['foo.jpg', 'sub/bar.jpg'])
  })

  it('list with no user prefix still anchors at tenant', async () => {
    const storage = createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })
    await storage.list({})
    expect(bucket.list).toHaveBeenCalledWith({
      prefix: TENANT,
      limit: undefined,
      cursor: undefined,
    })
  })

  it('TENANT_PREFIX without trailing slash is normalized', async () => {
    setEnv({ MEDIA: bucket, TENANT_PREFIX: 'ten_beta' })
    const storage = createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })
    await storage.upload({ key: 'x', body: new Uint8Array(), contentType: 'application/octet-stream' })
    expect(bucket.put.mock.calls[0]![0]).toBe('ten_beta/x')
  })

  it('throws if binding missing', () => {
    setEnv({ TENANT_PREFIX: TENANT })
    expect(() => createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })).toThrow(
      /R2 binding "MEDIA" not found/,
    )
  })

  it('throws if TENANT_PREFIX env var unset', () => {
    setEnv({ MEDIA: bucket })
    expect(() => createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })).toThrow(
      /TENANT_PREFIX/,
    )
  })

  // EmDash's media upload route at /_emdash/api/media/upload-url checks
  // err.code === 'NOT_SUPPORTED' to return 501 (admin UI then falls back
  // to direct upload). A plain Error here would surface as a generic 500
  // and break upload entirely.
  it('getSignedUploadUrl throws EmDashStorageError with code=NOT_SUPPORTED', async () => {
    const storage = createStorage({ binding: 'MEDIA', prefixEnvVar: 'TENANT_PREFIX' })
    await expect(storage.getSignedUploadUrl()).rejects.toMatchObject({
      name: 'EmDashStorageError',
      code: 'NOT_SUPPORTED',
    })
  })
})

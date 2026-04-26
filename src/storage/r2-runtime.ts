// Tenant-prefixed R2 storage. Every key gets `${TENANT_PREFIX}${key}` so a
// single shared bucket can hold every tenant's media without collision.
//
// Listing is the tricky bit: callers pass `prefix` relative to their own
// view, but the bucket sees absolute keys. We anchor the bucket-side
// prefix at `TENANT_PREFIX + (callerPrefix || '')`, then strip the tenant
// segment off every returned key before handing it back. EmDash never
// learns the absolute key.
//
// `env.TENANT_PREFIX` MUST end with a `/`. wfp-deploy injects this.

import { env } from 'cloudflare:workers'
import { EmDashStorageError } from 'emdash'

const TRAILING_SLASH_REGEX = /\/$/

interface RuntimeConfig {
  binding: string
  publicUrl?: string
  prefixEnvVar: string
}

interface UploadInput {
  key: string
  body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | Blob
  contentType: string
}

interface UploadResult {
  key: string
  url: string
  size: number
}

interface DownloadResult {
  body: ReadableStream<Uint8Array>
  contentType: string
  size: number
}

interface ListOptions {
  prefix?: string
  limit?: number
  cursor?: string
}

interface ListedFile {
  key: string
  size: number
  lastModified: Date
  etag: string
}

interface ListResult {
  files: ListedFile[]
  nextCursor?: string
}

class PrefixedR2Storage {
  readonly #bucket: R2Bucket
  readonly #publicUrl: string | undefined
  readonly #tenantPrefix: string

  constructor(bucket: R2Bucket, publicUrl: string | undefined, tenantPrefix: string) {
    this.#bucket = bucket
    this.#publicUrl = publicUrl
    // Force trailing slash so concatenation gives a clean separator.
    this.#tenantPrefix = tenantPrefix.endsWith('/') ? tenantPrefix : `${tenantPrefix}/`
  }

  #abs(key: string): string {
    return this.#tenantPrefix + key
  }

  #rel(absKey: string): string {
    return absKey.startsWith(this.#tenantPrefix)
      ? absKey.slice(this.#tenantPrefix.length)
      : absKey
  }

  async upload(options: UploadInput): Promise<UploadResult> {
    const absKey = this.#abs(options.key)
    const result = await this.#bucket.put(absKey, options.body, {
      httpMetadata: { contentType: options.contentType },
    })
    if (!result) {
      throw new Error(`upload failed for "${options.key}"`)
    }
    return {
      key: options.key,
      url: this.getPublicUrl(options.key),
      size: result.size,
    }
  }

  async download(key: string): Promise<DownloadResult> {
    const obj = await this.#bucket.get(this.#abs(key))
    if (!obj || !('body' in obj) || !obj.body) {
      throw new Error(`not found: ${key}`)
    }
    return {
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      size: obj.size,
    }
  }

  async delete(key: string): Promise<void> {
    await this.#bucket.delete(this.#abs(key))
  }

  async exists(key: string): Promise<boolean> {
    const head = await this.#bucket.head(this.#abs(key))
    return head !== null
  }

  async list(options: ListOptions = {}): Promise<ListResult> {
    // Anchor the list to the tenant's slice. The user-supplied prefix
    // (if any) is appended underneath.
    const absPrefix = this.#tenantPrefix + (options.prefix ?? '')
    const response = await this.#bucket.list({
      prefix: absPrefix,
      limit: options.limit,
      cursor: options.cursor,
    })
    return {
      files: response.objects.map((item) => ({
        key: this.#rel(item.key),
        size: item.size,
        lastModified: item.uploaded,
        etag: item.etag,
      })),
      nextCursor: response.truncated ? response.cursor : undefined,
    }
  }

  async getSignedUploadUrl(): Promise<never> {
    // EmDash's media upload route checks `error.code === 'NOT_SUPPORTED'`
    // to return 501 (which the admin UI catches and falls back to direct
    // upload through `/api/media`). Throwing a plain Error here would
    // surface as a generic 500 with "Failed to generate upload URL" and
    // skip the fallback.
    throw new EmDashStorageError(
      'R2 bindings do not support pre-signed upload URLs. Upload through the Worker instead.',
      'NOT_SUPPORTED',
    )
  }

  getPublicUrl(key: string): string {
    if (this.#publicUrl) {
      return `${this.#publicUrl.replace(TRAILING_SLASH_REGEX, '')}/${key}`
    }
    // Mirrors @emdash-cms/cloudflare's R2Storage.getPublicUrl — keys are
    // served via /_emdash/api/media/file/<key>. Crucially this is the
    // tenant-relative key, since the API handler runs inside the tenant
    // Worker which sees the same prefixed adapter.
    return `/_emdash/api/media/file/${key}`
  }
}

export function createStorage(rawConfig: Record<string, unknown>): PrefixedR2Storage {
  const config = rawConfig as unknown as RuntimeConfig
  if (!config.binding) {
    throw new Error('prefixedR2: missing binding name')
  }

  const bucket = (env as Record<string, unknown>)[config.binding] as R2Bucket | undefined
  if (!bucket) {
    throw new Error(
      `prefixedR2: R2 binding "${config.binding}" not found. Did wfp-deploy attach it?`,
    )
  }

  const tenantPrefix = (env as Record<string, unknown>)[config.prefixEnvVar] as string | undefined
  if (!tenantPrefix) {
    throw new Error(
      `prefixedR2: env var "${config.prefixEnvVar}" not set. wfp-deploy must inject this for every tenant.`,
    )
  }

  return new PrefixedR2Storage(bucket, config.publicUrl, tenantPrefix)
}

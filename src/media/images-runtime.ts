// Tenant-scoped Cloudflare Images media provider.
//
// Stamps every upload with an ID prefix (`${tenant_id}/${random}`) AND a
// metadata.tenant_id field. List / get / delete then filter by metadata
// to prevent cross-tenant access from the CMS admin UI. The Images
// account itself is shared across tenants — CF Images delivery URLs are
// unauthenticated regardless, so the threat model here is "tenant A's
// admin must not see tenant B's images", not "user must not view by
// guessed URL".
//
// CF Images API has no server-side metadata filter on list, so we
// paginate and filter client-side. For tenants with < a few thousand
// images this is fine; larger tenants would need a side index.

import { env } from 'cloudflare:workers'

interface ImagesConfig {
  id?: string
  accountId?: string
  accountIdEnvVar?: string
  apiToken?: string
  apiTokenEnvVar?: string
  accountHash?: string
  accountHashEnvVar?: string
  tenantIdEnvVar?: string
  deliveryDomain?: string
  defaultVariant?: string
}

interface MediaListOptions {
  cursor?: string
  limit?: number
}

interface MediaItem {
  id: string
  filename: string
  mimeType: string
  width?: number
  height?: number
  previewUrl: string
  meta: Record<string, unknown>
}

interface MediaListResult {
  items: MediaItem[]
  nextCursor?: string
}

interface CloudflareImage {
  id: string
  filename?: string
  uploaded: string
  requireSignedURLs: boolean
  variants: string[]
  meta?: Record<string, unknown>
}

interface ListResp {
  success: boolean
  errors?: Array<{ message: string }>
  result: { images: CloudflareImage[]; continuation_token?: string }
}

interface SingleResp {
  success: boolean
  errors?: Array<{ message: string }>
  result: CloudflareImage
}

function envVar(name: string): string | undefined {
  return (env as Record<string, string | undefined>)[name]
}

function resolve(direct: string | undefined, varName: string | undefined, fallbackVar: string, label: string): string {
  if (direct) return direct
  const value = envVar(varName ?? fallbackVar)
  if (!value) throw new Error(`${label}: missing ${varName ?? fallbackVar}`)
  return value
}

function getTenantId(config: ImagesConfig): string {
  const v = envVar(config.tenantIdEnvVar ?? 'TENANT_ID')
  if (!v) throw new Error(`tenantCloudflareImages: env "${config.tenantIdEnvVar ?? 'TENANT_ID'}" not set`)
  return v
}

function tenantOf(image: CloudflareImage): string | undefined {
  const meta = image.meta as Record<string, unknown> | undefined
  const v = meta?.tenant_id
  return typeof v === 'string' ? v : undefined
}

function toNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

export const createMediaProvider = (rawConfig: Record<string, unknown>) => {
  const config = rawConfig as ImagesConfig
  const defaultVariant = config.defaultVariant ?? 'public'
  const deliveryDomain = config.deliveryDomain

  const apiBase = () =>
    `https://api.cloudflare.com/client/v4/accounts/${resolve(config.accountId, config.accountIdEnvVar, 'CF_ACCOUNT_ID', 'tenantCloudflareImages')}/images/v1`
  const apiToken = () => resolve(config.apiToken, config.apiTokenEnvVar, 'CF_IMAGES_TOKEN', 'tenantCloudflareImages')
  const accountHash = () =>
    resolve(config.accountHash, config.accountHashEnvVar, 'CF_IMAGES_ACCOUNT_HASH', 'tenantCloudflareImages')
  const headers = () => ({ Authorization: `Bearer ${apiToken()}` })
  const deliveryBase = () => (deliveryDomain ? `https://${deliveryDomain}` : 'https://imagedelivery.net')

  const buildUrl = (id: string, t?: { w?: number; h?: number; fit?: string }) => {
    const base = `${deliveryBase()}/${accountHash()}/${encodeURIComponent(id)}`
    if (!t || Object.keys(t).length === 0) return `${base}/${defaultVariant}`
    const parts: string[] = []
    if (t.w) parts.push(`w=${t.w}`)
    if (t.h) parts.push(`h=${t.h}`)
    if (t.fit) parts.push(`fit=${t.fit}`)
    return `${base}/${parts.join(',')}`
  }

  const fetchDimensions = async (id: string): Promise<{ width: number; height: number } | null> => {
    try {
      const res = await fetch(`${deliveryBase()}/${accountHash()}/${encodeURIComponent(id)}/format=json`)
      if (!res.ok) return null
      const data = (await res.json()) as { width: number; height: number }
      return { width: data.width, height: data.height }
    } catch {
      return null
    }
  }

  const toMediaItem = async (img: CloudflareImage): Promise<MediaItem> => {
    const dims = await fetchDimensions(img.id)
    return {
      id: img.id,
      filename: img.filename ?? img.id,
      mimeType: 'image/jpeg',
      width: dims?.width ?? toNumber((img.meta as Record<string, unknown> | undefined)?.width),
      height: dims?.height ?? toNumber((img.meta as Record<string, unknown> | undefined)?.height),
      previewUrl: buildUrl(img.id, { w: 400, fit: 'scale-down' }),
      meta: { variants: img.variants, uploaded: img.uploaded, tenant_id: tenantOf(img) },
    }
  }

  return {
    async list(options: MediaListOptions): Promise<MediaListResult> {
      const tenantId = getTenantId(config)
      const items: MediaItem[] = []
      let cursor = options.cursor
      // Page until we either fill the requested limit or exhaust the
      // account. Cap pages so a heavily mixed account doesn't blow the
      // request budget.
      const limit = options.limit ?? 50
      const maxPages = 5
      for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams()
        if (cursor) params.set('continuation_token', cursor)
        params.set('per_page', '100')
        const res = await fetch(`${apiBase()}?${params}`, { headers: headers() })
        if (!res.ok) throw new Error(`CF Images list ${res.status}`)
        const data = (await res.json()) as ListResp
        if (!data.success) throw new Error(data.errors?.[0]?.message ?? 'CF Images list failed')
        const tenantSlice = data.result.images.filter(
          (img) => !img.requireSignedURLs && tenantOf(img) === tenantId,
        )
        for (const img of tenantSlice) {
          items.push(await toMediaItem(img))
          if (items.length >= limit) break
        }
        cursor = data.result.continuation_token
        if (!cursor || items.length >= limit) break
      }
      return { items, nextCursor: cursor }
    },

    async get(id: string): Promise<MediaItem | null> {
      const tenantId = getTenantId(config)
      const res = await fetch(`${apiBase()}/${encodeURIComponent(id)}`, { headers: headers() })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`CF Images get ${res.status}`)
      const data = (await res.json()) as SingleResp
      if (!data.success) return null
      const img = data.result
      if (img.requireSignedURLs) return null
      // Cross-tenant access guard. A leaked ID still resolves at the
      // delivery URL (CF Images is public by default), but the admin
      // UI can't fetch / display it.
      if (tenantOf(img) !== tenantId) return null
      return toMediaItem(img)
    },

    async upload(input: { file: Blob; filename: string; alt?: string }): Promise<MediaItem> {
      const tenantId = getTenantId(config)
      const formData = new FormData()
      formData.append('file', input.file, input.filename)
      formData.append('requireSignedURLs', 'false')
      // Force the ID into a tenant-scoped path so CF dashboard browsing
      // stays organized and the metadata stamp has a fallback.
      const randomSuffix = crypto.randomUUID().slice(0, 12)
      formData.append('id', `${tenantId}/${randomSuffix}`)
      const metadata: Record<string, string> = { tenant_id: tenantId }
      if (input.alt) metadata.alt = input.alt
      formData.append('metadata', JSON.stringify(metadata))

      const res = await fetch(apiBase(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken()}` },
        body: formData,
      })
      if (!res.ok) throw new Error(`CF Images upload ${res.status}: ${await res.text()}`)
      const data = (await res.json()) as SingleResp
      if (!data.success) throw new Error(data.errors?.[0]?.message ?? 'CF Images upload failed')
      return toMediaItem(data.result)
    },

    async delete(id: string): Promise<void> {
      const tenantId = getTenantId(config)
      // Ownership check before delete. Reads cost an extra round-trip
      // but prevent any tenant from nuking another tenant's media even
      // if they know the ID.
      const head = await fetch(`${apiBase()}/${encodeURIComponent(id)}`, { headers: headers() })
      if (head.status === 404) return
      if (!head.ok) throw new Error(`CF Images get-before-delete ${head.status}`)
      const headData = (await head.json()) as SingleResp
      if (!headData.success) return
      if (tenantOf(headData.result) !== tenantId) {
        throw new Error(`CF Images delete: ${id} does not belong to this tenant`)
      }
      const res = await fetch(`${apiBase()}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: headers(),
      })
      if (!res.ok && res.status !== 404) throw new Error(`CF Images delete ${res.status}`)
    },

    getEmbed(value: { id: string; width?: number; height?: number; alt?: string }, options?: { width?: number; height?: number; format?: string }) {
      const buildSrc = (o: { width?: number; height?: number; format?: string }) => {
        const t: string[] = []
        if (o.width) t.push(`w=${o.width}`)
        if (o.height) t.push(`h=${o.height}`)
        if (o.format) t.push(`f=${o.format}`)
        t.push('fit=scale-down')
        return `${deliveryBase()}/${accountHash()}/${encodeURIComponent(value.id)}/${t.join(',')}`
      }
      const width = options?.width ?? value.width ?? 1200
      const height = options?.height ?? value.height
      const src = buildSrc({ width, height, format: options?.format })
      return {
        type: 'image' as const,
        src,
        width: options?.width ?? value.width,
        height: options?.height ?? value.height,
        alt: value.alt,
        getSrc: buildSrc,
      }
    },

    getThumbnailUrl(id: string, _mime?: string, options?: { width?: number; height?: number }) {
      return buildUrl(id, { w: options?.width ?? 400, h: options?.height, fit: 'scale-down' })
    },
  }
}

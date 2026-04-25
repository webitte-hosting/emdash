// Tenant-scoped Cloudflare Stream media provider.
//
// Same isolation pattern as images-runtime: every video upload gets
// `meta.tenant_id` stamped, and list/get/delete enforce that field.
// CF Stream account is shared across all tenants.

import { env } from 'cloudflare:workers'

interface StreamConfig {
  id?: string
  accountId?: string
  accountIdEnvVar?: string
  apiToken?: string
  apiTokenEnvVar?: string
  tenantIdEnvVar?: string
  customerSubdomain?: string
}

interface MediaListOptions {
  cursor?: string
  limit?: number
}

interface MediaItem {
  id: string
  filename: string
  mimeType: string
  duration?: number
  previewUrl: string
  meta: Record<string, unknown>
}

interface MediaListResult {
  items: MediaItem[]
  nextCursor?: string
}

interface StreamVideo {
  uid: string
  meta?: Record<string, unknown>
  thumbnail?: string
  preview?: string
  playback?: { hls?: string; dash?: string }
  duration?: number
  uploaded?: string
  status?: { state: string }
}

interface StreamListResp {
  success: boolean
  errors?: Array<{ message: string }>
  result: StreamVideo[]
  range?: number
  total?: number
}

interface StreamSingleResp {
  success: boolean
  errors?: Array<{ message: string }>
  result: StreamVideo
}

interface StreamUploadResp {
  success: boolean
  errors?: Array<{ message: string }>
  result: {
    uid: string
    uploadURL: string
  }
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

function getTenantId(config: StreamConfig): string {
  const v = envVar(config.tenantIdEnvVar ?? 'TENANT_ID')
  if (!v) throw new Error(`tenantCloudflareStream: env "${config.tenantIdEnvVar ?? 'TENANT_ID'}" not set`)
  return v
}

function tenantOf(video: StreamVideo): string | undefined {
  const v = video.meta?.tenant_id
  return typeof v === 'string' ? v : undefined
}

export const createMediaProvider = (rawConfig: Record<string, unknown>) => {
  const config = rawConfig as StreamConfig

  const apiBase = () =>
    `https://api.cloudflare.com/client/v4/accounts/${resolve(config.accountId, config.accountIdEnvVar, 'CF_ACCOUNT_ID', 'tenantCloudflareStream')}/stream`
  const apiToken = () => resolve(config.apiToken, config.apiTokenEnvVar, 'CF_STREAM_TOKEN', 'tenantCloudflareStream')
  const headers = () => ({ Authorization: `Bearer ${apiToken()}` })

  const toMediaItem = (v: StreamVideo): MediaItem => ({
    id: v.uid,
    filename: (typeof v.meta?.name === 'string' ? v.meta.name : v.uid) || v.uid,
    mimeType: 'video/mp4',
    duration: v.duration,
    previewUrl: v.thumbnail ?? v.preview ?? '',
    meta: {
      hls: v.playback?.hls,
      dash: v.playback?.dash,
      uploaded: v.uploaded,
      status: v.status?.state,
      tenant_id: tenantOf(v),
    },
  })

  return {
    async list(options: MediaListOptions): Promise<MediaListResult> {
      const tenantId = getTenantId(config)
      const items: MediaItem[] = []
      const limit = options.limit ?? 50
      // CF Stream list is cursor-less; use `start` (date) to paginate.
      const params = new URLSearchParams()
      params.set('per_page', '100')
      if (options.cursor) params.set('start', options.cursor)
      const res = await fetch(`${apiBase()}?${params}`, { headers: headers() })
      if (!res.ok) throw new Error(`CF Stream list ${res.status}`)
      const data = (await res.json()) as StreamListResp
      if (!data.success) throw new Error(data.errors?.[0]?.message ?? 'CF Stream list failed')
      const tenantSlice = data.result.filter((v) => tenantOf(v) === tenantId)
      for (const v of tenantSlice) {
        items.push(toMediaItem(v))
        if (items.length >= limit) break
      }
      const oldest = data.result[data.result.length - 1]
      return {
        items,
        nextCursor: data.result.length === 100 ? oldest?.uploaded : undefined,
      }
    },

    async get(id: string): Promise<MediaItem | null> {
      const tenantId = getTenantId(config)
      const res = await fetch(`${apiBase()}/${encodeURIComponent(id)}`, { headers: headers() })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`CF Stream get ${res.status}`)
      const data = (await res.json()) as StreamSingleResp
      if (!data.success) return null
      if (tenantOf(data.result) !== tenantId) return null
      return toMediaItem(data.result)
    },

    async upload(input: { file: Blob; filename: string }): Promise<MediaItem> {
      const tenantId = getTenantId(config)
      // Stream's tus-style direct upload: POST to /direct_upload to get
      // a one-shot upload URL, then PUT the bytes there.
      const directRes = await fetch(`${apiBase()}/direct_upload`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          maxDurationSeconds: 21600,
          meta: { tenant_id: tenantId, name: input.filename },
        }),
      })
      if (!directRes.ok) throw new Error(`CF Stream direct_upload ${directRes.status}`)
      const directData = (await directRes.json()) as StreamUploadResp
      if (!directData.success) throw new Error(directData.errors?.[0]?.message ?? 'direct_upload failed')

      const putRes = await fetch(directData.result.uploadURL, {
        method: 'POST',
        body: input.file,
      })
      if (!putRes.ok) throw new Error(`CF Stream put ${putRes.status}`)

      const getRes = await fetch(`${apiBase()}/${encodeURIComponent(directData.result.uid)}`, {
        headers: headers(),
      })
      if (!getRes.ok) throw new Error(`CF Stream post-upload get ${getRes.status}`)
      const getData = (await getRes.json()) as StreamSingleResp
      return toMediaItem(getData.result)
    },

    async delete(id: string): Promise<void> {
      const tenantId = getTenantId(config)
      const head = await fetch(`${apiBase()}/${encodeURIComponent(id)}`, { headers: headers() })
      if (head.status === 404) return
      if (!head.ok) throw new Error(`CF Stream get-before-delete ${head.status}`)
      const headData = (await head.json()) as StreamSingleResp
      if (!headData.success) return
      if (tenantOf(headData.result) !== tenantId) {
        throw new Error(`CF Stream delete: ${id} does not belong to this tenant`)
      }
      const res = await fetch(`${apiBase()}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: headers(),
      })
      if (!res.ok && res.status !== 404) throw new Error(`CF Stream delete ${res.status}`)
    },

    getEmbed(value: { id: string; width?: number; height?: number }, options?: { width?: number; height?: number }) {
      const subdomain = config.customerSubdomain
      const src = subdomain
        ? `https://${subdomain}/${value.id}/iframe`
        : `https://customer-${value.id}.cloudflarestream.com/${value.id}/iframe`
      return {
        type: 'video' as const,
        src,
        width: options?.width ?? value.width,
        height: options?.height ?? value.height,
      }
    },

    getThumbnailUrl(id: string) {
      const subdomain = config.customerSubdomain
      return subdomain
        ? `https://${subdomain}/${id}/thumbnails/thumbnail.jpg`
        : `https://customer-${id}.cloudflarestream.com/${id}/thumbnails/thumbnail.jpg`
    },
  }
}

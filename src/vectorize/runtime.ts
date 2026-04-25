// Tenant-scoped Vectorize plugin runtime entry.
//
// EmDash imports `createPlugin` from this module at build time and
// instantiates it with the descriptor's options. The plugin stamps
// every upserted vector with `tenant_id` (in metadata + ID prefix) and
// forces every query to filter on that tenant_id, so a single shared
// Vectorize index can serve all tenants safely.
//
// Vectorize index is shared across all tenants — no per-tenant
// resources, no quota pressure on the 100-index account default.

import { definePlugin } from 'emdash'

interface VectorizeIndex {
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
  query(
    vector: number[],
    options: { topK: number; returnMetadata?: 'all' | 'indexed' | 'none'; filter?: Record<string, unknown> },
  ): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>
}

interface AI {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>
}

interface RuntimeEnv {
  AI?: AI
  VECTORIZE?: VectorizeIndex
  TENANT_ID?: string
  [k: string]: unknown
}

// Loose request type matching what EmDash plugins receive. Exported
// so the inferred return type of createPlugin can name it (otherwise
// TS complains the type leaks an un-exportable name).
export interface PluginRequest {
  url: string
  headers: { get(name: string): string | null }
}

// Astro on Cloudflare exposes the env via locals on the request object
// keyed by a Symbol. Fallback chain handles other plugin-context shapes.
function getRuntimeEnv(request: PluginRequest): RuntimeEnv | null {
  // Symbol-keyed locals from Astro on CF.
  const localsKey = Symbol.for('astro.locals')
  const locals = (request as unknown as Record<symbol, unknown>)[localsKey] as
    | { runtime?: { env?: RuntimeEnv } }
    | undefined
  if (locals?.runtime?.env) return locals.runtime.env
  return null
}

interface PluginConfig {
  binding: string
  tenantIdEnvVar: string
  model?: string
  collections?: string[]
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

// Combined plugin definition. `hooks.content:afterSave/afterDelete`
// auto-index; `routes.query` runs a filtered semantic search.
export function createPlugin(rawConfig: Record<string, unknown>) {
  const config = rawConfig as unknown as PluginConfig
  const model = config.model ?? '@cf/bge-base-en-v1.5'
  const targetCollections = config.collections

  // Build a tenant-scoped vector ID: `${tenant_id}:${original_id}`.
  // Keeps Vectorize's flat ID space partitioned even before metadata
  // filter kicks in.
  const scopedId = (tenantId: string, originalId: string) => `${tenantId}:${originalId}`

  // Need a way for hooks (which lack request context) to reach env.
  // Cache it from the first route call.
  let cachedEnv: RuntimeEnv | null = null

  function getTenantId(env: RuntimeEnv): string {
    const v = env[config.tenantIdEnvVar]
    if (typeof v !== 'string' || !v) {
      throw new Error(`vectorizeTenantPlugin: env "${config.tenantIdEnvVar}" missing`)
    }
    return v
  }

  function getVectorize(env: RuntimeEnv): VectorizeIndex {
    const v = env[config.binding]
    if (!v) throw new Error(`vectorizeTenantPlugin: binding "${config.binding}" missing`)
    return v as VectorizeIndex
  }

  function extractText(content: Record<string, unknown>): string {
    const parts: string[] = []
    if (typeof content.title === 'string') parts.push(content.title)
    for (const [key, value] of Object.entries(content)) {
      if (key === 'title' || key === 'id' || key === 'slug') continue
      if (typeof value === 'string') parts.push(value)
      else if (Array.isArray(value)) parts.push(JSON.stringify(value).slice(0, 5000))
    }
    return parts.join('\n').slice(0, 50_000)
  }

  return definePlugin({
    id: 'webitte-vectorize-tenant',
    version: '0.1.0',
    capabilities: ['read:content'],

    hooks: {
      'content:afterSave': {
        handler: async (event: { content: Record<string, unknown>; collection: string }) => {
          if (targetCollections && !targetCollections.includes(event.collection)) return
          if (!cachedEnv) {
            console.warn('[vectorize-tenant] env not cached yet; skipping index')
            return
          }
          const env = cachedEnv
          if (!env.AI || !env.VECTORIZE) return
          try {
            const tenantId = getTenantId(env)
            const text = extractText(event.content)
            if (!text.trim()) return
            const embedding = await env.AI.run(model, { text: [text] })
            const values = embedding?.data?.[0]
            if (!values) return
            const contentId = toString(event.content.id)
            await getVectorize(env).upsert([
              {
                id: scopedId(tenantId, contentId),
                values,
                metadata: {
                  tenant_id: tenantId,
                  collection: event.collection,
                  original_id: contentId,
                  slug: toString(event.content.slug),
                  title: toString(event.content.title),
                },
              },
            ])
          } catch (err) {
            console.error('[vectorize-tenant] index error:', err)
          }
        },
      },

      'content:afterDelete': {
        handler: async (event: { id: string; collection: string }) => {
          if (targetCollections && !targetCollections.includes(event.collection)) return
          if (!cachedEnv) return
          try {
            const tenantId = getTenantId(cachedEnv)
            await getVectorize(cachedEnv).deleteByIds([scopedId(tenantId, event.id)])
          } catch (err) {
            console.error('[vectorize-tenant] delete error:', err)
          }
        },
      },
    },

    routes: {
      query: {
        handler: async (ctx: { request: PluginRequest; input?: unknown }) => {
          const env = getRuntimeEnv(ctx.request)
          if (env) cachedEnv = env
          if (!env?.AI || !env?.VECTORIZE) {
            return { error: 'AI or VECTORIZE binding unavailable', results: [] }
          }
          const tenantId = getTenantId(env)
          const input = isRecord(ctx.input) ? ctx.input : undefined
          const query = typeof input?.q === 'string' ? input.q : undefined
          if (!query) return { error: "missing 'q'", results: [] }

          try {
            const embedding = await env.AI.run(model, { text: [query] })
            const values = embedding?.data?.[0]
            if (!values) return { error: 'embedding failed', results: [] }
            const limit = typeof input?.limit === 'number' ? input.limit : 20
            // Always force tenant_id filter — defense in depth on top of
            // the scoped id prefix. A tenant can never see another
            // tenant's vectors.
            const filter: Record<string, unknown> = { tenant_id: tenantId }
            const collection = typeof input?.collection === 'string' ? input.collection : undefined
            if (collection) filter.collection = collection

            const result = await getVectorize(env).query(values, {
              topK: limit,
              returnMetadata: 'all',
              filter,
            })
            return {
              results: result.matches.map((m) => ({
                id: toString(m.metadata?.original_id) || m.id,
                score: m.score,
                collection: toString(m.metadata?.collection),
                slug: toString(m.metadata?.slug),
                title: toString(m.metadata?.title),
              })),
            }
          } catch (err) {
            return {
              error: err instanceof Error ? err.message : 'query failed',
              results: [],
            }
          }
        },
      },
    },
  })
}

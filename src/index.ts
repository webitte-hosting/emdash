// Config-time entrypoint. Astro / EmDash import these from
// astro.config.mjs to wire up tenant-isolated adapters. Runtime code
// lives at the per-feature *-runtime entrypoints — they import
// `cloudflare:workers` and only run inside a Worker.

import type { StorageDescriptor } from 'emdash'
// MediaProviderDescriptor is exported from emdash/media. We use a structural
// fallback type to avoid coupling to that subpath.
type MediaProviderDescriptor<T = unknown> = {
  id: string
  name: string
  icon?: string
  entrypoint: string
  capabilities: { browse: boolean; search: boolean; upload: boolean; delete: boolean }
  config: T
}

// ───────────────────────────────────────────────────────────────────
// R2 storage with auto tenant prefix.
//
// Wraps EmDash's R2Storage. Reads `TENANT_PREFIX` from env at runtime
// (set by wfp-deploy in tenant Worker vars). Every key becomes
// `${TENANT_PREFIX}${key}`.

export interface PrefixedR2Config {
  /** Name of the R2 binding (the shared bucket). */
  binding: string
  /** Optional public URL prefix for served media. */
  publicUrl?: string
  /**
   * Env var name to read the tenant prefix from. Default `TENANT_PREFIX`.
   * The value SHOULD include a trailing slash (e.g. `ten_xxx/`).
   */
  prefixEnvVar?: string
}

export function prefixedR2(config: PrefixedR2Config): StorageDescriptor {
  return {
    entrypoint: '@webitte-hosting/emdash/storage/r2-runtime',
    config: {
      binding: config.binding,
      publicUrl: config.publicUrl,
      prefixEnvVar: config.prefixEnvVar ?? 'TENANT_PREFIX',
    },
  }
}

// ───────────────────────────────────────────────────────────────────
// D1-backed Astro session driver.
//
// Replaces the default Cloudflare KV session driver. Stores session
// rows in a `_em_sessions` table inside the tenant's own D1, so
// session data stays inside that tenant's database — strongest
// possible isolation, and we can drop the SESSION KV binding entirely.

export interface D1SessionDriverConfig {
  /** Name of the D1 binding (per-tenant DB). Defaults to `DB`. */
  binding?: string
  /** Override table name. Defaults to `_em_sessions`. */
  table?: string
}

export function d1SessionDriver(config: D1SessionDriverConfig = {}) {
  // Astro session expects a `{ name, options }`-shaped descriptor whose
  // entrypoint exports a default unstorage driver factory. Astro
  // imports the entrypoint at build time.
  return {
    name: 'webitte-d1-session',
    entrypoint: '@webitte-hosting/emdash/session/d1-runtime',
    options: {
      binding: config.binding ?? 'DB',
      table: config.table ?? '_em_sessions',
    },
  }
}

// ───────────────────────────────────────────────────────────────────
// Tenant-scoped Cloudflare Images media provider.
//
// Same as @emdash-cms/cloudflare's cloudflareImages() but every upload
// gets a `tenant_id` metadata field, and list/get filters by it so
// tenants can't see each other's images. The CF Images account is
// shared across all tenants.

export interface TenantImagesConfig {
  /** Env var holding the CF account ID. Default `CF_ACCOUNT_ID`. */
  accountIdEnvVar?: string
  /** Env var holding the CF Images token. Default `CF_IMAGES_TOKEN`. */
  apiTokenEnvVar?: string
  /** Env var holding the account hash (for delivery URLs). Default `CF_IMAGES_ACCOUNT_HASH`. */
  accountHashEnvVar?: string
  /** Env var holding the tenant id (for the metadata stamp). Default `TENANT_ID`. */
  tenantIdEnvVar?: string
  /** Optional custom delivery domain. */
  deliveryDomain?: string
  /** Default variant. */
  defaultVariant?: string
}

const IMAGES_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M56 11.92H8l-2 2v39.87l2 2h48l2-2V13.92l-2-2Zm-2 4v18.69l-8-6.55-2.62.08-5.08 4.68-5.43-4-2.47.08-14 11.7-6.4-4.4V15.92h44ZM10 51.79V41.08l5.3 3.7 2.42-.11L31.75 33l5.5 4 2.54-.14 5-4.63L54 39.77v12l-44 .02Z"/><path fill="#F63" d="M19.08 32.16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/></svg>')}`

export function tenantCloudflareImages(
  config: TenantImagesConfig = {},
): MediaProviderDescriptor<TenantImagesConfig & { id: string }> {
  return {
    id: 'webitte-cloudflare-images',
    name: 'Cloudflare Images (tenant-scoped)',
    icon: IMAGES_ICON,
    entrypoint: '@webitte-hosting/emdash/media/images-runtime',
    capabilities: { browse: true, search: false, upload: true, delete: true },
    config: { ...config, id: 'webitte-cloudflare-images' },
  }
}

// ───────────────────────────────────────────────────────────────────
// Tenant-scoped Cloudflare Stream media provider. Shape mirrors
// images: every upload tagged with tenant_id metadata; list/get
// filtered.

export interface TenantStreamConfig {
  accountIdEnvVar?: string
  apiTokenEnvVar?: string
  tenantIdEnvVar?: string
  customerSubdomain?: string
}

const STREAM_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" fill="none" viewBox="0 0 64 64"><path fill="#F63" d="M48 12H16a4 4 0 0 0-4 4v32a4 4 0 0 0 4 4h32a4 4 0 0 0 4-4V16a4 4 0 0 0-4-4ZM27 42V22l16 10-16 10Z"/></svg>')}`

export function tenantCloudflareStream(
  config: TenantStreamConfig = {},
): MediaProviderDescriptor<TenantStreamConfig & { id: string }> {
  return {
    id: 'webitte-cloudflare-stream',
    name: 'Cloudflare Stream (tenant-scoped)',
    icon: STREAM_ICON,
    entrypoint: '@webitte-hosting/emdash/media/stream-runtime',
    capabilities: { browse: true, search: false, upload: true, delete: true },
    config: { ...config, id: 'webitte-cloudflare-stream' },
  }
}

// ───────────────────────────────────────────────────────────────────
// Vectorize plugin with auto tenant_id metadata + filter.
//
// Returns an EmDash plugin descriptor — `plugins:` field in
// astro.config.mjs. The runtime entry intercepts upsert/query and
// enforces `metadata.tenant_id = env.TENANT_ID` on writes and
// `filter.tenant_id` on reads. The Vectorize index is shared across
// all tenants.

export interface VectorizeTenantConfig {
  /** Vectorize binding name. Default `VECTORIZE`. */
  binding?: string
  /** Tenant id env var. Default `TENANT_ID`. */
  tenantIdEnvVar?: string
}

// Returns a PluginDescriptor — EmDash code-generates an
// `import { createPlugin } from "<entrypoint>"` for it at build time
// and instantiates the plugin with `options`. The runtime module is
// `./vectorize/runtime.ts` which exports `createPlugin`.
export function vectorizeTenantPlugin(config: VectorizeTenantConfig = {}) {
  return {
    id: 'webitte-vectorize-tenant',
    version: '0.1.0',
    entrypoint: '@webitte-hosting/emdash/vectorize/runtime',
    capabilities: ['read:content'] as const,
    options: {
      binding: config.binding ?? 'VECTORIZE',
      tenantIdEnvVar: config.tenantIdEnvVar ?? 'TENANT_ID',
    },
  }
}

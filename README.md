# @webitte-hosting/emdash

Multi-tenant isolation adapters for [EmDash CMS](https://github.com/emdash-cms/emdash) on Cloudflare Workers.

## What this is

Webitte runs every tenant's site on a single shared Cloudflare account. R2 buckets / KV namespaces / Vectorize indexes are platform-shared, not per-tenant. To keep tenants isolated this package wraps EmDash's adapters and stamps every read / write with a tenant id (read from `env.TENANT_ID` injected by the platform deployer).

## Adapters

- `prefixedR2(...)` — R2 storage with auto `${TENANT_PREFIX}${key}` prefixing
- `d1SessionDriver(...)` — Astro session driver backed by the tenant's D1 (drops the SESSION KV binding)
- `tenantCloudflareImages(...)`, `tenantCloudflareStream(...)` — media providers that stamp `metadata.tenant_id` and filter list/get/delete on it
- `vectorizeTenantPlugin(...)` — EmDash plugin that scopes Vectorize upserts/queries by `metadata.tenant_id`

## Install

```bash
pnpm add @webitte-hosting/emdash
```

The package lives on GitHub Packages, so add an `.npmrc`:

```
@webitte-hosting:registry=https://npm.pkg.github.com
```

## Usage

```ts
// astro.config.mjs
import { d1, sandbox } from "@emdash-cms/cloudflare"
import {
  prefixedR2,
  d1SessionDriver,
  tenantCloudflareImages,
  vectorizeTenantPlugin,
} from "@webitte-hosting/emdash"

export default defineConfig({
  session: { driver: d1SessionDriver({ binding: "DB" }) },
  integrations: [
    emdash({
      database: d1({ binding: "DB", session: "auto" }),
      storage: prefixedR2({ binding: "MEDIA" }),
      mediaProviders: [tenantCloudflareImages({})],
      plugins: [vectorizeTenantPlugin({ binding: "VECTORIZE" })],
    }),
  ],
})
```

The platform side (webitte) injects `TENANT_ID`, `TENANT_PREFIX`, and CF Images / Stream credentials into every tenant Worker via `wfp-deploy`.

## Source

Lives in the `webitte` parent repo workflow but published from this standalone repo. See https://github.com/larry-xue/webitte for the platform that consumes it.

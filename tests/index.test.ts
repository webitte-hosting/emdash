// Descriptor shape tests. These run pure (no CF binding mocks) and
// would have caught the d1SessionDriver `{ name, options }` vs Astro's
// `{ entrypoint, config }` mismatch at unit-test time, before
// publishing.

import { describe, expect, it } from 'vitest'
import {
  d1SessionDriver,
  prefixedR2,
  tenantCloudflareImages,
  tenantCloudflareStream,
  vectorizeTenantPlugin,
} from '../src/index.js'

describe('prefixedR2() descriptor', () => {
  it('returns a StorageDescriptor with entrypoint + config', () => {
    const d = prefixedR2({ binding: 'MEDIA' })
    expect(d.entrypoint).toBe('@webitte-hosting/emdash/storage/r2-runtime')
    expect(d.config).toMatchObject({
      binding: 'MEDIA',
      prefixEnvVar: 'TENANT_PREFIX',
    })
  })

  it('threads publicUrl + custom prefixEnvVar through', () => {
    const d = prefixedR2({ binding: 'MEDIA', publicUrl: 'https://cdn.example.com', prefixEnvVar: 'TID' })
    expect(d.config).toMatchObject({
      binding: 'MEDIA',
      publicUrl: 'https://cdn.example.com',
      prefixEnvVar: 'TID',
    })
  })
})

describe('d1SessionDriver() descriptor', () => {
  // The bug shipped in 0.1.0–0.1.2 was here: Astro's
  // `SessionDriverConfig` has `{ entrypoint, config }`, NOT
  // `{ name, entrypoint, options }`. Checking field names here
  // catches the regression.
  it('returns Astro SessionDriverConfig shape: { entrypoint, config }', () => {
    const d = d1SessionDriver({})
    expect(d).toHaveProperty('entrypoint')
    expect(d).toHaveProperty('config')
    expect(d).not.toHaveProperty('name')
    expect(d).not.toHaveProperty('options')
    expect(d.entrypoint).toBe('@webitte-hosting/emdash/session/d1-runtime')
  })

  it('defaults binding=DB and table=_em_sessions', () => {
    const d = d1SessionDriver()
    expect(d.config).toEqual({ binding: 'DB', table: '_em_sessions' })
  })

  it('overrides binding + table when supplied', () => {
    const d = d1SessionDriver({ binding: 'TENANT_DB', table: 'sess' })
    expect(d.config).toEqual({ binding: 'TENANT_DB', table: 'sess' })
  })
})

describe('tenantCloudflareImages() descriptor', () => {
  it('returns MediaProvider descriptor', () => {
    const d = tenantCloudflareImages({})
    expect(d.id).toBe('webitte-cloudflare-images')
    expect(d.entrypoint).toBe('@webitte-hosting/emdash/media/images-runtime')
    expect(d.capabilities).toMatchObject({ browse: true, upload: true, delete: true })
  })
})

describe('tenantCloudflareStream() descriptor', () => {
  it('returns MediaProvider descriptor', () => {
    const d = tenantCloudflareStream({})
    expect(d.id).toBe('webitte-cloudflare-stream')
    expect(d.entrypoint).toBe('@webitte-hosting/emdash/media/stream-runtime')
  })
})

describe('vectorizeTenantPlugin() descriptor', () => {
  it('returns PluginDescriptor with entrypoint + options', () => {
    const d = vectorizeTenantPlugin({})
    expect(d.id).toBe('webitte-vectorize-tenant')
    expect(d.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(d.entrypoint).toBe('@webitte-hosting/emdash/vectorize/runtime')
    expect(d.options).toEqual({ binding: 'VECTORIZE', tenantIdEnvVar: 'TENANT_ID' })
  })

  it('thread custom binding + env var', () => {
    const d = vectorizeTenantPlugin({ binding: 'V', tenantIdEnvVar: 'TID' })
    expect(d.options).toEqual({ binding: 'V', tenantIdEnvVar: 'TID' })
  })
})

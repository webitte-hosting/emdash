// d1SessionDriver runtime: factory must return Astro's `SessionDriver`
// shape — `{ getItem, setItem, removeItem }`. These tests would have
// caught both:
//   1. The 0.1.2 descriptor bug (caller passed undefined config →
//      driver factory got undefined, threw at first env lookup)
//   2. Any drift in the SQL flow (TTL handling, lazy expiry, schema
//      bootstrap)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setEnv } from '../_cf-workers-mock.js'
import createDriver from '../../src/session/d1-runtime.js'

interface PreparedStub {
  bind: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  all: ReturnType<typeof vi.fn>
}

function makeD1() {
  const prepared: { sql: string; stub: PreparedStub }[] = []
  const prepare = vi.fn((sql: string): PreparedStub => {
    const stub: PreparedStub = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(async () => null),
      run: vi.fn(async () => ({ success: true })),
      all: vi.fn(async () => ({ results: [] })),
    } as unknown as PreparedStub
    prepared.push({ sql, stub })
    return stub
  })
  return { prepare, prepared }
}

let d1: ReturnType<typeof makeD1>

beforeEach(() => {
  d1 = makeD1()
  setEnv({ DB: d1 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('d1SessionDriver runtime', () => {
  it('factory returns exactly Astro SessionDriver methods', () => {
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    expect(typeof drv.getItem).toBe('function')
    expect(typeof drv.setItem).toBe('function')
    expect(typeof drv.removeItem).toBe('function')
    // Anything else (hasItem / getKeys / clear / getMeta) is NOT
    // required — Astro only consumes those 3. We don't assert absence
    // because surplus fields are harmless.
  })

  it('factory accepts undefined config (defaults applied)', () => {
    // Astro will pass `undefined` if descriptor.config is missing.
    // Earlier 0.1.2 release crashed here because it dereferenced an
    // undefined object.
    const drv = createDriver(undefined as unknown as Record<string, unknown>)
    expect(drv.getItem).toBeDefined()
  })

  it('rejects unsafe table names', () => {
    expect(() => createDriver({ binding: 'DB', table: '"; DROP TABLE x; --' })).toThrow(
      /invalid table name/,
    )
  })

  it('throws when D1 binding is missing AT FIRST CALL (lazy)', async () => {
    setEnv({}) // no DB
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    await expect(drv.getItem('any')).rejects.toThrow(/D1 binding "DB" not found/)
  })

  it('getItem returns null for missing key', async () => {
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    const v = await drv.getItem('missing')
    expect(v).toBeNull()
    expect(d1.prepared.some((p) => p.sql.includes('CREATE TABLE'))).toBe(true)
    expect(d1.prepared.some((p) => p.sql.includes('SELECT value'))).toBe(true)
  })

  it('getItem returns value for fresh row', async () => {
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    // Stub the SELECT to return a row.
    const realPrepare = d1.prepare
    let firstCallCount = 0
    d1.prepare = ((sql: string) => {
      const s = realPrepare(sql)
      if (sql.includes('SELECT value')) {
        s.first = vi.fn(async () => ({ value: 'hello', expires_at: null }))
      }
      firstCallCount++
      return s
    }) as typeof d1.prepare
    setEnv({ DB: d1 })
    const v = await drv.getItem('foo')
    expect(v).toBe('hello')
    expect(firstCallCount).toBeGreaterThan(0)
  })

  it('getItem expires lazily when expires_at <= now', async () => {
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    const realPrepare = d1.prepare
    let deletedKey: string | null = null
    d1.prepare = ((sql: string) => {
      const s = realPrepare(sql)
      if (sql.includes('SELECT value')) {
        // Expires 1s in the past.
        s.first = vi.fn(async () => ({ value: 'stale', expires_at: Date.now() - 1000 }))
      }
      if (sql.includes('DELETE FROM')) {
        s.bind = vi.fn((k: string) => {
          deletedKey = k
          return s
        }) as PreparedStub['bind']
      }
      return s
    }) as typeof d1.prepare
    setEnv({ DB: d1 })
    const v = await drv.getItem('foo')
    expect(v).toBeNull()
    expect(deletedKey).toBe('foo')
  })

  it('setItem stores expires_at when ttl provided', async () => {
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    let bound: unknown[] = []
    const realPrepare = d1.prepare
    d1.prepare = ((sql: string) => {
      const s = realPrepare(sql)
      if (sql.includes('INSERT INTO')) {
        s.bind = vi.fn((...a: unknown[]) => {
          bound = a
          return s
        }) as PreparedStub['bind']
      }
      return s
    }) as typeof d1.prepare
    setEnv({ DB: d1 })
    const before = Date.now()
    await drv.setItem('k', 'v', { ttl: 60 })
    const expiresAt = bound[2] as number
    // Window: now+60s ± 1s.
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000 - 1000)
    expect(expiresAt).toBeLessThanOrEqual(before + 60_000 + 1000)
  })

  it('setItem stores NULL expires_at when no ttl', async () => {
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    let bound: unknown[] = []
    const realPrepare = d1.prepare
    d1.prepare = ((sql: string) => {
      const s = realPrepare(sql)
      if (sql.includes('INSERT INTO')) {
        s.bind = vi.fn((...a: unknown[]) => {
          bound = a
          return s
        }) as PreparedStub['bind']
      }
      return s
    }) as typeof d1.prepare
    setEnv({ DB: d1 })
    await drv.setItem('k', 'v')
    expect(bound[2]).toBeNull()
  })

  it('removeItem issues DELETE', async () => {
    const drv = createDriver({ binding: 'DB', table: '_em_sessions' })
    let deletedKey: string | null = null
    const realPrepare = d1.prepare
    d1.prepare = ((sql: string) => {
      const s = realPrepare(sql)
      if (sql.includes('DELETE FROM')) {
        s.bind = vi.fn((k: string) => {
          deletedKey = k
          return s
        }) as PreparedStub['bind']
      }
      return s
    }) as typeof d1.prepare
    setEnv({ DB: d1 })
    await drv.removeItem('zap')
    expect(deletedKey).toBe('zap')
  })
})

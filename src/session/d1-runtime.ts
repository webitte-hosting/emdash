// Astro session driver backed by the tenant's own D1 database.
//
// Replaces @astrojs/cloudflare's default KV-binding session driver so we
// can drop the SESSION KV namespace entirely. Sessions live in a single
// `_em_sessions` table inside the tenant's per-tenant D1 — strongest
// isolation possible (D1 is per-tenant by binding) and one less shared
// resource to provision.
//
// Schema (created lazily on first call):
//   _em_sessions(key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)
//
// Astro / unstorage calls `setItem(key, value, { ttl })`; ttl is seconds.
// We store `expires_at = now + ttl*1000`. NULL means no expiry.
//
// We do best-effort lazy expiry — every read drops expired rows for the
// same key. A periodic cleanup is left to the tenant Worker (a cron
// trigger if/when added). Per tenant, sessions table will stay small.

import { env } from 'cloudflare:workers'

interface DriverOptions {
  binding: string
  table: string
}

interface UnstorageDriver {
  name: string
  options?: DriverOptions
  hasItem(key: string): Promise<boolean>
  getItem(key: string): Promise<unknown>
  setItem(key: string, value: string, opts?: { ttl?: number }): Promise<void>
  removeItem(key: string): Promise<void>
  getKeys(base?: string): Promise<string[]>
  clear(base?: string): Promise<void>
  getMeta?(key: string): Promise<{ ttl?: number; mtime?: Date } | null>
}

let migrationRan: WeakSet<D1Database> | null = null

async function ensureSchema(db: D1Database, table: string): Promise<void> {
  if (!migrationRan) migrationRan = new WeakSet()
  if (migrationRan.has(db)) return
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${table} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )`,
    )
    .run()
  migrationRan.add(db)
}

function now(): number {
  return Date.now()
}

export default function createDriver(rawOptions: Record<string, unknown>): UnstorageDriver {
  const options = rawOptions as unknown as DriverOptions
  const tableName = options.table
  // Validate table name (we interpolate into SQL, so reject anything
  // that isn't [a-zA-Z0-9_]).
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new Error(`d1SessionDriver: invalid table name "${tableName}"`)
  }

  function db(): D1Database {
    const value = (env as Record<string, unknown>)[options.binding] as D1Database | undefined
    if (!value) {
      throw new Error(
        `d1SessionDriver: D1 binding "${options.binding}" not found. wfp-deploy must attach it.`,
      )
    }
    return value
  }

  return {
    name: 'webitte-d1-session',
    options,

    async hasItem(key) {
      const conn = db()
      await ensureSchema(conn, tableName)
      const row = await conn
        .prepare(
          `SELECT 1 FROM ${tableName} WHERE key = ?1 AND (expires_at IS NULL OR expires_at > ?2)`,
        )
        .bind(key, now())
        .first()
      return row !== null
    },

    async getItem(key) {
      const conn = db()
      await ensureSchema(conn, tableName)
      const row = await conn
        .prepare(
          `SELECT value, expires_at FROM ${tableName} WHERE key = ?1`,
        )
        .bind(key)
        .first<{ value: string; expires_at: number | null }>()
      if (!row) return null
      if (row.expires_at !== null && row.expires_at <= now()) {
        // Lazy expiry — fire-and-forget cleanup.
        await conn.prepare(`DELETE FROM ${tableName} WHERE key = ?1`).bind(key).run()
        return null
      }
      return row.value
    },

    async setItem(key, value, opts) {
      const conn = db()
      await ensureSchema(conn, tableName)
      const expiresAt = opts?.ttl ? now() + opts.ttl * 1000 : null
      await conn
        .prepare(
          `INSERT INTO ${tableName} (key, value, expires_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
        )
        .bind(key, value, expiresAt)
        .run()
    },

    async removeItem(key) {
      const conn = db()
      await ensureSchema(conn, tableName)
      await conn.prepare(`DELETE FROM ${tableName} WHERE key = ?1`).bind(key).run()
    },

    async getKeys(base) {
      const conn = db()
      await ensureSchema(conn, tableName)
      const stmt = base
        ? conn
            .prepare(
              `SELECT key FROM ${tableName} WHERE key LIKE ?1 AND (expires_at IS NULL OR expires_at > ?2)`,
            )
            .bind(`${base}%`, now())
        : conn
            .prepare(
              `SELECT key FROM ${tableName} WHERE expires_at IS NULL OR expires_at > ?1`,
            )
            .bind(now())
      const result = await stmt.all<{ key: string }>()
      return result.results.map((r) => r.key)
    },

    async clear(base) {
      const conn = db()
      await ensureSchema(conn, tableName)
      if (base) {
        await conn.prepare(`DELETE FROM ${tableName} WHERE key LIKE ?1`).bind(`${base}%`).run()
      } else {
        await conn.prepare(`DELETE FROM ${tableName}`).run()
      }
    },

    async getMeta(key) {
      const conn = db()
      await ensureSchema(conn, tableName)
      const row = await conn
        .prepare(`SELECT expires_at FROM ${tableName} WHERE key = ?1`)
        .bind(key)
        .first<{ expires_at: number | null }>()
      if (!row) return null
      if (row.expires_at === null) return {}
      const ttlMs = row.expires_at - now()
      return ttlMs > 0 ? { ttl: Math.round(ttlMs / 1000) } : null
    },
  }
}

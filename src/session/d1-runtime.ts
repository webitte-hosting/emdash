// Astro session driver backed by the tenant's own D1 database.
//
// Astro session contract: default export is a factory that takes
// `config` and returns an object with `getItem` / `setItem` /
// `removeItem`. Sessions live in a `_em_sessions` table inside the
// tenant's per-tenant D1 — strongest isolation possible (D1 is
// per-tenant) and lets us drop the SESSION KV namespace entirely.
//
// Schema (created lazily on first call):
//   _em_sessions(key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)
//
// Astro calls `setItem(key, value, { ttl })` with `ttl` in seconds.
// We store `expires_at = now + ttl*1000`. NULL means no expiry.

import { env } from 'cloudflare:workers'

interface DriverOptions {
  binding: string
  table: string
}

interface SessionDriver {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string, opts?: { ttl?: number }): Promise<void>
  removeItem(key: string): Promise<void>
}

const migrationRan = new WeakSet<D1Database>()

async function ensureSchema(db: D1Database, table: string): Promise<void> {
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

export default function createDriver(rawConfig: Record<string, unknown> | undefined): SessionDriver {
  const config = (rawConfig ?? {}) as unknown as DriverOptions
  const binding = config.binding || 'DB'
  const tableName = config.table || '_em_sessions'

  // Validate table name (we interpolate into SQL).
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new Error(`d1SessionDriver: invalid table name "${tableName}"`)
  }

  function db(): D1Database {
    const value = (env as Record<string, unknown>)[binding] as D1Database | undefined
    if (!value) {
      throw new Error(
        `d1SessionDriver: D1 binding "${binding}" not found. wfp-deploy must attach it.`,
      )
    }
    return value
  }

  return {
    async getItem(key) {
      const conn = db()
      await ensureSchema(conn, tableName)
      const row = await conn
        .prepare(`SELECT value, expires_at FROM ${tableName} WHERE key = ?1`)
        .bind(key)
        .first<{ value: string; expires_at: number | null }>()
      if (!row) return null
      if (row.expires_at !== null && row.expires_at <= Date.now()) {
        await conn.prepare(`DELETE FROM ${tableName} WHERE key = ?1`).bind(key).run()
        return null
      }
      return row.value
    },

    async setItem(key, value, opts) {
      const conn = db()
      await ensureSchema(conn, tableName)
      const expiresAt = opts?.ttl ? Date.now() + opts.ttl * 1000 : null
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
  }
}

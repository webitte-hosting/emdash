// Runtime entry for d1RestDriver — used by the dev sandbox to talk to the
// tenant's *production* D1 over HTTP, without requiring a CF binding.
//
// Why: the webitte sandbox runs `astro dev` in a generic Node container.
// There's no Workers runtime / miniflare D1 binding, so the standard
// d1() driver from @emdash-cms/cloudflare fails with
// "D1 binding 'DB' not found in environment". This driver substitutes a
// minimal D1Database-shaped shim whose prepared-statement methods POST
// to the CF D1 REST API.
//
// Three env vars are required (all read at request time, so a token
// rotation only needs the sandbox env reloaded — no rebuild):
//   CF_ACCOUNT_ID    — the platform's Cloudflare account
//   CF_DATABASE_ID   — the tenant's d1_id (uuid)
//   CF_API_TOKEN     — short-lived token scoped to this single d1_id
//
// Names are configurable via `d1RestDriver({ accountIdEnv, ... })` if
// the host wants to use different env var names.

import { env } from 'cloudflare:workers'
import { D1Dialect } from 'kysely-d1'

export interface D1RestRuntimeConfig {
  accountIdEnv: string
  databaseIdEnv: string
  tokenEnv: string
  endpoint: string
}

interface CfQueryEnvelope {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: Array<{
    success: boolean
    error?: string
    results: unknown[]
    meta: {
      changes?: number
      last_row_id?: number | null
      duration?: number
      rows_read?: number
      rows_written?: number
    }
  }>
}

class D1RestError extends Error {
  constructor(
    public status: number,
    public errors: Array<{ code: number; message: string }>,
  ) {
    const summary = errors.map((e) => `[${e.code}] ${e.message}`).join('; ') || `HTTP ${status}`
    super(`d1-rest: ${summary}`)
  }
}

function readEnv(name: string): string {
  // Look first in `cloudflare:workers` env — that's where production
  // tenant Workers find these values (declared as bindings/vars on
  // the deployed script). In the webitte dev sandbox we run astro
  // dev as a Node process and inject via process.env on startProcess;
  // miniflare wraps the worker but doesn't surface arbitrary
  // process.env vars through `cloudflare:workers env` unless they're
  // declared in wrangler.jsonc. So we have to fall back to
  // process.env directly. nodejs_compat is on for these templates,
  // so `process` is reachable inside the worker context.
  const fromBindings = (env as Record<string, unknown>)[name]
  if (typeof fromBindings === 'string' && fromBindings.length > 0) return fromBindings

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process
  if (proc && proc.env && typeof proc.env[name] === 'string' && proc.env[name].length > 0) {
    return proc.env[name] as string
  }

  throw new Error(
    `d1RestDriver: env "${name}" is not set. The webitte sandbox is responsible for injecting it (via startProcess env or wrangler vars).`,
  )
}

/**
 * Build a D1Database-shaped shim that proxies every operation to the CF
 * D1 REST `/query` endpoint. The shim is safe to keep across requests —
 * env vars are re-read on each call, so a rotated token takes effect at
 * the next query without recreating the shim.
 *
 * Only the surface kysely-d1 + emdash actually use is implemented:
 *   prepare(sql).bind(...).all()/first()/run()/raw()
 *   batch([prepared, ...])
 *   exec(sql)
 * dump() throws — emdash never calls it.
 */
function makeShim(config: D1RestRuntimeConfig): D1Database {
  const buildUrl = (suffix = ''): string => {
    const account = readEnv(config.accountIdEnv)
    const database = readEnv(config.databaseIdEnv)
    return `${config.endpoint}/accounts/${account}/d1/database/${database}/${suffix || 'query'}`
  }

  async function postQuery(
    body: unknown,
    suffix?: string,
  ): Promise<CfQueryEnvelope['result']> {
    const token = readEnv(config.tokenEnv)
    const res = await fetch(buildUrl(suffix), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    let envelope: CfQueryEnvelope
    try {
      envelope = (await res.json()) as CfQueryEnvelope
    } catch {
      throw new D1RestError(res.status, [{ code: 0, message: `non-JSON response (${res.status})` }])
    }
    if (!envelope.success || !Array.isArray(envelope.result)) {
      throw new D1RestError(res.status, envelope.errors ?? [])
    }
    return envelope.result
  }

  function makeStatement(sql: string, params: readonly unknown[]): D1PreparedStatement {
    async function executeAll<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      const emulated = await emulateKyselySqliteTableInfo<T>(sql, params, postQuery)
      if (emulated) return emulated

      const [r] = await postQuery({ sql, params })
      if (r.success === false || r.error) {
        throw new Error(r.error || 'D1 query failed')
      }
      return {
        results: r.results as T[],
        success: true,
        meta: r.meta as unknown as D1Meta & Record<string, unknown>,
      }
    }

    const stmt = {
      bind(...next: unknown[]): D1PreparedStatement {
        return makeStatement(sql, next)
      },
      async first<T = unknown>(colName?: string): Promise<T | null> {
        const result = await executeAll<Record<string, unknown>>()
        const row = result.results[0] ?? null
        if (row === null) return null
        if (colName !== undefined) return (row[colName] ?? null) as T
        return row as T
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return executeAll<T>()
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return executeAll<T>()
      },
      async raw<T = unknown[]>(_options?: { columnNames?: boolean }): Promise<T[]> {
        // The /query endpoint returns objects keyed by column name. To
        // honor the raw() contract (array of arrays), we flatten in JS.
        // Column order matches Object.keys order on the first row.
        const r = await executeAll<Record<string, unknown>>()
        const rows = r.results
        if (rows.length === 0) return [] as T[]
        const cols = Object.keys(rows[0])
        return rows.map((row) => cols.map((c) => row[c])) as T[]
      },
    }
    return stmt as unknown as D1PreparedStatement
  }

  return {
    prepare(sql: string): D1PreparedStatement {
      return makeStatement(sql, [])
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // The CF /query endpoint accepts an array of {sql, params} objects.
      // statements is opaque from our side — but each one was created by
      // makeStatement above, where (sql, params) are captured in closure.
      // We can't read them back, so we issue separate calls. This is not
      // a real transaction; emdash uses batch primarily for bulk inserts
      // where atomicity-on-failure is acceptable to lose for now.
      const results: D1Result<T>[] = []
      for (const s of statements) {
        const r = await s.all<T>()
        results.push(r as D1Result<T>)
      }
      return results
    },

    async exec(query: string): Promise<D1ExecResult> {
      const result = await postQuery({ sql: query, params: [] })
      const total = result.reduce((sum, r) => sum + (r.results?.length ?? 0), 0)
      const duration = result.reduce((sum, r) => sum + (r.meta.duration ?? 0), 0)
      return { count: total, duration }
    },

    async dump(): Promise<ArrayBuffer> {
      throw new Error('d1RestDriver: dump() is not supported over the REST API')
    },

    // D1 Sessions API — we explicitly opt out. Kysely never reads this,
    // and emdash's middleware checks for the function existence (see
    // createRequestScopedDb in @emdash-cms/cloudflare); leaving it
    // undefined means emdash skips per-request scoping.
    withSession: undefined as unknown as D1Database['withSession'],
  } as unknown as D1Database
}

async function emulateKyselySqliteTableInfo<T>(
  sql: string,
  params: readonly unknown[],
  postQuery: (body: unknown, suffix?: string) => Promise<CfQueryEnvelope['result']>,
): Promise<D1Result<T> | null> {
  if (!/pragma_table_info\s*\(\s*tl\.name\s*\)/i.test(sql)) return null

  const tableTypes = params.slice(0, 2).filter((v): v is string => typeof v === 'string')
  const excludedNames = new Set(
    params.slice(3).filter((v): v is string => typeof v === 'string'),
  )
  const [tablesResult] = await postQuery({
    sql: [
      'select "name", "sql", "type" from "sqlite_master"',
      'where "type" in (?, ?) and "name" not like ? order by "name"',
    ].join(' '),
    params: [tableTypes[0] ?? 'table', tableTypes[1] ?? 'view', 'sqlite_%'],
  })
  if (tablesResult.success === false || tablesResult.error) {
    throw new Error(tablesResult.error || 'D1 query failed')
  }

  const rows: Array<Record<string, unknown>> = []
  for (const table of tablesResult.results as Array<{ name?: unknown }>) {
    const tableName = typeof table.name === 'string' ? table.name : ''
    if (!tableName || excludedNames.has(tableName)) continue

    const [pragmaResult] = await postQuery({
      sql: `PRAGMA table_info(${quoteIdentifier(tableName)})`,
      params: [],
    })
    if (pragmaResult.success === false || pragmaResult.error) {
      throw new Error(pragmaResult.error || 'D1 query failed')
    }
    for (const col of pragmaResult.results as Array<Record<string, unknown>>) {
      rows.push({ table: tableName, ...col })
    }
  }

  return {
    results: rows as T[],
    success: true,
    meta: { changes: 0 } as D1Meta & Record<string, unknown>,
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function createDialect(rawConfig: Record<string, unknown>): unknown {
  const config: D1RestRuntimeConfig = {
    accountIdEnv: (rawConfig.accountIdEnv as string) || 'CF_ACCOUNT_ID',
    databaseIdEnv: (rawConfig.databaseIdEnv as string) || 'CF_DATABASE_ID',
    tokenEnv: (rawConfig.tokenEnv as string) || 'CF_API_TOKEN',
    endpoint: (rawConfig.endpoint as string) || 'https://api.cloudflare.com/client/v4',
  }
  // Validate URL early — a malformed endpoint silently breaks every query.
  try {
    new URL(config.endpoint)
  } catch {
    throw new Error(`d1RestDriver: invalid endpoint ${JSON.stringify(config.endpoint)}`)
  }
  const shim = makeShim(config)
  return new D1Dialect({ database: shim })
}

/**
 * D1 Sessions API — bookmark-based read-your-writes — isn't exposed by the
 * REST `/query` endpoint, so per-request scoping is a no-op in REST mode.
 * Returning null tells emdash's middleware to fall back to the singleton
 * Kysely instance for every request.
 */
export function createRequestScopedDb(): null {
  return null
}

/**
 * Pluggable snapshot persistence — Phase 2 (v2.0, F3).
 *
 * WHY THIS EXISTS
 * ---------------
 * v1.0 persisted each room as a debounced file snapshot written straight from
 * index.mjs (`data/<room>.yss` = `Y.encodeStateAsUpdate`, atomic temp+rename).
 * That is correct but single-process and single-disk; the SPEC names an
 * authoritative MySQL/Postgres store this build never reached. F3 extracts the
 * persistence behind ONE small interface so the relay can write the SAME
 * `encodeStateAsUpdate` blob to a file or to a database without touching the
 * sync/relay logic.
 *
 * THE INTERFACE (StorageAdapter)
 * ------------------------------
 *   async load(room)        -> Uint8Array | null   (null = no snapshot yet)
 *   async save(room, update)                        (update: Uint8Array blob)
 *   async listRooms()       -> string[]             (rooms with a snapshot)
 *   async prune(maxAgeMs)   -> number               (snapshots deleted)
 *   async init()                                    (one-time setup, idempotent)
 *   async close()                                   (release handles/pools)
 *
 * Adapters store OPAQUE bytes. They never decode Yjs state — encoding stays in
 * index.mjs, so every adapter is trivially correct w.r.t. CRDT semantics: what
 * you save is byte-for-byte what you load.
 *
 * IMPLEMENTATIONS
 * ---------------
 * - FileAdapter: the EXACT v1.0 file logic, moved here verbatim — one
 *   `<dataDir>/<safeRoom>.yss` per room, atomic temp-file + rename so a crash
 *   mid-write never truncates state, mtime-based prune. Its methods satisfy the
 *   async interface but run synchronous fs calls internally, so a
 *   flush-on-shutdown completes before the process exits (identical to v1.0).
 * - PostgresAdapter: one row per room in `yss_snapshots(room text primary key,
 *   snapshot bytea, updated_at timestamptz)`, upserted via
 *   INSERT .. ON CONFLICT. The query client is INJECTABLE (`{ query(text,
 *   params) }`) so the adapter is fully unit-testable against a fake; when no
 *   client is injected it lazily imports `pg` and opens a Pool on SYNC_PG_URL.
 *
 * This module is side-effect-free at import (no fs/network touched until an
 * adapter method runs) so unit tests can import it against temp dirs and fakes.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Room names arrive from an untrusted URL path; keep them to a safe filename. */
export function safeRoomName(room) {
  return room.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default'
}

// ---------------------------------------------------------------------------
// FileAdapter — data/<room>.yss, atomic temp+rename (the v1.0 logic, verbatim)
// ---------------------------------------------------------------------------

export class FileAdapter {
  /** @param {{ dataDir: string }} opts */
  constructor({ dataDir }) {
    if (!dataDir) throw new Error('FileAdapter requires a dataDir')
    this.kind = 'file'
    this.dataDir = dataDir
  }

  _path(room) {
    return path.join(this.dataDir, `${safeRoomName(room)}.yss`)
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true })
  }

  /** @returns {Promise<Uint8Array | null>} null when no (or an empty) snapshot exists. */
  async load(room) {
    try {
      const buf = fs.readFileSync(this._path(room))
      if (buf.length > 0) return new Uint8Array(buf)
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
    }
    return null
  }

  /** Atomic write: temp file + rename, so a crash mid-write never truncates state. */
  async save(room, update) {
    const file = this._path(room)
    const tmp = `${file}.${process.pid}.tmp`
    fs.mkdirSync(this.dataDir, { recursive: true })
    try {
      fs.writeFileSync(tmp, Buffer.from(update))
      fs.renameSync(tmp, file)
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore cleanup failure */
      }
      throw err
    }
  }

  /** @returns {Promise<string[]>} rooms that currently have a snapshot on disk. */
  async listRooms() {
    let entries
    try {
      entries = fs.readdirSync(this.dataDir)
    } catch (err) {
      if (err && err.code === 'ENOENT') return []
      throw err
    }
    return entries
      .filter((e) => e.endsWith('.yss'))
      .map((e) => e.slice(0, -'.yss'.length))
  }

  /** Delete snapshots whose mtime is older than `maxAgeMs`. @returns {Promise<number>} */
  async prune(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs
    let pruned = 0
    let entries
    try {
      entries = fs.readdirSync(this.dataDir)
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0
      throw err
    }
    for (const entry of entries) {
      if (!entry.endsWith('.yss')) continue
      const file = path.join(this.dataDir, entry)
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file, { force: true })
          pruned++
        }
      } catch {
        /* stat/unlink race — leave the file for the next prune */
      }
    }
    return pruned
  }

  async close() {
    /* nothing to release */
  }
}

// ---------------------------------------------------------------------------
// PostgresAdapter — yss_snapshots(room pk, snapshot bytea, updated_at)
// ---------------------------------------------------------------------------

const PG_CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS yss_snapshots (
    room       text        PRIMARY KEY,
    snapshot   bytea       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`

const PG_UPSERT = `
  INSERT INTO yss_snapshots (room, snapshot, updated_at)
  VALUES ($1, $2, now())
  ON CONFLICT (room) DO UPDATE
    SET snapshot = EXCLUDED.snapshot, updated_at = now()`

const PG_LOAD = 'SELECT snapshot FROM yss_snapshots WHERE room = $1'
const PG_LIST = 'SELECT room FROM yss_snapshots ORDER BY room'
const PG_PRUNE =
  'DELETE FROM yss_snapshots WHERE updated_at < now() - make_interval(secs => $1)'

export class PostgresAdapter {
  /**
   * @param {{ url?: string, client?: { query(text: string, params?: unknown[]):
   *   Promise<{ rows: any[], rowCount?: number }> } }} opts
   *   Pass `client` (anything with pg's `query(text, params)` shape) to inject
   *   a fake for tests or share an existing pool; otherwise `url` is required
   *   and a `pg.Pool` is created lazily on first use.
   */
  constructor({ url, client } = {}) {
    if (!client && !url) {
      throw new Error('PostgresAdapter requires SYNC_PG_URL (or an injected client)')
    }
    this.kind = 'postgres'
    this._url = url
    this._client = client ?? null
    this._ownsPool = !client
  }

  /** Lazily open the pg.Pool exactly once (skipped entirely when injected). */
  async _q(text, params) {
    if (!this._client) {
      const { default: pg } = await import('pg')
      this._client = new pg.Pool({ connectionString: this._url })
    }
    return this._client.query(text, params)
  }

  /** Idempotent: creates the snapshot table if it does not exist. */
  async init() {
    await this._q(PG_CREATE_TABLE)
  }

  /** @returns {Promise<Uint8Array | null>} null when no (or an empty) snapshot exists. */
  async load(room) {
    const res = await this._q(PG_LOAD, [safeRoomName(room)])
    const row = res && res.rows && res.rows[0]
    if (!row || !row.snapshot || row.snapshot.length === 0) return null
    return new Uint8Array(row.snapshot)
  }

  /** Upsert — the row swap is atomic, so a reader never sees a torn snapshot. */
  async save(room, update) {
    await this._q(PG_UPSERT, [safeRoomName(room), Buffer.from(update)])
  }

  /** @returns {Promise<string[]>} rooms that currently have a snapshot row. */
  async listRooms() {
    const res = await this._q(PG_LIST)
    return (res && res.rows ? res.rows : []).map((r) => r.room)
  }

  /** Delete rows not updated for `maxAgeMs`. @returns {Promise<number>} */
  async prune(maxAgeMs) {
    const res = await this._q(PG_PRUNE, [maxAgeMs / 1000])
    return (res && res.rowCount) || 0
  }

  async close() {
    if (this._ownsPool && this._client && typeof this._client.end === 'function') {
      await this._client.end()
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — SYNC_STORAGE=file|postgres (default file, byte-identical to v1.0)
// ---------------------------------------------------------------------------

/**
 * @param {{ kind?: string, dataDir?: string, pgUrl?: string, client?: object }} opts
 * @returns {FileAdapter | PostgresAdapter}
 */
export function createStorageAdapter({ kind = 'file', dataDir, pgUrl, client } = {}) {
  switch (kind) {
    case 'file':
      return new FileAdapter({ dataDir })
    case 'postgres':
      return new PostgresAdapter({ url: pgUrl, client })
    default:
      throw new Error(`unknown SYNC_STORAGE kind: ${JSON.stringify(kind)} (use file|postgres)`)
  }
}

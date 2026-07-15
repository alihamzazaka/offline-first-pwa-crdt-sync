/**
 * Live-database integration test for the PostgresAdapter (Phase 2 · F3).
 *
 * WHY THIS EXISTS
 * ---------------
 * storage.test.mjs proves the adapter's SQL *contract* against a hand-written
 * fake `query(text, params)` client: it asserts the exact statements and bound
 * params. That is fast and deterministic, but a fake can't catch a statement
 * that a real Postgres planner rejects (a typo'd `ON CONFLICT` target, a bytea
 * that doesn't round-trip, `make_interval(secs => …)` named-arg syntax, …).
 *
 * This suite closes that gap WITHOUT requiring a running Postgres server by
 * driving the SAME shipped `PostgresAdapter` against **PGlite**
 * (`@electric-sql/pglite`) — a full Postgres compiled to WebAssembly, running
 * in-process. Every statement the adapter emits (the `CREATE TABLE`, the
 * `INSERT … ON CONFLICT DO UPDATE` upsert, `SELECT snapshot`, `SELECT room`,
 * and the `make_interval` prune) is parsed and executed by real Postgres and
 * the results flow back through the adapter's own decoding (`bytea` →
 * `Uint8Array`). It is a genuine SQL round-trip, not a stub.
 *
 * The ONE shim: PGlite's result object exposes `affectedRows`, whereas the
 * `pg` driver (and therefore the adapter's `prune`) reads `rowCount`. The tiny
 * `pgliteClient` wrapper below normalises that single field — a driver-shape
 * difference, not a change to any SQL or to the adapter's behaviour. Everything
 * else is passed straight through.
 *
 * If PGlite is not installed (it is an optional dev dependency), the whole
 * suite is skipped rather than failing, so `npm run test:storage` stays green
 * on a machine that only pulled production deps.
 *
 * Run: node --test server/test/storage.pg.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PostgresAdapter, safeRoomName } from '../src/storage.mjs'

const blob = (...bytes) => new Uint8Array(bytes)

// Load PGlite lazily so a missing optional dep skips (never breaks) the suite.
let PGlite = null
try {
  ;({ PGlite } = await import('@electric-sql/pglite'))
} catch {
  PGlite = null
}
const maybe = PGlite ? test : test.skip
const skipReason = PGlite ? '' : '@electric-sql/pglite not installed'
if (!PGlite) console.log(`# SKIP storage.pg.test.mjs — ${skipReason}`)

/**
 * Wrap a PGlite instance in the minimal `{ query(text, params) }` shape the
 * adapter expects, normalising `affectedRows` → `rowCount` (the only field
 * where PGlite and the `pg` driver disagree). No SQL is rewritten.
 */
function pgliteClient(pg) {
  return {
    async query(text, params) {
      const res = await pg.query(text, params)
      return {
        rows: res.rows ?? [],
        rowCount:
          typeof res.affectedRows === 'number'
            ? res.affectedRows
            : (res.rows ? res.rows.length : 0)
      }
    }
  }
}

/** A fresh in-process Postgres + an initialised adapter, torn down after each test. */
async function freshAdapter(t) {
  const pg = await PGlite.create()
  t.after(() => pg.close())
  const adapter = new PostgresAdapter({ client: pgliteClient(pg) })
  await adapter.init()
  return { pg, adapter }
}

// ---------------------------------------------------------------------------
// Real SQL round-trips against Postgres-in-wasm
// ---------------------------------------------------------------------------

maybe('pglite: init creates yss_snapshots and is idempotent', async (t) => {
  const { pg, adapter } = await freshAdapter(t)
  // Second init must not error (CREATE TABLE IF NOT EXISTS).
  await adapter.init()
  const res = await pg.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'yss_snapshots' ORDER BY ordinal_position`
  )
  const cols = Object.fromEntries(res.rows.map((r) => [r.column_name, r.data_type]))
  assert.equal(cols.room, 'text')
  assert.equal(cols.snapshot, 'bytea')
  assert.match(cols.updated_at, /timestamp with time zone/)
})

maybe('pglite: save inserts, then upserts (ON CONFLICT DO UPDATE) the same row', async (t) => {
  const { pg, adapter } = await freshAdapter(t)
  await adapter.save('room-a', blob(1, 2, 3, 250, 251, 0))
  await adapter.save('room-a', blob(9, 9)) // same key → UPDATE, not a second row
  const count = await pg.query('SELECT count(*)::int AS n FROM yss_snapshots WHERE room = $1', [
    'room-a'
  ])
  assert.equal(count.rows[0].n, 1, 'upsert must keep exactly one row per room')
  const back = await adapter.load('room-a')
  assert.ok(back instanceof Uint8Array)
  assert.deepEqual(Array.from(back), [9, 9], 'the second save must win (EXCLUDED.snapshot)')
})

maybe('pglite: bytea round-trips every byte value 0..255 unchanged', async (t) => {
  const { adapter } = await freshAdapter(t)
  const all = new Uint8Array(256)
  for (let i = 0; i < 256; i++) all[i] = i
  await adapter.save('bin', all)
  const back = await adapter.load('bin')
  assert.equal(back.length, 256)
  assert.deepEqual(Array.from(back), Array.from(all), 'no byte may be mangled by the bytea codec')
})

maybe('pglite: load of a missing room returns null', async (t) => {
  const { adapter } = await freshAdapter(t)
  assert.equal(await adapter.load('never-saved'), null)
})

maybe('pglite: listRooms returns every room ordered by name', async (t) => {
  const { adapter } = await freshAdapter(t)
  await adapter.save('gamma', blob(3))
  await adapter.save('alpha', blob(1))
  await adapter.save('beta', blob(2))
  assert.deepEqual(await adapter.listRooms(), ['alpha', 'beta', 'gamma'])
})

maybe('pglite: prune deletes only rows older than maxAgeMs and returns the count', async (t) => {
  const { pg, adapter } = await freshAdapter(t)
  await adapter.save('old-room', blob(1))
  await adapter.save('new-room', blob(2))
  // Age one row 40 days into the past — real timestamptz arithmetic.
  await pg.query("UPDATE yss_snapshots SET updated_at = now() - interval '40 days' WHERE room = $1", [
    'old-room'
  ])
  const pruned = await adapter.prune(30 * 86_400_000) // 30-day horizon
  assert.equal(pruned, 1, 'exactly the aged row is deleted')
  assert.deepEqual(await adapter.listRooms(), ['new-room'])
  assert.equal(await adapter.load('old-room'), null)
})

maybe('pglite: room names are sanitised before they reach SQL', async (t) => {
  const { pg, adapter } = await freshAdapter(t)
  await adapter.save('a/b room!', blob(7))
  const rooms = await adapter.listRooms()
  assert.deepEqual(rooms, [safeRoomName('a/b room!')])
  // and the bound param really is the sanitised key
  const back = await adapter.load('a/b room!')
  assert.deepEqual(Array.from(back), [7])
  const raw = await pg.query('SELECT room FROM yss_snapshots')
  assert.equal(raw.rows[0].room, safeRoomName('a/b room!'))
})

maybe('pglite: full save→load→list→prune lifecycle across multiple rooms', async (t) => {
  const { pg, adapter } = await freshAdapter(t)
  await adapter.save('r1', blob(1, 2))
  await adapter.save('r1', blob(3, 4, 5)) // upsert replaces
  await adapter.save('r2', blob(9))
  assert.deepEqual(Array.from(await adapter.load('r1')), [3, 4, 5])
  assert.deepEqual(Array.from(await adapter.load('r2')), [9])
  assert.deepEqual((await adapter.listRooms()).sort(), ['r1', 'r2'])
  // Nothing is old enough to prune yet.
  assert.equal(await adapter.prune(30 * 86_400_000), 0)
  // Age everything and prune it all.
  await pg.query("UPDATE yss_snapshots SET updated_at = now() - interval '100 days'")
  assert.equal(await adapter.prune(30 * 86_400_000), 2)
  assert.deepEqual(await adapter.listRooms(), [])
})

/**
 * Unit tests for the pluggable snapshot persistence (Phase 2 · F3).
 *
 * FileAdapter is exercised against a REAL temp directory: round-trip,
 * empty/missing-snapshot semantics, atomicity (no *.tmp droppings, overwrite
 * is whole-blob), listRooms filtering, mtime-based prune, and room-name
 * sanitisation (an hostile room name must never escape the data dir).
 *
 * PostgresAdapter is exercised against a FAKE injected query client — the
 * adapter's whole contract is the SQL it emits and the params it binds, so the
 * fake records every call and the tests assert upsert semantics, param order,
 * bytea round-trip, prune interval math, and that an injected client's pool is
 * never closed by the adapter. No live Postgres is required (and none was
 * reachable when this suite was written); a real-DB integration pass would
 * assert the same contract end-to-end.
 *
 * Run: node --test server/test/storage.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FileAdapter,
  PostgresAdapter,
  createStorageAdapter,
  safeRoomName
} from '../src/storage.mjs'

const blob = (...bytes) => new Uint8Array(bytes)

function tmpDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// FileAdapter — real temp dir
// ---------------------------------------------------------------------------

test('FileAdapter: save/load round-trips the exact bytes', async (t) => {
  const a = new FileAdapter({ dataDir: tmpDataDir(t) })
  await a.init()
  const update = blob(1, 2, 3, 250, 251, 0)
  await a.save('room-a', update)
  const back = await a.load('room-a')
  assert.ok(back instanceof Uint8Array)
  assert.deepEqual(Array.from(back), Array.from(update))
})

test('FileAdapter: load of a room with no snapshot returns null', async (t) => {
  const a = new FileAdapter({ dataDir: tmpDataDir(t) })
  await a.init()
  assert.equal(await a.load('never-saved'), null)
})

test('FileAdapter: a zero-length snapshot file loads as null (v1.0 semantics)', async (t) => {
  const dir = tmpDataDir(t)
  const a = new FileAdapter({ dataDir: dir })
  await a.init()
  fs.writeFileSync(path.join(dir, 'empty.yss'), Buffer.alloc(0))
  assert.equal(await a.load('empty'), null)
})

test('FileAdapter: save overwrites atomically and leaves no temp files', async (t) => {
  const dir = tmpDataDir(t)
  const a = new FileAdapter({ dataDir: dir })
  await a.init()
  await a.save('room-a', blob(1, 1, 1, 1, 1, 1, 1, 1))
  await a.save('room-a', blob(9, 9)) // smaller — a non-atomic write would leave a tail
  const back = await a.load('room-a')
  assert.deepEqual(Array.from(back), [9, 9])
  const leftovers = fs.readdirSync(dir).filter((e) => e.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'temp file must be renamed away, never left behind')
})

test('FileAdapter: a failed write cleans up its temp file and rejects', async (t) => {
  const dir = tmpDataDir(t)
  const a = new FileAdapter({ dataDir: dir })
  await a.init()
  // Force renameSync to fail by making the destination a non-empty DIRECTORY.
  const clash = path.join(dir, 'clash.yss')
  fs.mkdirSync(clash)
  fs.writeFileSync(path.join(clash, 'occupied'), 'x')
  await assert.rejects(a.save('clash', blob(1)))
  const leftovers = fs.readdirSync(dir).filter((e) => e.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'temp file must be removed after a failed rename')
})

test('FileAdapter: listRooms returns only .yss basenames', async (t) => {
  const dir = tmpDataDir(t)
  const a = new FileAdapter({ dataDir: dir })
  await a.init()
  await a.save('alpha', blob(1))
  await a.save('beta', blob(2))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a snapshot')
  fs.writeFileSync(path.join(dir, `gamma.yss.${process.pid}.tmp`), 'in-flight write')
  const rooms = (await a.listRooms()).sort()
  assert.deepEqual(rooms, ['alpha', 'beta'])
})

test('FileAdapter: listRooms on a missing data dir is [] (fresh boot)', async () => {
  const a = new FileAdapter({ dataDir: path.join(os.tmpdir(), `yss-nonexistent-${Date.now()}`) })
  assert.deepEqual(await a.listRooms(), [])
})

test('FileAdapter: prune removes only snapshots older than maxAgeMs', async (t) => {
  const dir = tmpDataDir(t)
  const a = new FileAdapter({ dataDir: dir })
  await a.init()
  await a.save('old-room', blob(1))
  await a.save('new-room', blob(2))
  // Age old-room's mtime 10 days into the past.
  const past = (Date.now() - 10 * 86_400_000) / 1000
  fs.utimesSync(path.join(dir, 'old-room.yss'), past, past)
  const pruned = await a.prune(7 * 86_400_000)
  assert.equal(pruned, 1)
  assert.deepEqual(await a.listRooms(), ['new-room'])
  assert.equal(await a.load('old-room'), null)
})

test('FileAdapter: hostile room names cannot escape the data dir', async (t) => {
  const dir = tmpDataDir(t)
  const a = new FileAdapter({ dataDir: dir })
  await a.init()
  await a.save('../../evil', blob(7))
  // Everything written must live INSIDE dir, under the sanitised name.
  const entries = fs.readdirSync(dir)
  assert.deepEqual(entries, [`${safeRoomName('../../evil')}.yss`])
  const back = await a.load('../../evil')
  assert.deepEqual(Array.from(back), [7])
})

// ---------------------------------------------------------------------------
// PostgresAdapter — fake injected query client
// ---------------------------------------------------------------------------

/** Records every query; per-statement canned responses via `respond`. */
function fakePgClient(respond = () => ({ rows: [], rowCount: 0 })) {
  const calls = []
  return {
    calls,
    ended: false,
    async query(text, params) {
      calls.push({ text, params })
      return respond(text, params)
    },
    async end() {
      this.ended = true
    }
  }
}

const sqlOf = (call) => call.text.replace(/\s+/g, ' ').trim().toLowerCase()

test('PostgresAdapter: init creates the yss_snapshots table (idempotent DDL)', async () => {
  const client = fakePgClient()
  const a = new PostgresAdapter({ client })
  await a.init()
  assert.equal(client.calls.length, 1)
  const sql = sqlOf(client.calls[0])
  assert.match(sql, /create table if not exists yss_snapshots/)
  assert.match(sql, /room\s+text\s+primary key/)
  assert.match(sql, /snapshot\s+bytea\s+not null/)
  assert.match(sql, /updated_at\s+timestamptz\s+not null/)
})

test('PostgresAdapter: save upserts (room, snapshot) with ON CONFLICT DO UPDATE', async () => {
  const client = fakePgClient()
  const a = new PostgresAdapter({ client })
  const update = blob(10, 20, 30)
  await a.save('room-a', update)
  assert.equal(client.calls.length, 1)
  const { text, params } = client.calls[0]
  const sql = sqlOf(client.calls[0])
  assert.match(sql, /insert into yss_snapshots \(room, snapshot, updated_at\)/)
  assert.match(sql, /on conflict \(room\) do update/)
  assert.match(sql, /set snapshot = excluded\.snapshot, updated_at = now\(\)/)
  assert.equal(params.length, 2, `expected [room, snapshot] params for: ${text}`)
  assert.equal(params[0], 'room-a')
  assert.ok(Buffer.isBuffer(params[1]), 'snapshot must be bound as a Buffer (bytea)')
  assert.deepEqual(Array.from(params[1]), [10, 20, 30])
})

test('PostgresAdapter: load returns the bytea column as a Uint8Array', async () => {
  const client = fakePgClient((text) =>
    /select snapshot/i.test(text)
      ? { rows: [{ snapshot: Buffer.from([4, 5, 6]) }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  )
  const a = new PostgresAdapter({ client })
  const back = await a.load('room-a')
  assert.ok(back instanceof Uint8Array)
  assert.deepEqual(Array.from(back), [4, 5, 6])
  const { text, params } = client.calls[0]
  assert.match(sqlOf({ text }), /select snapshot from yss_snapshots where room = \$1/)
  assert.deepEqual(params, ['room-a'])
})

test('PostgresAdapter: load of a missing (or empty) row returns null', async () => {
  const empty = new PostgresAdapter({ client: fakePgClient() })
  assert.equal(await empty.load('nope'), null)
  const zeroLen = new PostgresAdapter({
    client: fakePgClient(() => ({ rows: [{ snapshot: Buffer.alloc(0) }], rowCount: 1 }))
  })
  assert.equal(await zeroLen.load('empty'), null)
})

test('PostgresAdapter: save→load round-trip through a row-store fake', async () => {
  // A minimal in-memory Postgres: honours the upsert and the select.
  const tableRows = new Map()
  const client = {
    calls: [],
    async query(text, params) {
      this.calls.push({ text, params })
      if (/^\s*insert/i.test(text)) {
        tableRows.set(params[0], Buffer.from(params[1]))
        return { rows: [], rowCount: 1 }
      }
      if (/^\s*select snapshot/i.test(text)) {
        const snap = tableRows.get(params[0])
        return snap ? { rows: [{ snapshot: snap }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (/^\s*select room/i.test(text)) {
        return { rows: Array.from(tableRows.keys(), (room) => ({ room })), rowCount: tableRows.size }
      }
      return { rows: [], rowCount: 0 }
    }
  }
  const a = new PostgresAdapter({ client })
  await a.save('r1', blob(1, 2))
  await a.save('r1', blob(3, 4, 5)) // upsert replaces
  await a.save('r2', blob(9))
  assert.deepEqual(Array.from(await a.load('r1')), [3, 4, 5])
  assert.deepEqual(Array.from(await a.load('r2')), [9])
  assert.deepEqual((await a.listRooms()).sort(), ['r1', 'r2'])
})

test('PostgresAdapter: prune deletes by updated_at age and reports the count', async () => {
  const client = fakePgClient(() => ({ rows: [], rowCount: 3 }))
  const a = new PostgresAdapter({ client })
  const pruned = await a.prune(30 * 86_400_000)
  assert.equal(pruned, 3)
  const { text, params } = client.calls[0]
  assert.match(sqlOf({ text }), /delete from yss_snapshots where updated_at < now\(\) - make_interval\(secs => \$1\)/)
  assert.deepEqual(params, [30 * 86_400]) // ms → seconds
})

test('PostgresAdapter: room names are sanitised like the file backend', async () => {
  const client = fakePgClient()
  const a = new PostgresAdapter({ client })
  await a.save('a/b room!', blob(1))
  assert.equal(client.calls[0].params[0], safeRoomName('a/b room!'))
})

test('PostgresAdapter: close never ends an INJECTED client (shared pool safety)', async () => {
  const client = fakePgClient()
  const a = new PostgresAdapter({ client })
  await a.close()
  assert.equal(client.ended, false)
})

test('PostgresAdapter: constructing without url or client throws', () => {
  assert.throws(() => new PostgresAdapter({}), /SYNC_PG_URL/)
})

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

test('createStorageAdapter: kind selection and defaults', (t) => {
  const dir = tmpDataDir(t)
  assert.ok(createStorageAdapter({ kind: 'file', dataDir: dir }) instanceof FileAdapter)
  assert.ok(
    createStorageAdapter({ kind: 'postgres', client: fakePgClient() }) instanceof PostgresAdapter
  )
  assert.ok(createStorageAdapter({ dataDir: dir }) instanceof FileAdapter, 'default is file')
  assert.throws(() => createStorageAdapter({ kind: 'mysql' }), /unknown SYNC_STORAGE/)
})

// ---------------------------------------------------------------------------
// Live-Postgres integration (skipped unless a real DB is provided)
// ---------------------------------------------------------------------------

const LIVE_PG = process.env.SYNC_PG_TEST_URL
test(
  'PostgresAdapter: live round-trip against a real database',
  { skip: LIVE_PG ? false : 'no live Postgres reachable (set SYNC_PG_TEST_URL to enable)' },
  async () => {
    const a = new PostgresAdapter({ url: LIVE_PG })
    try {
      await a.init()
      const room = `it-${Date.now()}`
      await a.save(room, blob(1, 2, 3))
      await a.save(room, blob(4, 5))
      assert.deepEqual(Array.from(await a.load(room)), [4, 5])
      assert.ok((await a.listRooms()).includes(room))
    } finally {
      await a.close()
    }
  }
)

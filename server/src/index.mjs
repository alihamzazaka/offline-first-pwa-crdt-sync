/**
 * Sync backend — a hand-rolled y-websocket relay for the offline-first
 * inventory PWA.
 *
 * What it is
 * ----------
 * A tiny Node service that speaks the y-websocket wire protocol (sync + a-
 * wareness) so the browser's `WebsocketProvider` connects to it unmodified.
 * We do NOT import `y-websocket/bin/utils`'s `setupWSConnection`; the whole
 * point of this file is a transparent, hand-rolled implementation using the
 * exact protocol primitives (`y-protocols/sync`, `y-protocols/awareness`,
 * `lib0/encoding`, `lib0/decoding`) — pure JS, zero native dependencies.
 *
 * Responsibilities
 * ----------------
 *  1. **Relay + merge.** One authoritative `Y.Doc` per room. Every client's
 *     CRDT updates are applied to the room doc and broadcast to the other
 *     clients — Yjs guarantees all replicas converge. This is the server-side
 *     half of the "both concurrent edits survive" story.
 *  2. **Durable snapshot persistence.** Each room's converged state is written
 *     to `data/<room>.yss` (Yjs State Snapshot = `Y.encodeStateAsUpdate`),
 *     debounced so a burst of edits costs one write. Snapshots are loaded on
 *     boot, so a server restart does not lose committed inventory — a fresh
 *     client that connects after a restart still hydrates the full history.
 *  3. `/health` — liveness + room census, for the Playwright `webServer`
 *     readiness probe and ops monitoring.
 *  4. `GET /rooms/:room/snapshot` — a plain-JSON export of a room's items
 *     (the same shape the client renders), for debugging, the PWA's
 *     NetworkFirst runtime cache, and cross-checking convergence in tests.
 *
 * Ports/paths must match the client (app/src/lib/room.ts):
 *   WebSocket  ws://<host>:4444/<room>
 *   REST       http://<host>:4444/health
 *              http://<host>:4444/rooms/<room>/snapshot
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { sealEpoch, compactionPressure, readEpoch } from './compaction.mjs'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST = process.env.SYNC_HOST ?? '127.0.0.1'
const PORT = Number.parseInt(process.env.SYNC_PORT ?? process.env.PORT ?? '4444', 10)
const DATA_DIR = process.env.SYNC_DATA_DIR ?? path.resolve(__dirname, '..', 'data')
/** Coalesce a burst of updates into a single snapshot write. */
const PERSIST_DEBOUNCE_MS = Number.parseInt(process.env.SYNC_PERSIST_MS ?? '750', 10)
/** WebSocket keepalive; a peer that misses a pong is dropped. */
const PING_TIMEOUT_MS = 30_000
/** Snapshots untouched for longer than this are pruned on boot. */
const SNAPSHOT_MAX_AGE_DAYS = Number.parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS ?? '30', 10)

// --- Epoch compaction (Phase 2 · v2.0) -------------------------------------
// Compaction bounds the qty-delta arrays and the tombstone set (see
// server/src/compaction.mjs). It is safe only at a checkpoint where every
// connected replica has synced — which, in this relay, is when a room has NO
// connected peers. So we compact idle rooms only. AUTO-compaction is opt-in
// (SYNC_AUTO_COMPACT=1) to keep default behaviour — and the green Playwright
// suite — untouched; the admin endpoint POST /rooms/:room/compact is always
// available for an on-demand seal.
const AUTO_COMPACT = process.env.SYNC_AUTO_COMPACT === '1'
/** Tombstones older than this are GC'd on seal (default 7 days). */
const COMPACT_TOMBSTONE_MAX_AGE_MS = Number.parseInt(
  process.env.SYNC_COMPACT_TOMBSTONE_MS ?? String(7 * 86_400_000), 10)
/** Auto-compaction only fires when an idle room has at least this much to shed. */
const COMPACT_MIN_PRESSURE = Number.parseInt(process.env.SYNC_COMPACT_MIN_PRESSURE ?? '64', 10)

// y-websocket message types (wire-compatible with the client provider).
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const WS_CONNECTING = 0
const WS_OPEN = 1

const START_TIME = Date.now()

// ---------------------------------------------------------------------------
// Persistence (debounced file-based Y.Doc snapshots — data/<room>.yss)
// ---------------------------------------------------------------------------

/** Room names arrive from an untrusted URL path; keep them to a safe filename. */
function safeRoomName(room) {
  return room.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default'
}

function snapshotPath(room) {
  return path.join(DATA_DIR, `${safeRoomName(room)}.yss`)
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

/** Synchronously load a room's snapshot into `doc` (called once, at doc creation). */
function loadSnapshot(room, doc) {
  const file = snapshotPath(room)
  try {
    const buf = fs.readFileSync(file)
    if (buf.length > 0) {
      Y.applyUpdate(doc, new Uint8Array(buf), 'persistence')
      return true
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`[persist] failed to load ${file}:`, err.message)
    }
  }
  return false
}

/** Atomic write: temp file + rename, so a crash mid-write never truncates state. */
function writeSnapshot(room, doc) {
  const file = snapshotPath(room)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    const update = Y.encodeStateAsUpdate(doc)
    fs.writeFileSync(tmp, Buffer.from(update))
    fs.renameSync(tmp, file)
  } catch (err) {
    console.error(`[persist] failed to write ${file}:`, err && err.message)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/** Load every previously-persisted room on boot (load-on-boot). */
function preloadRooms() {
  ensureDataDir()
  const cutoff = Date.now() - SNAPSHOT_MAX_AGE_DAYS * 86_400_000
  let pruned = 0
  let loaded = 0
  for (const entry of fs.readdirSync(DATA_DIR)) {
    if (!entry.endsWith('.yss')) continue
    const file = path.join(DATA_DIR, entry)
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true })
        pruned++
        continue
      }
    } catch {
      /* stat/unlink race — fall through and try to preload */
    }
    const room = entry.slice(0, -'.yss'.length)
    getRoomDoc(room)
    loaded++
  }
  console.log(`[persist] pruned ${pruned} snapshot(s) older than ${SNAPSHOT_MAX_AGE_DAYS} day(s)`)
  return loaded
}

// ---------------------------------------------------------------------------
// Per-room shared doc
// ---------------------------------------------------------------------------

/** name -> WSSharedDoc */
const docs = new Map()

class WSSharedDoc extends Y.Doc {
  constructor(name) {
    super({ gc: true })
    this.name = name
    /** conn (WebSocket) -> Set<clientID> (awareness ids it controls) */
    this.conns = new Map()
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)
    this._persistTimer = null

    // Broadcast every doc update to all connected peers as a sync-update.
    this.on('update', (update, _origin, doc) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      doc.conns.forEach((_ids, conn) => send(doc, conn, message))
      schedulePersist(doc)
    })

    // Relay awareness changes and track which conn owns which client ids.
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      const conn = origin
      if (conn !== null && this.conns.has(conn)) {
        const controlled = this.conns.get(conn)
        added.forEach((id) => controlled.add(id))
        removed.forEach((id) => controlled.delete(id))
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
      )
      const message = encoding.toUint8Array(encoder)
      this.conns.forEach((_ids, c) => send(this, c, message))
    })
  }
}

function getRoomDoc(name) {
  let doc = docs.get(name)
  if (doc) return doc
  doc = new WSSharedDoc(name)
  loadSnapshot(name, doc)
  docs.set(name, doc)
  return doc
}

function schedulePersist(doc) {
  if (doc._persistTimer) return // a write is already scheduled within the window
  doc._persistTimer = setTimeout(() => {
    doc._persistTimer = null
    writeSnapshot(doc.name, doc)
  }, PERSIST_DEBOUNCE_MS)
  // Do not keep the event loop alive solely for a pending snapshot.
  if (typeof doc._persistTimer.unref === 'function') doc._persistTimer.unref()
}

function flushAllSnapshots() {
  for (const doc of docs.values()) {
    if (doc._persistTimer) {
      clearTimeout(doc._persistTimer)
      doc._persistTimer = null
    }
    writeSnapshot(doc.name, doc)
  }
}

/**
 * Seal a new compaction epoch for a room (Phase 2 · v2.0).
 *
 * Refuses to compact a room with connected peers unless `force` — those peers
 * are at the current epoch and a seal would strand them mid-session; the safe
 * checkpoint is an idle room (everyone has synced). On success it swaps the
 * in-memory doc for the sealed one, persists the new snapshot, and returns the
 * seal stats. A client that reconnects afterwards discovers the higher
 * meta.epoch and rebases its pending ops (app/src/crdt/rebase.ts) instead of
 * resurrecting the collected state.
 *
 * @returns {{ ok: boolean, reason?: string, room: string, epoch?: number, stats?: object }}
 */
function compactRoomDoc(room, { force = false } = {}) {
  const name = safeRoomName(room)
  const doc = docs.get(name)
  if (!doc) return { ok: false, reason: 'no_such_room', room: name }
  if (doc.conns.size > 0 && !force) {
    return { ok: false, reason: 'peers_connected', room: name, peers: doc.conns.size }
  }

  const { doc: sealed, epoch, stats } = sealEpoch(doc, {
    now: Date.now(),
    tombstoneMaxAgeMs: COMPACT_TOMBSTONE_MAX_AGE_MS
  })

  // Adopt the sealed epoch as the room's authoritative doc. Seed a fresh
  // WSSharedDoc from the sealed state so its update/awareness wiring is intact,
  // then hand any (forced) live peers the new base via the normal broadcast.
  const fresh = new WSSharedDoc(name)
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(sealed), 'compaction')
  const oldConns = doc.conns
  docs.set(name, fresh)
  if (doc._persistTimer) {
    clearTimeout(doc._persistTimer)
    doc._persistTimer = null
  }
  doc.destroy()
  sealed.destroy()

  if (force && oldConns.size > 0) {
    // Move any still-connected sockets onto the new doc and push a full sync.
    oldConns.forEach((_ids, conn) => {
      fresh.conns.set(conn, new Set())
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(encoder, fresh)
      send(fresh, conn, encoding.toUint8Array(encoder))
    })
  }

  writeSnapshot(name, fresh)
  console.log(
    `[compact] ${name} → epoch ${epoch}: kept ${stats.itemsKept} item(s), ` +
    `dropped ${stats.tombstonesDropped} tombstone(s), deltas ${stats.deltasBefore}→${stats.deltasAfter}`
  )
  return { ok: true, room: name, epoch, stats }
}

/**
 * On the transition to an idle room (last peer gone), optionally auto-seal if
 * there is enough to shed. Opt-in via SYNC_AUTO_COMPACT so default/test runs
 * are unaffected.
 */
function maybeAutoCompact(doc) {
  if (!AUTO_COMPACT) return
  if (doc.conns.size > 0) return
  const pressure = compactionPressure(doc, Date.now(), COMPACT_TOMBSTONE_MAX_AGE_MS)
  if (pressure >= COMPACT_MIN_PRESSURE) compactRoomDoc(doc.name)
}

// ---------------------------------------------------------------------------
// WebSocket protocol (hand-rolled setupWSConnection)
// ---------------------------------------------------------------------------

function send(doc, conn, message) {
  if (conn.readyState !== WS_CONNECTING && conn.readyState !== WS_OPEN) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(message, (err) => {
      if (err != null) closeConn(doc, conn)
    })
  } catch {
    closeConn(doc, conn)
  }
}

function closeConn(doc, conn) {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn)
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
    // A room with no live peers keeps its doc in memory for fast reconnect;
    // its state is already durable on disk. (Bounded by rooms-per-session.)
    // Idle is also the safe checkpoint for epoch compaction (opt-in).
    if (doc.conns.size === 0) maybeAutoCompact(doc)
  }
  try {
    conn.close()
  } catch {
    /* already closing */
  }
}

function onMessage(conn, doc, data) {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(data)
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        // --- Epoch stale-writer guard (Phase 2 · v2.0) ----------------------
        // A client that declared an OLDER epoch than the room's current one
        // (ws query param `?epoch=N`, see app/src/crdt/store.ts) still holds
        // pre-seal CRDT structs. Applying its SyncStep2/Update would resurrect
        // items the seal garbage-collected and register-collide with the
        // sealed containers (the exact hazards compaction.mjs documents). So a
        // stale connection is READ-ONLY for sync: we still answer its Step1
        // (it must receive the base to detect the epoch advance and rebase),
        // but its Step2/Update messages are discarded. After the client-side
        // rebase it reconnects declaring the adopted epoch and writes flow.
        if ((conn._declaredEpoch ?? 0) < readEpoch(doc)) {
          const syncType = decoding.readVarUint(decoder)
          if (syncType === syncProtocol.messageYjsSyncStep1) {
            syncProtocol.readSyncStep1(decoder, encoder, doc)
          }
          // messageYjsSyncStep2 / messageYjsUpdate: dropped on purpose.
        } else {
          // readSyncMessage applies incoming step2/updates to `doc` and writes
          // any needed reply (e.g. a step2 in response to the client's step1)
          // into `encoder`. `conn` is the transaction origin so our own update
          // handler does not echo it straight back to the sender.
          syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
        }
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder))
        }
        break
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        )
        break
      }
      default:
        // Unknown message type — ignore rather than drop the connection.
        break
    }
  } catch (err) {
    console.error('[ws] message handling failed:', err && err.message)
    closeConn(doc, conn)
  }
}

/**
 * Hand-rolled setupWSConnection: wire a freshly-accepted socket to its room
 * doc, install the keepalive, and kick off the sync handshake (step1 + current
 * awareness) so the client immediately reconciles.
 */
function setupWSConnection(conn, room) {
  conn.binaryType = 'arraybuffer'
  const doc = getRoomDoc(room)
  doc.conns.set(conn, new Set())

  conn.on('message', (data) => onMessage(conn, doc, new Uint8Array(data)))

  // --- keepalive: drop peers that stop responding to pings -------------------
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) closeConn(doc, conn)
      clearInterval(pingInterval)
      return
    }
    if (doc.conns.has(conn)) {
      pongReceived = false
      try {
        conn.ping()
      } catch {
        closeConn(doc, conn)
        clearInterval(pingInterval)
      }
    }
  }, PING_TIMEOUT_MS)

  conn.on('pong', () => {
    pongReceived = true
  })
  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
  })

  // --- sync handshake: send SyncStep1, then current awareness ----------------
  {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, doc)
    send(doc, conn, encoding.toUint8Array(encoder))

    const awarenessStates = doc.awareness.getStates()
    if (awarenessStates.size > 0) {
      const aEncoder = encoding.createEncoder()
      encoding.writeVarUint(aEncoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        aEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          doc.awareness,
          Array.from(awarenessStates.keys())
        )
      )
      send(doc, conn, encoding.toUint8Array(aEncoder))
    }
  }
}

// ---------------------------------------------------------------------------
// REST: /health and /rooms/:room/snapshot
// ---------------------------------------------------------------------------

/**
 * Reconstruct a room's items as plain JSON — the SAME shape the client derives
 * in crdt/store.readItem, so a test can assert server state equals client
 * state field-for-field (convergence including the server replica).
 */
function exportItems(doc) {
  const items = doc.getMap('items')
  const out = []
  items.forEach((m, id) => {
    const qtyArr = m.get('qty')
    let qty = 0
    if (qtyArr && typeof qtyArr.forEach === 'function') {
      qtyArr.forEach((e) => {
        if (e && typeof e.d === 'number') qty += e.d
      })
    }
    const notes = m.get('notes')
    out.push({
      id,
      sku: m.get('sku') ?? '',
      name: m.get('name') ?? '',
      qty,
      location: m.get('location') ?? '',
      notes: notes && typeof notes.toString === 'function' ? notes.toString() : '',
      lastCounted: m.get('lastCounted') ?? null,
      deleted: m.get('deleted') ?? false,
      createdAt: m.get('createdAt') ?? 0
    })
  })
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // The app runs on a different origin (:5173) and the SW's NetworkFirst
    // cache fetches these; permit cross-origin reads.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

const SNAPSHOT_RE = /^\/rooms\/([^/]+)\/snapshot\/?$/
const COMPACT_RE = /^\/rooms\/([^/]+)\/compact\/?$/

function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*'
    })
    res.end()
    return
  }

  // Admin: on-demand epoch seal (Phase 2 · v2.0). POST /rooms/:room/compact
  // [?force=1]. Refuses a room with connected peers unless force=1.
  if (req.method === 'POST') {
    const cm = COMPACT_RE.exec(url.pathname)
    if (cm) {
      const room = decodeURIComponent(cm[1])
      const result = compactRoomDoc(room, { force: url.searchParams.get('force') === '1' })
      sendJson(res, result.ok ? 200 : 409, result)
      return
    }
    sendJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' })
    return
  }

  if (url.pathname === '/health') {
    let peers = 0
    docs.forEach((doc) => {
      peers += doc.conns.size
    })
    sendJson(res, 200, {
      status: 'ok',
      uptimeMs: Date.now() - START_TIME,
      rooms: Array.from(docs.keys()),
      roomCount: docs.size,
      peers
    })
    return
  }

  const m = SNAPSHOT_RE.exec(url.pathname)
  if (m) {
    // Canonicalize like the ws handler so REST lookups hit the same doc key.
    const room = safeRoomName(decodeURIComponent(m[1]))
    // Only export rooms that already exist — asking for an unknown room must
    // not silently spawn (and persist) an empty doc as a side effect of a GET.
    const doc = docs.get(room)
    const items = doc ? exportItems(doc) : []
    sendJson(res, 200, {
      room,
      exists: Boolean(doc),
      epoch: doc ? readEpoch(doc) : 0,
      count: items.length,
      items
    })
    return
  }

  sendJson(res, 404, { error: 'not_found', path: url.pathname })
}

// ---------------------------------------------------------------------------
// HTTP server + WebSocket upgrade
// ---------------------------------------------------------------------------

const server = http.createServer(handleRequest)
const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (conn, req) => {
  // Room = first path segment, e.g. ws://host:4444/inventory-main
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  // Canonicalize once at the entry point so the live doc-map key, the snapshot
  // filename, and the preload key all agree ("a/b" and "a_b" map to one room).
  const room = safeRoomName(decodeURIComponent(url.pathname.slice(1).split('/')[0]))
  // Epoch the client last adopted (`?epoch=N`, default 0). Drives the
  // stale-writer guard in onMessage; a peer that predates the room's current
  // compaction epoch is served state but its writes are discarded until it
  // rebases and reconnects (app/src/crdt/store.ts + crdt/rebase.ts).
  conn._declaredEpoch = Number.parseInt(url.searchParams.get('epoch') ?? '0', 10) || 0
  setupWSConnection(conn, room)
})

server.on('upgrade', (req, socket, head) => {
  // No auth in this local-first demo relay; accept and hand off to ws.
  wss.handleUpgrade(req, socket, head, (conn) => {
    wss.emit('connection', conn, req)
  })
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  const preloaded = preloadRooms()
  server.listen(PORT, HOST, () => {
    console.log(`[sync] listening on http://${HOST}:${PORT}`)
    console.log(`[sync]   ws       ws://${HOST}:${PORT}/<room>`)
    console.log(`[sync]   health   http://${HOST}:${PORT}/health`)
    console.log(`[sync]   snapshot http://${HOST}:${PORT}/rooms/<room>/snapshot`)
    console.log(`[sync]   data dir ${DATA_DIR}`)
    console.log(`[sync]   preloaded ${preloaded} room snapshot(s) on boot`)
  })
}

function shutdown(signal) {
  console.log(`[sync] ${signal} received — flushing snapshots and closing`)
  flushAllSnapshots()
  wss.close()
  server.close(() => process.exit(0))
  // Hard-stop if sockets linger.
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

boot()

export { exportItems, safeRoomName, WSSharedDoc, getRoomDoc, compactRoomDoc }

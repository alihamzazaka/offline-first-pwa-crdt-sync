/**
 * CRDT store — the single Y.Doc that holds the inventory, its persistence,
 * its transports, live React-friendly snapshots, and conflict observation.
 *
 * Data model
 * ----------
 *   doc.getMap('items') : Y.Map<Y.Map>   keyed by stable client-generated ULID
 *     each item Y.Map:
 *       sku         string
 *       name        string
 *       location    string
 *       notes       Y.Text                 (character-level merge)
 *       qty         Y.Array<QtyDelta>      (accumulated deltas — see ops.ts)
 *       deleted     boolean                (tombstone flag — see ops.ts)
 *       createdAt   number (ms, display only)
 *       lastCounted number | null (ms, display only)
 *
 * Persistence & transports
 * ------------------------
 * - `IndexeddbPersistence` (y-indexeddb): durable local copy — the app is
 *   fully usable with the network off, and survives reload. y-indexeddb also
 *   means every tab of this browser shares ONE persisted doc, so cross-tab
 *   state cannot fork on disk.
 * - `WebsocketProvider` (y-websocket): exchanges exactly the missing CRDT
 *   updates with the server room on (re)connect — this IS the sync engine.
 * - **Cross-tab BroadcastChannel bridge** (below): y-indexeddb handles shared
 *   *persistence* between tabs, but it does not push live updates tab→tab.
 *   y-websocket has its own BroadcastChannel, but it only runs while the
 *   provider is connected — and our OfflineToggle disconnects the provider.
 *   So we relay doc updates over an explicit BroadcastChannel, keyed by room,
 *   making two offline tabs of the same browser converge live (scenario S7)
 *   deterministically, with Yjs idempotency guarding against double-apply.
 */

import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'
import { ROOM, WS_URL } from '../lib/room'
import { ulid } from '../lib/ulid'
import { markAllSynced, pendingCount, pendingOpsInOrder, subscribePendingCount } from '../queue/mutationLog'
import { rebaseOntoBase, type RebaseResult } from './rebase'
import {
  setupBackgroundSync,
  flushPendingOps,
  backgroundSyncAvailable,
  opsQueueSize,
  replayOpsQueue,
  type FlushResult
} from '../queue/backgroundSync'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One CRDT-safe quantity adjustment (see ops.ts for the why). */
export interface QtyDelta {
  /** signed quantity change */
  d: number
  /** ULID of the op that produced it (idempotency / audit) */
  op: string
  /** wall-clock ms — display only, never used for ordering */
  ts: number
}

export type ItemYMap = Y.Map<unknown>

export interface ItemSnapshot {
  id: string
  sku: string
  name: string
  qty: number
  location: string
  notes: string
  lastCounted: number | null
  deleted: boolean
  createdAt: number
}

export type WsStatus = 'connected' | 'connecting' | 'disconnected'

export interface SyncStatus {
  wsStatus: WsStatus
  /** provider has completed initial sync with the server this connection */
  synced: boolean
  /** user/test forced offline via the OfflineToggle */
  offlineForced: boolean
}

export type ConflictKind = 'lww' | 'merged'

export interface ConflictEntry {
  id: string
  ts: number
  itemId: string
  sku: string
  field: string
  /** 'lww' = same scalar field, deterministic winner; 'merged' = both survive (qty deltas / notes text) */
  kind: ConflictKind
  localValue: string
  mergedValue: string
}

// ---------------------------------------------------------------------------
// Doc + persistence + transports
// ---------------------------------------------------------------------------

/** Origin marker for transactions produced by local user ops (ops.ts). */
export const LOCAL_ORIGIN = 'local-op'
/** Origin marker for updates applied from the cross-tab BroadcastChannel. */
const BC_ORIGIN = 'bc-bridge'

export const doc = new Y.Doc()
export const items = doc.getMap<ItemYMap>('items')

export const persistence = new IndexeddbPersistence(`inv-${ROOM}`, doc)

// --- Epoch protocol state (Phase 2 · v2.0) ----------------------------------
// The server periodically seals the room into a new EPOCH (compaction: qty
// deltas collapsed, aged tombstones GC'd — server/src/compaction.mjs). A client
// holding pre-seal state must REBASE, not merge (crdt/rebase.ts explains why).
// The pieces here:
//   - localStorage[EPOCH_LS_KEY]  = the epoch this client last ADOPTED. It is
//     declared to the server as a ws query param; the server discards sync
//     writes from clients declaring an older epoch (stale-writer guard).
//   - localStorage[REBASE_FLAG]   = set when an epoch advance is detected;
//     the local doc + its IndexedDB copy are discarded and the page reloads.
//     On the flagged boot, the fresh doc syncs the server's base and ONLY the
//     journal's pending (un-synced) ops are replayed onto it via rebase.ts —
//     ops touching items the seal collected are dropped (never resurrected).
const EPOCH_LS_KEY = `inv-epoch-${ROOM}`
const REBASE_FLAG = `inv-rebase-${ROOM}`
/** Cross-tab control message: tells sibling tabs to run the same rebase. */
const EPOCH_REBASE_SIGNAL = 'epoch-rebase'

function storedEpoch(): number {
  const n = Number(localStorage.getItem(EPOCH_LS_KEY) ?? '0')
  return Number.isFinite(n) && n > 0 ? n : 0
}
function setStoredEpoch(e: number): void {
  localStorage.setItem(EPOCH_LS_KEY, String(e))
}

type EpochState = 'normal' | 'rebase-boot' | 'reloading'
let epochState: EpochState =
  localStorage.getItem(REBASE_FLAG) === '1' ? 'rebase-boot' : 'normal'
let lastRebase: RebaseResult | null = null
/** True until the first completed sync handshake of this page load. */
let firstHandshake = true
/** Set once the IndexedDB copy has loaded; used to spot fresh replicas. */
let localDocReady = false
let hadLocalState = false

void persistence.whenSynced.then(() => {
  hadLocalState = items.size > 0
  localDocReady = true
})

/**
 * MUTABLE ws params: y-websocket's `url` is a getter that re-encodes `params`
 * on every (re)connect, so updating `epoch` here re-declares this client to
 * the server after it adopts a new epoch.
 */
const wsParams = { epoch: String(storedEpoch()) }

export const provider = new WebsocketProvider(WS_URL, ROOM, doc, {
  connect: true,
  params: wsParams
})

// --- Cross-tab bridge (documented above) -----------------------------------
const bc: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`inv-bc-${ROOM}`) : null

if (bc) {
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== BC_ORIGIN) bc.postMessage(update)
  })
  bc.onmessage = (e: MessageEvent) => {
    // Control message: a sibling tab detected an epoch advance — this tab's
    // in-memory doc is equally stale and must not keep re-persisting it.
    if (e.data === EPOCH_REBASE_SIGNAL) {
      startEpochRebase()
      return
    }
    const u8 = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data as ArrayBuffer)
    Y.applyUpdate(doc, u8, BC_ORIGIN)
  }
}

// ---------------------------------------------------------------------------
// Sync status (subscribable, cached snapshot for useSyncExternalStore)
// ---------------------------------------------------------------------------

let statusCache: SyncStatus = {
  wsStatus: 'connecting',
  synced: false,
  offlineForced: false
}
const statusListeners = new Set<() => void>()

function setStatus(patch: Partial<SyncStatus>): void {
  statusCache = { ...statusCache, ...patch }
  statusListeners.forEach((l) => l())
}

provider.on('status', (event: { status: WsStatus }) => {
  setStatus({ wsStatus: event.status, synced: event.status === 'connected' ? statusCache.synced : false })
})

provider.on('sync', (isSynced: boolean) => {
  setStatus({ synced: isSynced })
  if (isSynced) handleSynced()
})

// ---------------------------------------------------------------------------
// Epoch state machine (Phase 2 · v2.0) — see the block comment above wsParams.
// ---------------------------------------------------------------------------

/**
 * Runs on every completed sync handshake. Decides between three outcomes:
 *  - flagged boot        → finish the rebase (replay pending onto the base),
 *  - server epoch ahead  → start a rebase (this doc holds pre-seal state),
 *  - epochs match        → normal path: journal ops are durable server-side.
 */
function handleSynced(): void {
  if (epochState === 'reloading') return
  if (epochState === 'rebase-boot') {
    finishRebaseBoot()
    return
  }
  const current = getEpoch()
  const stored = storedEpoch()
  if (current > stored) {
    // A fresh replica (empty local doc on this boot's first handshake) merged
    // the base into nothing — there is no pre-seal state to shed, so it may
    // adopt in place. Anything else must discard its doc and rebase.
    if (firstHandshake && localDocReady && !hadLocalState) {
      firstHandshake = false
      adoptEpochInPlace(current)
      return
    }
    startEpochRebase()
    return
  }
  firstHandshake = false
  if (current > 0) setStoredEpoch(current)
  wsParams.epoch = String(current)
  // The server accepted our state on a current-epoch connection — the
  // journal's pending ops are now durable server-side. (On a STALE connection
  // the server discards our writes, so this must not run in that case.)
  void markAllSynced()
}

/** Adopt without a reload — only safe for a replica with no pre-seal state. */
function adoptEpochInPlace(epoch: number): void {
  setStoredEpoch(epoch)
  wsParams.epoch = String(epoch)
  // Reconnect so the server sees the adopted epoch and accepts our writes
  // (the current connection declared the old epoch and is read-only).
  provider.disconnect()
  provider.connect()
}

/**
 * The server sealed a newer epoch than this doc carries. Discard the local
 * doc (its structs are pre-seal: merging them back would resurrect collected
 * items and collide with the sealed containers), then reload; the flagged
 * boot adopts the base and replays ONLY the journal's pending ops.
 */
function startEpochRebase(): void {
  if (epochState !== 'normal') return
  epochState = 'reloading'
  localStorage.setItem(REBASE_FLAG, '1')
  bc?.postMessage(EPOCH_REBASE_SIGNAL)
  provider.disconnect()
  void persistence.clearData().then(() => window.location.reload())
}

/** Flagged boot, first handshake done: the doc now holds exactly the server's
 * epoch base. Replay pending journal ops through rebase.ts (drop-not-resurrect),
 * adopt the epoch, and reconnect declaring it so our writes are accepted. */
function finishRebaseBoot(): void {
  epochState = 'reloading' // block re-entry while the async replay runs
  void (async () => {
    const fromEpoch = storedEpoch()
    const pending = await pendingOpsInOrder()
    lastRebase = rebaseOntoBase(doc, pending)
    lastRebase.fromEpoch = fromEpoch
    const adopted = getEpoch()
    setStoredEpoch(adopted)
    localStorage.removeItem(REBASE_FLAG)
    wsParams.epoch = String(adopted)
    epochState = 'normal'
    provider.disconnect()
    provider.connect() // fresh handshake ships the replayed ops + drains journal
  })()
}

// --- Background Sync wiring (Phase 2 · F4) ----------------------------------
// When the DEVICE is offline the ws provider cannot sync; the mutation journal
// is instead flushed to the server over HTTP (POST /rooms/:room/ops) and, on a
// failed POST, captured by the Service Worker's background-sync queue for
// replay-after-close. This is inert without a controlling SW (so `vite dev` and
// the core suite are unaffected); see queue/backgroundSync.ts.
setupBackgroundSync(subscribePendingCount)

// A mid-session epoch bump (forced compaction while connected) arrives as a
// normal update to the meta map — catch it outside the handshake path too.
doc.getMap('meta').observe(() => {
  if (epochState === 'normal' && !firstHandshake && getEpoch() > storedEpoch()) {
    startEpochRebase()
  }
})

/** Result of the last completed rebase this page load (test/debug surface). */
export function getLastRebase(): RebaseResult | null {
  return lastRebase
}

export function getStatus(): SyncStatus {
  return statusCache
}

export function subscribeStatus(cb: () => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

/**
 * Deterministic offline simulation — the OfflineToggle calls this.
 * Disconnecting the provider is strictly better than DevTools/network-layer
 * offline for tests: it is instant, cannot race a half-open socket, and
 * leaves the rest of the page's networking (Vite HMR, the test harness)
 * untouched. The CRDT keeps accepting writes locally; y-indexeddb keeps
 * persisting them; on `connect()` y-websocket performs its normal sync
 * handshake and exchanges exactly the missing updates.
 */
export function setOffline(off: boolean): void {
  if (off === statusCache.offlineForced) return
  setStatus({ offlineForced: off })
  if (off) {
    provider.disconnect()
    setStatus({ wsStatus: 'disconnected', synced: false })
  } else {
    provider.connect()
  }
}

// ---------------------------------------------------------------------------
// Item snapshots (cached array; recomputed on any doc change)
// ---------------------------------------------------------------------------

export function readItem(id: string, m: ItemYMap): ItemSnapshot {
  const qtyArr = m.get('qty') as Y.Array<QtyDelta> | undefined
  const notes = m.get('notes') as Y.Text | undefined
  let qty = 0
  if (qtyArr) {
    qtyArr.forEach((e) => {
      qty += e.d
    })
  }
  return {
    id,
    sku: (m.get('sku') as string) ?? '',
    name: (m.get('name') as string) ?? '',
    qty,
    location: (m.get('location') as string) ?? '',
    notes: notes ? notes.toString() : '',
    lastCounted: (m.get('lastCounted') as number | null) ?? null,
    deleted: (m.get('deleted') as boolean) ?? false,
    createdAt: (m.get('createdAt') as number) ?? 0
  }
}

let itemsCache: ItemSnapshot[] = []
const itemsListeners = new Set<() => void>()

function recomputeItems(): void {
  const out: ItemSnapshot[] = []
  items.forEach((m, id) => {
    out.push(readItem(id, m))
  })
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  itemsCache = out
  itemsListeners.forEach((l) => l())
}

/** Stable-reference snapshot of ALL items (tombstoned included) sorted by ULID. */
export function getItems(): ItemSnapshot[] {
  return itemsCache
}

/**
 * The compaction epoch this doc currently carries (0 until the server first
 * seals one — see server/src/compaction.mjs and crdt/rebase.ts). Exposed so the
 * UI/tests can observe when an epoch advances; the reconnect path compares it
 * against the server's to decide whether a rebase is required.
 */
export function getEpoch(): number {
  const meta = doc.getMap('meta') as Y.Map<unknown>
  const e = meta.get('epoch')
  return typeof e === 'number' ? e : 0
}

export function subscribeItems(cb: () => void): () => void {
  itemsListeners.add(cb)
  return () => itemsListeners.delete(cb)
}

// ---------------------------------------------------------------------------
// Conflict observation — makes the merge VISIBLE (the demo "whoa" moment)
// ---------------------------------------------------------------------------
//
// Yjs merges silently and correctly; the ConflictLog panel exists to prove it
// happened. Detection: every *local* field write is remembered
// (itemId|field → value, ts). When a *remote* event later changes the same
// field within CONFLICT_WINDOW_MS (which covers "both edited while offline,
// then reconnected"), we log a ConflictEntry showing the local value and the
// merged outcome:
//   - scalar Y.Map fields  → kind 'lww'    (deterministic winner via Yjs ordering)
//   - qty Y.Array / notes Y.Text → kind 'merged' (both writes survive)
// This is observability only — it never influences the merge.

const CONFLICT_WINDOW_MS = 60_000
const localWrites = new Map<string, { value: string; ts: number }>()

let conflictsCache: ConflictEntry[] = []
const conflictListeners = new Set<() => void>()

export function getConflicts(): ConflictEntry[] {
  return conflictsCache
}

export function subscribeConflicts(cb: () => void): () => void {
  conflictListeners.add(cb)
  return () => conflictListeners.delete(cb)
}

function pushConflict(entry: Omit<ConflictEntry, 'id' | 'ts'>): void {
  conflictsCache = [
    { ...entry, id: ulid(), ts: Date.now() },
    ...conflictsCache
  ].slice(0, 200)
  conflictListeners.forEach((l) => l())
}

function fieldKey(itemId: string, field: string): string {
  return `${itemId}|${field}`
}

function currentFieldValue(itemId: string, field: string): string {
  const m = items.get(itemId)
  if (!m) return ''
  if (field === 'qty' || field === 'notes') {
    const snap = readItem(itemId, m)
    return field === 'qty' ? String(snap.qty) : snap.notes
  }
  return String(m.get(field) ?? '')
}

/** Called from ops.ts after each local write so remote overlaps can be spotted. */
export function noteLocalWrite(itemId: string, field: string): void {
  localWrites.set(fieldKey(itemId, field), {
    value: currentFieldValue(itemId, field),
    ts: Date.now()
  })
}

function handleRemoteFieldChange(itemId: string, field: string): void {
  const key = fieldKey(itemId, field)
  const local = localWrites.get(key)
  if (!local) return
  if (Date.now() - local.ts > CONFLICT_WINDOW_MS) {
    localWrites.delete(key)
    return
  }
  const mergedValue = currentFieldValue(itemId, field)
  if (mergedValue === local.value) return // remote agreed / no visible change
  const m = items.get(itemId)
  pushConflict({
    itemId,
    sku: m ? String(m.get('sku') ?? '') : '',
    field,
    kind: field === 'qty' || field === 'notes' ? 'merged' : 'lww',
    localValue: local.value,
    mergedValue
  })
  // refresh memory so a subsequent remote wave doesn't duplicate the entry
  localWrites.set(key, { value: mergedValue, ts: local.ts })
}

items.observeDeep((events) => {
  for (const event of events) {
    const isLocal = event.transaction.local
    const path = event.path
    if (path.length === 1 && event instanceof Y.YMapEvent) {
      // scalar field change on one item
      const itemId = String(path[0])
      const mapEvent = event as Y.YMapEvent<unknown>
      mapEvent.changes.keys.forEach((_change, key) => {
        if (isLocal) noteLocalWrite(itemId, key)
        else handleRemoteFieldChange(itemId, key)
      })
    } else if (path.length === 2) {
      // nested type change: qty Y.Array or notes Y.Text
      const itemId = String(path[0])
      const field = String(path[1])
      if (isLocal) noteLocalWrite(itemId, field)
      else handleRemoteFieldChange(itemId, field)
    }
  }
  recomputeItems()
})

// initial (empty) snapshot; y-indexeddb load will fire the observer above
recomputeItems()

// ---------------------------------------------------------------------------
// Test/debug API — the Playwright suite reads canonical state through this.
// State returned here is derived directly from the Y.Doc (the same source the
// UI renders from), so asserting on it asserts end-to-end CRDT state.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __inv: {
      room: string
      getState: () => ItemSnapshot[]
      getConflicts: () => ConflictEntry[]
      getStatus: () => SyncStatus
      getPending: () => Promise<number>
      getEpoch: () => number
      getLastRebase: () => RebaseResult | null
      setOffline: (off: boolean) => void
      /** Idempotent journal replay (S3 proof). Dynamic import avoids a static store↔ops cycle. */
      replay: () => Promise<{ applied: number; skipped: number }>
      // --- Background Sync (Phase 2 · F4) surface ---
      /** True iff a Service Worker controls this page (background sync is live). */
      bgSyncAvailable: () => boolean
      /** POST the journal's unsynced ops now (fails → SW queue captures them). */
      flushOps: () => Promise<FlushResult>
      /** Number of mutation POSTs waiting in the SW background-sync queue. */
      opsQueueSize: () => Promise<number>
      /** Ask the SW to replay the queued POSTs now (deterministic sync-event stand-in). */
      replayOpsQueue: () => Promise<{ requested: number; remaining: number }>
    }
  }
}

window.__inv = {
  room: ROOM,
  getState: getItems,
  getConflicts,
  getStatus,
  getPending: pendingCount,
  getEpoch,
  getLastRebase,
  setOffline,
  replay: async () => (await import('./ops')).replayJournal(),
  bgSyncAvailable: backgroundSyncAvailable,
  flushOps: flushPendingOps,
  opsQueueSize,
  replayOpsQueue
}
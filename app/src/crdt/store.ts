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
import { markAllSynced, pendingCount } from '../queue/mutationLog'

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

export const provider = new WebsocketProvider(WS_URL, ROOM, doc, {
  connect: true
})

// --- Cross-tab bridge (documented above) -----------------------------------
const bc: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`inv-bc-${ROOM}`) : null

if (bc) {
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== BC_ORIGIN) bc.postMessage(update)
  })
  bc.onmessage = (e: MessageEvent) => {
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
  if (isSynced) {
    // The server acknowledged/absorbed our state — the journal's pending ops
    // are now durable server-side. (Journal is evidence, Yjs is authority.)
    void markAllSynced()
  }
})

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
      setOffline: (off: boolean) => void
      /** Idempotent journal replay (S3 proof). Dynamic import avoids a static store↔ops cycle. */
      replay: () => Promise<{ applied: number; skipped: number }>
    }
  }
}

window.__inv = {
  room: ROOM,
  getState: getItems,
  getConflicts,
  getStatus,
  getPending: pendingCount,
  setOffline,
  replay: async () => (await import('./ops')).replayJournal()
}
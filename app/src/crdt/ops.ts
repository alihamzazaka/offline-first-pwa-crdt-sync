/**
 * Typed CRDT operations over the inventory doc.
 *
 * Every op:
 *  - runs in a single `doc.transact(..., LOCAL_ORIGIN)` (atomic, one update),
 *  - carries a stable client-generated ULID opId,
 *  - is appended to the Dexie mutation journal (the visible offline queue /
 *    audit trail — see queue/mutationLog.ts for the division of labor).
 *
 * Field-level merge comes FREE from the data model: each item is a Y.Map, so
 * concurrent writes to *different* keys of the same item never conflict — the
 * SPEC's "field-level metadata for non-CRDT record concerns" is realized as
 * per-key Y.Map entries rather than a hand-rolled vector-clock table.
 *
 * ── Why qty is an accumulated-delta Y.Array, not a plain field ─────────────
 * A plain `m.set('qty', n)` is register semantics: last-writer-wins per key.
 * Concurrent stock counts then LOSE increments:
 *
 *     start qty=10 · A (offline) receives 5 → set(15)
 *                  · B (offline) sells 3 loose units → set(13)
 *     reconnect    → Yjs deterministically keeps ONE register value: 15 or 13.
 *                    The other adjustment silently vanishes. Wrong stock.
 *
 * Instead each adjustment appends `{d, op, ts}` to a Y.Array and the
 * effective qty is the SUM of all deltas. Y.Array insertions from concurrent
 * clients merge as a union (nothing is dropped, entries are never mutated),
 * so after sync every replica sums the same multiset:
 *
 *     10 (initial delta) + 5 + (-3) = 12 on A, B, and the server.  Correct.
 *
 * That is a PN-counter built from Yjs primitives. Cost: the array grows with
 * adjustment history — acceptable for stock-count sessions, and compactable
 * with the same snapshot/GC strategy as tombstones (below).
 *
 * ── Tombstone policy (delete vs edit) ──────────────────────────────────────
 * `deleteItem` sets `deleted: true` on the item map — it never removes the
 * key. Documented rule for the S4 race (A deletes X while B edits X):
 *
 *   DELETE WINS FOR VISIBILITY, EDITS ARE PRESERVED UNDER THE TOMBSTONE.
 *
 * Both writes touch different keys of the item map, so both survive the CRDT
 * merge: `deleted=true` AND B's edited field. The list UI hides tombstoned
 * items on every replica (deterministic outcome), while B's edit remains in
 * state — auditable, and recoverable by an explicit "restore" (set
 * `deleted:false`) if the product ever wants un-delete.
 * GC policy: v1.0 retained tombstones for the life of the room. Phase 2 (v2.0)
 * adds server-side EPOCH COMPACTION (server/src/compaction.mjs): at a safe
 * checkpoint — an idle room, where every known replica has synced — the server
 * rebuilds the room into a new epoch, collapsing each qty array to a single
 * base delta and dropping tombstones older than the horizon. A long-offline
 * client past the horizon is forced to REBASE, not allowed to resurrect: it
 * adopts the epoch base and replays only its pending journal ops, dropping any
 * that target a collected item (crdt/rebase.ts). The `deletedAt` stamp below is
 * what lets compaction age a tombstone. Proven over thousands of histories in
 * fuzz/epoch-compaction.fuzz.mjs.
 */

import * as Y from 'yjs'
import {
  doc,
  items,
  LOCAL_ORIGIN,
  type ItemYMap,
  type QtyDelta
} from './store'
import { ulid } from '../lib/ulid'
import {
  appendOp,
  allOpsInOrder,
  type OpType,
  type JournalEntry
} from '../queue/mutationLog'
import { getStatus } from './store'

/** Scalar item fields editable via updateField (register / LWW semantics). */
export type ScalarField = 'sku' | 'name' | 'location'

export interface NewItemInput {
  /** Pass an existing ULID to make the call idempotent-by-id (replay-safe). */
  id?: string
  sku: string
  name: string
  qty?: number
  location?: string
  notes?: string
}

function journal(type: OpType, opId: string, payload: Record<string, unknown>): void {
  // If the provider is currently connected+synced the op is effectively
  // synced as soon as Yjs flushes it; otherwise it is pending until the next
  // successful sync handshake marks the journal.
  const s = getStatus()
  const synced: 0 | 1 = s.wsStatus === 'connected' && s.synced ? 1 : 0
  void appendOp({ opId, type, payload, synced })
}

function requireItem(id: string): ItemYMap {
  const m = items.get(id)
  if (!m) throw new Error(`ops: no item with id ${id}`)
  return m
}

/**
 * Create an inventory item. Idempotent by ULID: if the id already exists the
 * call is a no-op and returns the existing id — replaying an offline create
 * (journal replay, double-submit, reconnect races) cannot duplicate records.
 */
export function createItem(input: NewItemInput): string {
  const id = input.id ?? ulid()
  if (items.has(id)) return id
  const opId = ulid()
  doc.transact(() => {
    const m: ItemYMap = new Y.Map()
    m.set('sku', input.sku)
    m.set('name', input.name)
    m.set('location', input.location ?? '')
    m.set('deleted', false)
    m.set('createdAt', Date.now())
    m.set('lastCounted', null)
    const notes = new Y.Text()
    if (input.notes) notes.insert(0, input.notes)
    m.set('notes', notes)
    const qty = new Y.Array<QtyDelta>()
    const initialQty = input.qty ?? 0
    if (initialQty !== 0) {
      qty.push([{ d: initialQty, op: opId, ts: Date.now() }])
    }
    m.set('qty', qty)
    items.set(id, m)
  }, LOCAL_ORIGIN)
  journal('createItem', opId, { id, ...input })
  return id
}

/**
 * Set a scalar field. Per-key Y.Map set = field-level merge for free:
 * concurrent writes to different fields both survive; concurrent writes to
 * the SAME field converge deterministically on every replica (Yjs resolves
 * same-key concurrent sets by its internal client ordering — a documented,
 * deterministic rule, never wall-clock LWW).
 */
export function updateField(id: string, field: ScalarField, value: string): void {
  const m = requireItem(id)
  const opId = ulid()
  doc.transact(() => {
    m.set(field, value)
  }, LOCAL_ORIGIN)
  journal('updateField', opId, { id, field, value })
}

/**
 * CRDT-safe quantity adjustment — appends a delta entry (see module header
 * for why a plain set would lose concurrent increments). Also stamps
 * `lastCounted` (display-only register).
 */
export function adjustQty(id: string, delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return
  const m = requireItem(id)
  const opId = ulid()
  doc.transact(() => {
    const qty = m.get('qty') as Y.Array<QtyDelta>
    qty.push([{ d: delta, op: opId, ts: Date.now() }])
    m.set('lastCounted', Date.now())
  }, LOCAL_ORIGIN)
  journal('adjustQty', opId, { id, delta })
}

/**
 * Tombstone delete — policy documented in the module header. Stamps `deletedAt`
 * (wall-clock ms) so server-side epoch compaction can age a tombstone past a
 * horizon before garbage-collecting it (see server/src/compaction.mjs). Like
 * every other timestamp here it is audit/GC metadata only — never used for
 * merge ordering.
 */
export function deleteItem(id: string): void {
  const m = requireItem(id)
  const opId = ulid()
  doc.transact(() => {
    m.set('deleted', true)
    m.set('deletedAt', Date.now())
  }, LOCAL_ORIGIN)
  journal('deleteItem', opId, { id })
}

/** Explicit un-delete (kept for completeness of the tombstone story). */
export function restoreItem(id: string): void {
  const m = requireItem(id)
  const opId = ulid()
  doc.transact(() => {
    m.set('deleted', false)
    m.set('deletedAt', null) // a restored item is no longer an aging tombstone
  }, LOCAL_ORIGIN)
  journal('updateField', opId, { id, field: 'deleted', value: false })
}

/**
 * Edit notes with character-level merge. The UI hands us the full new string
 * (textarea value); we apply a minimal prefix/suffix diff to the Y.Text so
 * concurrent edits to different parts of the notes BOTH survive — replacing
 * the whole text would degrade Y.Text back to register semantics.
 */
export function editNotes(id: string, newText: string): void {
  const m = requireItem(id)
  const notes = m.get('notes') as Y.Text
  const oldText = notes.toString()
  if (oldText === newText) return
  const opId = ulid()
  doc.transact(() => {
    applyTextDiff(notes, oldText, newText)
  }, LOCAL_ORIGIN)
  journal('editNotes', opId, { id, newText })
}

/**
 * Idempotent journal replay — proof of the "stable op IDs ⇒ replay cannot
 * duplicate" guarantee (SPEC §4 "Offline create → reconnect: no duplicates",
 * docs/05 "After S3 … replay, assert record count equals N").
 *
 * It re-applies every op in the Dexie journal, in ULID (append) order, but is
 * a no-op for anything already present — so replaying the same op set N times
 * yields exactly the same CRDT state as applying it once:
 *   - createItem  → skipped if `items.has(id)` (idempotent by ULID).
 *   - updateField → skipped if the field already holds that value.
 *   - deleteItem  → skipped if already tombstoned.
 *   - adjustQty   → skipped if a qty delta with that op's ULID already exists
 *     (the delta entry carries the op's ULID — the stable id is what makes the
 *     PN-counter replay-safe, not a timestamp).
 *   - editNotes   → skipped if the notes already equal the target text.
 *
 * Deliberately re-applies to the Y.Doc DIRECTLY (not through the public ops),
 * so a replay does NOT append new journal rows or mint new op IDs — the replay
 * itself is idempotent, journal included. Returns how many ops changed state
 * vs. were skipped (a fresh replay of an already-applied set returns
 * `applied: 0`). Used by the Playwright S3 spec via `window.__inv.replay()`.
 */
export async function replayJournal(): Promise<{ applied: number; skipped: number }> {
  const ops = await allOpsInOrder()
  let applied = 0
  let skipped = 0
  doc.transact(() => {
    for (const op of ops) {
      if (reapplyJournalOp(op)) applied++
      else skipped++
    }
  }, LOCAL_ORIGIN)
  return { applied, skipped }
}

/** Re-apply one journalled op idempotently. Returns true iff it changed state. */
function reapplyJournalOp(op: JournalEntry): boolean {
  const p = op.payload
  switch (op.type) {
    case 'createItem': {
      const id = String(p.id ?? '')
      if (!id || items.has(id)) return false
      const m: ItemYMap = new Y.Map()
      m.set('sku', String(p.sku ?? ''))
      m.set('name', String(p.name ?? ''))
      m.set('location', String(p.location ?? ''))
      m.set('deleted', false)
      m.set('createdAt', op.ts)
      m.set('lastCounted', null)
      const notes = new Y.Text()
      if (typeof p.notes === 'string' && p.notes) notes.insert(0, p.notes)
      m.set('notes', notes)
      const qty = new Y.Array<QtyDelta>()
      const initialQty = typeof p.qty === 'number' ? p.qty : 0
      if (initialQty !== 0) qty.push([{ d: initialQty, op: op.opId, ts: op.ts }])
      m.set('qty', qty)
      items.set(id, m)
      return true
    }
    case 'updateField': {
      const m = items.get(String(p.id))
      if (!m) return false
      const field = String(p.field)
      const value = p.value
      if (m.get(field) === value) return false
      m.set(field, value)
      return true
    }
    case 'deleteItem': {
      const m = items.get(String(p.id))
      if (!m) return false
      if (m.get('deleted') === true) return false
      m.set('deleted', true)
      if (typeof m.get('deletedAt') !== 'number') m.set('deletedAt', op.ts)
      return true
    }
    case 'adjustQty': {
      const m = items.get(String(p.id))
      if (!m) return false
      const qty = m.get('qty') as Y.Array<QtyDelta>
      let exists = false
      qty.forEach((e) => {
        if (e.op === op.opId) exists = true
      })
      if (exists) return false
      qty.push([{ d: Number(p.delta), op: op.opId, ts: op.ts }])
      return true
    }
    case 'editNotes': {
      const m = items.get(String(p.id))
      if (!m) return false
      const notes = m.get('notes') as Y.Text
      const target = String(p.newText ?? '')
      const current = notes.toString()
      if (current === target) return false
      applyTextDiff(notes, current, target)
      return true
    }
    default:
      return false
  }
}

/**
 * Minimal common-prefix/common-suffix diff → one delete + one insert on the
 * Y.Text. Enough to preserve intent for ordinary typing/appending; a rich
 * editor binding (y-prosemirror etc.) would replace this in a text-heavy app.
 */
export function applyTextDiff(ytext: Y.Text, oldStr: string, newStr: string): void {
  let start = 0
  const maxStart = Math.min(oldStr.length, newStr.length)
  while (start < maxStart && oldStr[start] === newStr[start]) start++
  let endOld = oldStr.length
  let endNew = newStr.length
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--
    endNew--
  }
  if (endOld > start) ytext.delete(start, endOld - start)
  if (endNew > start) ytext.insert(start, newStr.slice(start, endNew))
}

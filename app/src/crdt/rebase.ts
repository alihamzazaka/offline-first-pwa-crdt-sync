/**
 * Client-side epoch REBASE — Phase 2 (v2.0). The client half of the compaction
 * protocol whose server half is server/src/compaction.mjs.
 *
 * THE PROBLEM
 * -----------
 * The server periodically seals a new "epoch": it rebuilds the room doc with
 * each qty array collapsed to one base delta and tombstones past a horizon
 * garbage-collected (see server/src/compaction.mjs for why). The sealed epoch
 * is a FRESH doc — its item containers are new structs with no shared history
 * with a client's pre-seal doc.
 *
 * A client that was offline across the seal therefore must NOT do a normal Yjs
 * merge on reconnect. If it did:
 *   - a still-live local struct for a GC'd item would RESURRECT it, and
 *   - its old item Y.Map would collide with the epoch's new Y.Map under the same
 *     id, and Yjs would silently drop one container's deltas.
 *
 * THE PROTOCOL
 * ------------
 * When the client sees the server is at a newer epoch than the one its own doc
 * carries, it REBASES:
 *   1. ADOPT the server's epoch base as the new doc (replace, do not merge).
 *   2. REPLAY only its genuinely-pending (synced === 0) journal ops onto that
 *      base, in append order.
 *   3. DROP any replayed op whose target item is absent from the base — that
 *      item was collected, so applying the op would be a resurrection.
 *   4. Resume normal sync from the new base.
 *
 * The mutation journal (queue/mutationLog.ts) is what makes this possible: it is
 * the client's operation history, independent of the CRDT structs, so pending
 * work survives throwing the old doc away. A `createItem` always applies (a
 * pending create is by definition a brand-new item the server has never seen,
 * so it can't have been collected); every other op type is dropped when its
 * item is gone.
 *
 * This module is PURE — it operates on Y.Docs and journal entries and returns
 * counts. crdt/store.ts wires it in: detecting a server epoch ahead of the
 * client's triggers `startEpochRebase` (discard the local doc + IndexedDB copy,
 * reload), and the flagged boot calls `rebaseOntoBase` below to replay the
 * journal's pending ops onto the freshly-synced base — while the server-side
 * stale-writer guard (server/src/index.mjs) discards sync writes from
 * pre-epoch connections so the pre-seal doc can never pollute the room. The
 * algorithm is proven over thousands of histories in
 * fuzz/epoch-compaction.fuzz.mjs and end-to-end (real browsers, real server,
 * real seal) in e2e/specs/epoch-rebase.spec.ts.
 */

import * as Y from 'yjs'
import type { JournalEntry } from '../queue/mutationLog'
import type { ItemYMap, QtyDelta } from './store'

export const ITEMS_KEY = 'items'
export const META_KEY = 'meta'

export interface RebaseResult {
  fromEpoch: number
  toEpoch: number
  /** pending ops re-applied onto the base (changed state) */
  applied: number
  /** pending ops dropped because their item was collected (resurrection prevented) */
  droppedResurrect: number
  /** pending ops that were idempotent no-ops on the base */
  skipped: number
}

/** The epoch a doc carries (0 if never compacted). */
export function readEpoch(doc: Y.Doc): number {
  const meta = doc.getMap(META_KEY)
  const e = meta.get('epoch')
  return typeof e === 'number' ? e : 0
}

/** Rebuild a fresh doc from a server epoch-base update (the doc to adopt). */
export function buildDocFromEpochBase(baseUpdate: Uint8Array): Y.Doc {
  const d = new Y.Doc({ gc: true })
  Y.applyUpdate(d, baseUpdate, 'epoch-base')
  return d
}

type ReapplyOutcome = 'applied' | 'dropped' | 'skipped'

/**
 * Re-apply ONE pending journal op onto the epoch base. Mirrors ops.ts semantics
 * exactly, with one added rule: for every op type except createItem, a missing
 * target item means the item was collected in the seal, so the op is DROPPED
 * (returns 'dropped') rather than recreating the item.
 */
function reapplyPendingOp(items: Y.Map<ItemYMap>, op: JournalEntry): ReapplyOutcome {
  const p = op.payload
  switch (op.type) {
    case 'createItem': {
      const id = String(p.id ?? '')
      if (!id || items.has(id)) return 'skipped'
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
      return 'applied'
    }
    case 'updateField': {
      const m = items.get(String(p.id))
      if (!m) return 'dropped' // item collected — do not resurrect
      const field = String(p.field)
      if (m.get(field) === p.value) return 'skipped'
      m.set(field, p.value)
      return 'applied'
    }
    case 'deleteItem': {
      const m = items.get(String(p.id))
      if (!m) return 'dropped'
      if (m.get('deleted') === true) return 'skipped'
      m.set('deleted', true)
      if (typeof m.get('deletedAt') !== 'number') m.set('deletedAt', op.ts)
      return 'applied'
    }
    case 'adjustQty': {
      const m = items.get(String(p.id))
      if (!m) return 'dropped'
      const qty = m.get('qty') as Y.Array<QtyDelta>
      let exists = false
      qty.forEach((e) => {
        if (e.op === op.opId) exists = true
      })
      if (exists) return 'skipped'
      qty.push([{ d: Number(p.delta), op: op.opId, ts: op.ts }])
      return 'applied'
    }
    case 'editNotes': {
      const m = items.get(String(p.id))
      if (!m) return 'dropped'
      const notes = m.get('notes') as Y.Text
      const target = String(p.newText ?? '')
      if (notes.toString() === target) return 'skipped'
      // whole-string replace onto the base text (base has no char history)
      if (notes.length > 0) notes.delete(0, notes.length)
      if (target) notes.insert(0, target)
      return 'applied'
    }
    default:
      return 'skipped'
  }
}

/**
 * Replay the given pending ops onto an already-adopted epoch base doc, in one
 * transaction. Ops targeting collected items are dropped (no resurrection).
 */
export function rebaseOntoBase(baseDoc: Y.Doc, pendingOps: JournalEntry[]): RebaseResult {
  const items = baseDoc.getMap<ItemYMap>(ITEMS_KEY)
  let applied = 0
  let droppedResurrect = 0
  let skipped = 0
  baseDoc.transact(() => {
    for (const op of pendingOps) {
      const r = reapplyPendingOp(items, op)
      if (r === 'applied') applied++
      else if (r === 'dropped') droppedResurrect++
      else skipped++
    }
  }, 'rebase')
  return { fromEpoch: -1, toEpoch: readEpoch(baseDoc), applied, droppedResurrect, skipped }
}

/**
 * Full adopt-and-rebase step: build a fresh doc from the server's epoch base,
 * replay the client's pending ops onto it, and return the new doc + result.
 * The caller swaps this doc in as the live doc and resumes sync.
 *
 * @param localEpoch  the epoch the client's current doc carries
 * @param baseUpdate  Y.encodeStateAsUpdate of the server's sealed epoch doc
 * @param pendingOps  journal entries with synced === 0, in append order
 */
export function adoptServerEpoch(
  localEpoch: number,
  baseUpdate: Uint8Array,
  pendingOps: JournalEntry[]
): { doc: Y.Doc; result: RebaseResult } {
  const doc = buildDocFromEpochBase(baseUpdate)
  const result = rebaseOntoBase(doc, pendingOps)
  result.fromEpoch = localEpoch
  return { doc, result }
}

/** True iff the server's epoch is ahead of the client's → a rebase is required. */
export function needsRebase(localEpoch: number, serverEpoch: number): boolean {
  return serverEpoch > localEpoch
}

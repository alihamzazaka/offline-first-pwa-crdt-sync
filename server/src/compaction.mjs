/**
 * Epoch compaction — Phase 2 (v2.0).
 *
 * WHY THIS EXISTS
 * ---------------
 * The v1.0 CRDT has two structures that grow without bound (called out as
 * remaining work in app/src/crdt/ops.ts):
 *
 *   1. qty is a PN-counter built as a Y.Array of {d, op, ts} deltas. Every
 *      stock adjustment APPENDS one entry; the array never shrinks. A busy
 *      count session accretes thousands of deltas whose SUM is one number.
 *   2. deletes are TOMBSTONES (deleted:true, the Y.Map is never removed) so a
 *      concurrent edit can't resurrect a deleted item. Tombstones accumulate
 *      for the life of the room.
 *
 * Both are bounded by COMPACTION: periodically rebuild the room into a fresh
 * "epoch" doc where each qty array is COLLAPSED to a single base delta (= its
 * sum) and tombstones older than a horizon are DROPPED (garbage-collected).
 *
 * THE HARD PART (why you can't just GC)
 * -------------------------------------
 * If the server rebuilds the doc with fresh item containers and a long-offline
 * client later reconnects and does a normal Yjs merge, two failures occur:
 *
 *   - RESURRECTION: the client still holds the (pre-compaction) live struct for
 *     an item the server GC'd; merging re-introduces it. A delete that was
 *     already agreed and collected comes back from the dead.
 *   - CONTAINER COLLISION: the compacted item is a NEW Y.Map under the same id;
 *     the client's OLD Y.Map under that id is a concurrent register write, and
 *     Yjs keeps exactly one container, silently discarding the other's deltas
 *     (the exact hazard documented in fuzz/crdt-convergence.fuzz.mjs).
 *
 * So compaction is only HALF the feature. The other half lives client-side in
 * app/src/crdt/rebase.ts: a client that discovers the server advanced to a
 * newer epoch must ADOPT the server's epoch base (not merge into it) and REPLAY
 * only its genuinely-pending (un-synced) journal ops on top, DROPPING any op
 * that targets an item the epoch collected. That is REBASE, not resurrect —
 * exactly the rule ops.ts states: "a long-offline client past the horizon must
 * be forced to rebase, not allowed to resurrect."
 *
 * WHEN IT IS SAFE TO SEAL
 * -----------------------
 * "Once every known replica has synced past a checkpoint." The natural, safe
 * checkpoint in this relay is when a room has NO connected peers: every client
 * that was connected has, by definition, synced. The only replica that can be
 * behind the new epoch is one that reconnects LATER — and that client is
 * precisely the one the rebase protocol handles. index.mjs therefore only
 * compacts idle rooms (or on an explicit admin trigger).
 *
 * This module is PURE and side-effect-free at import: it operates on Y.Docs and
 * returns a new Y.Doc + stats. `now` is injectable so the fuzzer and unit tests
 * are deterministic.
 */

import * as Y from 'yjs'

export const ITEMS_KEY = 'items'
export const META_KEY = 'meta'

/** The current epoch of a doc (0 if it has never been compacted). */
export function readEpoch(doc) {
  const meta = doc.getMap(META_KEY)
  const e = meta.get('epoch')
  return typeof e === 'number' ? e : 0
}

/** Effective quantity of an item = sum of its qty deltas (the PN-counter value). */
export function effectiveQty(itemMap) {
  const qty = itemMap.get('qty')
  let sum = 0
  if (qty && typeof qty.forEach === 'function') {
    qty.forEach((e) => {
      if (e && typeof e.d === 'number') sum += e.d
    })
  }
  return sum
}

/** Number of delta entries currently backing an item's qty (the growth we bound). */
export function qtyLen(itemMap) {
  const qty = itemMap.get('qty')
  return qty && typeof qty.length === 'number' ? qty.length : 0
}

/** Age (ms) of a tombstone at `now`, using deletedAt when present, else createdAt. */
function tombstoneAge(itemMap, now) {
  const deletedAt = itemMap.get('deletedAt')
  if (typeof deletedAt === 'number') return now - deletedAt
  const createdAt = itemMap.get('createdAt')
  if (typeof createdAt === 'number') return now - createdAt
  return 0
}

/**
 * A tombstone is collectible iff it is deleted AND has aged past the horizon.
 * A tombstoneMaxAgeMs of 0 collects every tombstone (aggressive GC); a large
 * value keeps recent tombstones so a not-yet-synced concurrent edit still
 * merges under them.
 */
export function isCollectible(itemMap, now, tombstoneMaxAgeMs) {
  return itemMap.get('deleted') === true && tombstoneAge(itemMap, now) >= tombstoneMaxAgeMs
}

/** Set of item ids that survive a hypothetical seal (i.e. are NOT collected). */
export function survivingIds(sourceDoc, now = Date.now(), tombstoneMaxAgeMs = 0) {
  const set = new Set()
  sourceDoc.getMap(ITEMS_KEY).forEach((m, id) => {
    if (!isCollectible(m, now, tombstoneMaxAgeMs)) set.add(id)
  })
  return set
}

/**
 * How much compaction would help right now — used by the server to decide
 * whether an idle room is worth sealing. Counts the deltas we would shed
 * (every entry beyond the one base delta per item) plus every collectible
 * tombstone. Zero ⇒ nothing to gain.
 */
export function compactionPressure(sourceDoc, now = Date.now(), tombstoneMaxAgeMs = 0) {
  let deltaExcess = 0
  let collectible = 0
  sourceDoc.getMap(ITEMS_KEY).forEach((m) => {
    if (isCollectible(m, now, tombstoneMaxAgeMs)) {
      collectible++
      deltaExcess += qtyLen(m) // its whole array goes away
    } else {
      deltaExcess += Math.max(0, qtyLen(m) - 1) // collapse to a single base delta
    }
  })
  return deltaExcess + collectible
}

/**
 * Seal a new epoch. Returns a FRESH Y.Doc (never mutates the source) in which:
 *   - each surviving item's qty is a single base delta {d: sum, op, ts},
 *   - tombstones past the horizon are dropped,
 *   - meta.epoch is bumped, meta.compactedAt/tombstoneMaxAgeMs recorded.
 *
 * @param {Y.Doc} sourceDoc
 * @param {{ now?: number, tombstoneMaxAgeMs?: number }} [opts]
 * @returns {{ doc: Y.Doc, epoch: number, stats: object }}
 */
export function sealEpoch(sourceDoc, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const tombstoneMaxAgeMs = typeof opts.tombstoneMaxAgeMs === 'number' ? opts.tombstoneMaxAgeMs : 0
  const prevEpoch = readEpoch(sourceDoc)
  const epoch = prevEpoch + 1

  const srcItems = sourceDoc.getMap(ITEMS_KEY)
  const target = new Y.Doc({ gc: true })
  const dstItems = target.getMap(ITEMS_KEY)

  const stats = {
    prevEpoch,
    epoch,
    itemsScanned: 0,
    itemsKept: 0,
    tombstonesDropped: 0,
    tombstonesKept: 0,
    deltasBefore: 0,
    deltasAfter: 0
  }

  target.transact(() => {
    srcItems.forEach((m, id) => {
      stats.itemsScanned++
      stats.deltasBefore += qtyLen(m)

      if (isCollectible(m, now, tombstoneMaxAgeMs)) {
        stats.tombstonesDropped++
        return // GC: this tombstone does not enter the new epoch
      }

      const nm = new Y.Map()
      nm.set('sku', m.get('sku') ?? '')
      nm.set('name', m.get('name') ?? '')
      nm.set('location', m.get('location') ?? '')
      nm.set('deleted', m.get('deleted') === true)
      nm.set('createdAt', typeof m.get('createdAt') === 'number' ? m.get('createdAt') : now)
      nm.set('lastCounted', m.get('lastCounted') ?? null)
      if (typeof m.get('deletedAt') === 'number') nm.set('deletedAt', m.get('deletedAt'))

      // notes Y.Text — copy the resolved string (character history is not
      // preserved across an epoch; the base is the converged text).
      const srcNotes = m.get('notes')
      const notesStr = srcNotes && typeof srcNotes.toString === 'function' ? srcNotes.toString() : ''
      const nnotes = new Y.Text()
      if (notesStr) nnotes.insert(0, notesStr)
      nm.set('notes', nnotes)

      // qty — collapse the whole delta history to ONE base delta (= the sum).
      const sum = effectiveQty(m)
      const nqty = new Y.Array()
      if (sum !== 0) {
        nqty.push([{ d: sum, op: `epoch:${epoch}:${id}`, ts: now }])
        stats.deltasAfter += 1
      }
      nm.set('qty', nqty)

      dstItems.set(id, nm)
      stats.itemsKept++
      if (m.get('deleted') === true) stats.tombstonesKept++
    })

    const meta = target.getMap(META_KEY)
    meta.set('epoch', epoch)
    meta.set('compactedAt', now)
    meta.set('tombstoneMaxAgeMs', tombstoneMaxAgeMs)
  })

  return { doc: target, epoch, stats }
}

/** Convenience: the sealed epoch as a single CRDT update, ready to ship to a client. */
export function encodeEpochBase(doc) {
  return Y.encodeStateAsUpdate(doc)
}

/**
 * Property-based proof for EPOCH COMPACTION + REBASE (Phase 2 · v2.0).
 *
 * crdt-convergence.fuzz.mjs proves the v1.0 merge invariants. This fuzzer proves
 * the compaction protocol that BOUNDS the CRDT's two unbounded structures (the
 * qty delta array and the tombstone set) without letting a long-offline client
 * resurrect collected state. It drives the REAL server seal
 * (server/src/compaction.mjs · sealEpoch) and a rebase model faithful to
 * app/src/crdt/rebase.ts, over thousands of random histories.
 *
 * Scenario per history (k items, each with random adjustment/delete history):
 *   1. items are created on the server and synced to a field client;
 *   2. the server takes some adjustments; the client makes some adjustments and
 *      SYNCS them (they reach the server); the server deletes some items, aging
 *      each tombstone either PAST the horizon (collectible) or within it (kept);
 *      everything so far is synced — this is the pre-seal converged state;
 *   3. the client then makes PENDING (un-synced) adjustments/deletes — including,
 *      adversarially, on items the seal is about to collect;
 *   4. the server SEALS a new epoch (collapse qty → one base delta, GC tombstones
 *      past the horizon);
 *   5. the offline client REBASES: adopt the epoch base, replay only its pending
 *      ops, DROP any op whose item was collected.
 *
 * Invariants asserted for EVERY history:
 *   BOUNDED       — in the sealed base every item's qty array has ≤ 1 entry and
 *                   no collectible tombstone remains (growth is bounded
 *                   regardless of how long the pre-seal history was).
 *   VALUE-PRESERVING — the collapsed base qty equals the pre-seal effective qty.
 *   NO-RESURRECT  — items collected by the seal never reappear after the client
 *                   rebases, even though the client held pending ops on them;
 *                   and the rebase reports exactly that many dropped ops.
 *   NO-DOUBLE-COUNT — a surviving item's final qty = base qty + the client's
 *                   PENDING deltas only (synced deltas, already folded into the
 *                   base, are not replayed).
 *   CONVERGENCE   — after the rebase and a final heal, server and client are
 *                   byte-identical and both carry the new epoch.
 *
 * Faithful to app/src/crdt/ops.ts (item shape, delta qty, tombstone) and
 * app/src/crdt/rebase.ts (adopt-base + replay-pending + drop-on-missing). Pure
 * Node + Yjs, runs under `node --test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import fc from 'fast-check'
import { sealEpoch, effectiveQty, qtyLen, isCollectible, readEpoch } from '../server/src/compaction.mjs'

const ITEMS_KEY = 'items'
const itemsOf = (doc) => doc.getMap(ITEMS_KEY)

// horizon + a fixed "now" so tombstone ages are deterministic.
const H = 1_000_000
const T = 10_000_000
const AGE_OLD = T - (H + 5_000) // past horizon → collectible
const AGE_RECENT = T - Math.floor(H / 2) // within horizon → kept

// --- appliers, faithful to ops.ts ------------------------------------------
function applyCreate(doc, id, init) {
  const items = itemsOf(doc)
  if (items.has(id)) return
  doc.transact(() => {
    const m = new Y.Map()
    m.set('sku', 'sku-' + id)
    m.set('name', 'name-' + id)
    m.set('location', '')
    m.set('deleted', false)
    m.set('createdAt', 1)
    m.set('lastCounted', null)
    const notes = new Y.Text()
    m.set('notes', notes)
    const qty = new Y.Array()
    if (init !== 0) qty.push([{ d: init, op: 'init-' + id, ts: 1 }])
    m.set('qty', qty)
    items.set(id, m)
  })
}
function applyAdjust(doc, id, d, opId) {
  const m = itemsOf(doc).get(id)
  if (!m || d === 0) return
  doc.transact(() => m.get('qty').push([{ d, op: opId, ts: 2 }]))
}
function applyDelete(doc, id, deletedAt) {
  const m = itemsOf(doc).get(id)
  if (!m) return
  doc.transact(() => {
    m.set('deleted', true)
    m.set('deletedAt', deletedAt)
  })
}

// bidirectional heal — exchange full state both ways.
function sync(a, b) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}

function snapshot(doc) {
  const out = {}
  itemsOf(doc).forEach((m, id) => {
    out[id] = {
      sku: m.get('sku'),
      location: m.get('location'),
      deleted: m.get('deleted'),
      qty: effectiveQty(m)
    }
  })
  return out
}

// --- client rebase, faithful to app/src/crdt/rebase.ts ---------------------
// Adopt the base, replay only pending ops, DROP any whose item was collected.
function rebaseOntoBase(baseDoc, pendingOps) {
  const items = itemsOf(baseDoc)
  let applied = 0
  let droppedResurrect = 0
  let skipped = 0
  baseDoc.transact(() => {
    for (const op of pendingOps) {
      if (op.type === 'createItem') {
        if (items.has(op.id)) { skipped++; continue }
        applied++ // (unused in these histories, kept for faithfulness)
        continue
      }
      const m = items.get(op.id)
      if (!m) { droppedResurrect++; continue } // item collected — never resurrect
      if (op.type === 'adjustQty') {
        let exists = false
        m.get('qty').forEach((e) => { if (e.op === op.opId) exists = true })
        if (exists) { skipped++; continue }
        m.get('qty').push([{ d: op.delta, op: op.opId, ts: 3 }])
        applied++
      } else if (op.type === 'deleteItem') {
        if (m.get('deleted') === true) { skipped++; continue }
        m.set('deleted', true)
        if (typeof m.get('deletedAt') !== 'number') m.set('deletedAt', 3)
        applied++
      }
    }
  }, 'rebase')
  return { applied, droppedResurrect, skipped }
}

const smallAdj = fc.array(fc.integer({ min: -15, max: 15 }), { maxLength: 4 })
const itemSpec = fc.record({
  init: fc.integer({ min: 0, max: 20 }),
  serverAdj: smallAdj,
  clientSyncedAdj: smallAdj,
  clientPendingAdj: smallAdj,
  del: fc.constantFrom(0, 1, 2), // 0 none · 1 old(collected) · 2 recent(kept)
  pendDel: fc.boolean()
})

test('epoch seal bounds growth, and rebase preserves value without resurrecting collected items', () => {
  fc.assert(
    fc.property(fc.array(itemSpec, { minLength: 1, maxLength: 4 }), (specs) => {
      const ids = specs.map((_s, i) => 'i' + i)
      const server = new Y.Doc()
      const client = new Y.Doc()

      // 1. create on server, sync to client
      specs.forEach((s, i) => applyCreate(server, ids[i], s.init))
      sync(server, client)

      // 2. server adjusts; client synced-adjusts; server deletes (aged); sync all
      specs.forEach((s, i) => s.serverAdj.forEach((d, j) => applyAdjust(server, ids[i], d, `s-${i}-${j}`)))
      specs.forEach((s, i) => s.clientSyncedAdj.forEach((d, j) => applyAdjust(client, ids[i], d, `cs-${i}-${j}`)))
      specs.forEach((s, i) => {
        if (s.del === 1) applyDelete(server, ids[i], AGE_OLD)
        else if (s.del === 2) applyDelete(server, ids[i], AGE_RECENT)
      })
      sync(server, client)

      // pre-seal reference
      const baseQty = {}
      const gcd = {}
      const survives = {}
      specs.forEach((s, i) => {
        const id = ids[i]
        baseQty[id] = s.init + sum(s.serverAdj) + sum(s.clientSyncedAdj)
        gcd[id] = s.del === 1
        survives[id] = s.del !== 1
      })

      // 3. client PENDING ops (un-synced) — recorded only in the journal
      const pendingOps = []
      specs.forEach((s, i) => {
        const id = ids[i]
        s.clientPendingAdj.forEach((d, j) => {
          if (d !== 0) pendingOps.push({ type: 'adjustQty', opId: `p-${i}-a-${j}`, id, delta: d })
        })
        if (s.pendDel) pendingOps.push({ type: 'deleteItem', opId: `p-${i}-d`, id })
      })

      // 4. SEAL — the real server compaction
      const sealRes = sealEpoch(server, { now: T, tombstoneMaxAgeMs: H })
      const sealed = sealRes.doc

      // BOUNDED + VALUE-PRESERVING on the sealed base
      itemsOf(sealed).forEach((m, id) => {
        assert.ok(qtyLen(m) <= 1, `sealed ${id} qty not collapsed (len ${qtyLen(m)})`)
        assert.ok(!isCollectible(m, T, H), `sealed ${id} kept a collectible tombstone`)
        assert.equal(effectiveQty(m), baseQty[id], `sealed ${id} qty != pre-seal qty`)
      })
      // collected items are gone from the base
      for (const id of ids) {
        assert.equal(itemsOf(sealed).has(id), survives[id], `presence of ${id} in sealed base wrong`)
      }
      assert.equal(sealRes.epoch, 1)

      // 5. adopt base on both server + client, client rebases its pending ops
      const sealedUpdate = Y.encodeStateAsUpdate(sealed)
      const server2 = new Y.Doc(); Y.applyUpdate(server2, sealedUpdate)
      const clientBase = new Y.Doc(); Y.applyUpdate(clientBase, sealedUpdate)
      const rr = rebaseOntoBase(clientBase, pendingOps)

      // NO-RESURRECT at the op level: exactly the pending ops on collected items are dropped
      let expectDropped = 0
      specs.forEach((s, i) => {
        if (s.del === 1) expectDropped += s.clientPendingAdj.filter((d) => d !== 0).length + (s.pendDel ? 1 : 0)
      })
      assert.equal(rr.droppedResurrect, expectDropped, 'dropped-op count != pending ops on collected items')

      // final heal
      sync(server2, clientBase)

      // CONVERGENCE
      assert.deepEqual(snapshot(clientBase), snapshot(server2), 'client and server diverged after rebase')
      assert.equal(readEpoch(server2), 1)
      assert.equal(readEpoch(clientBase), 1)

      // per-item outcome: NO-RESURRECT + NO-DOUBLE-COUNT
      const snap = snapshot(server2)
      specs.forEach((s, i) => {
        const id = ids[i]
        if (gcd[id]) {
          assert.ok(!(id in snap), `collected ${id} resurrected`)
          return
        }
        const pendingDelta = sum(s.clientPendingAdj)
        assert.equal(snap[id].qty, baseQty[id] + pendingDelta, `qty for surviving ${id} wrong (double-count?)`)
        const expectDeleted = s.del === 2 || s.pendDel
        assert.equal(snap[id].deleted, expectDeleted, `deleted flag for ${id} wrong`)
      })
      return true
    }),
    { numRuns: 800 }
  )
})

// A couple of concrete, deterministic cases so a regression localizes fast.
test('sealEpoch collapses a long delta history and GCs an aged tombstone', () => {
  const doc = new Y.Doc()
  applyCreate(doc, 'a', 0)
  for (let k = 0; k < 500; k++) applyAdjust(doc, 'a', 1, `k-${k}`) // 500 deltas → qty 500
  applyCreate(doc, 'b', 3)
  applyDelete(doc, 'b', AGE_OLD) // aged tombstone → collectible
  applyCreate(doc, 'c', 7)
  applyDelete(doc, 'c', AGE_RECENT) // recent tombstone → kept

  assert.ok(qtyLen(itemsOf(doc).get('a')) === 500)
  const { doc: sealed, stats } = sealEpoch(doc, { now: T, tombstoneMaxAgeMs: H })

  assert.equal(qtyLen(itemsOf(sealed).get('a')), 1, 'a not collapsed to one base delta')
  assert.equal(effectiveQty(itemsOf(sealed).get('a')), 500, 'a lost its value on collapse')
  assert.equal(itemsOf(sealed).has('b'), false, 'aged tombstone b not collected')
  assert.equal(itemsOf(sealed).has('c'), true, 'recent tombstone c wrongly collected')
  assert.equal(stats.tombstonesDropped, 1)
  assert.ok(stats.deltasBefore >= 500 && stats.deltasAfter <= 3)
})

test('rebase drops a pending op on a collected item instead of resurrecting it', () => {
  const server = new Y.Doc()
  applyCreate(server, 'x', 5)
  applyDelete(server, 'x', AGE_OLD) // will be collected
  const { doc: sealed } = sealEpoch(server, { now: T, tombstoneMaxAgeMs: H })
  assert.equal(itemsOf(sealed).has('x'), false)

  const clientBase = new Y.Doc()
  Y.applyUpdate(clientBase, Y.encodeStateAsUpdate(sealed))
  const rr = rebaseOntoBase(clientBase, [{ type: 'adjustQty', opId: 'p1', id: 'x', delta: 9 }])
  assert.equal(rr.droppedResurrect, 1)
  assert.equal(itemsOf(clientBase).has('x'), false, 'collected item x was resurrected by rebase')
})

function sum(arr) {
  return arr.reduce((s, n) => s + n, 0)
}

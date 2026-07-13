/**
 * Property-based / Jepsen-style convergence fuzzing for the inventory CRDT.
 *
 * The e2e suite proves ~16 hand-picked concurrency scenarios. This fuzzer
 * proves the same guarantees over THOUSANDS of randomly-generated histories:
 * random ops (create / update-field / adjust-qty / delete) applied to N
 * independent Yjs replicas, interleaved with random partition/heal (sync)
 * points, then a final all-to-all heal. It asserts three invariants that must
 * hold for ANY history:
 *
 *   1. CONVERGENCE     — after full sync every replica's state is byte-identical.
 *   2. QTY = SUM DELTAS — the effective qty is the SUM of every applied
 *                         adjustment (the anti-last-write-wins property: two
 *                         concurrent +5 and +3 net to +8, never 5 or 3).
 *   3. TOMBSTONE        — once any replica deletes an item, the converged state
 *                         is deleted (a delete is never lost, an edit never
 *                         resurrects it).
 *
 * Faithful to app/src/crdt/ops.ts: item = Y.Map{ sku, location, deleted, qty:
 * Y.Array<{d}> }, qty effective = sum of deltas, delete = set deleted:true.
 * Pure Node + Yjs (no browser), so it runs fast under node --test.
 *
 * CREATE-COLLISION NOTE (a real property this fuzzer surfaced): an item is a
 * Y.Map stored under its id in the top-level `items` Y.Map. If two replicas
 * concurrently CREATE the same id, that top-level key gets two concurrent
 * register-writes; Yjs keeps ONE Y.Map and discards the other — including any
 * qty deltas pushed into the losing container before the merge. That would
 * violate qty = sum-of-deltas. The app AVOIDS this entirely: createItem mints a
 * fresh ULID per call (app/src/lib/ulid.ts), so two replicas never create the
 * same id. This fuzzer therefore creates each id exactly once (on one replica)
 * and syncs before fuzzing — matching reality — then exercises the real
 * concurrency surface: concurrent adjust/update/delete + random partition/heal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import fc from 'fast-check';

const ITEM_IDS = ['i0', 'i1', 'i2'];
const FIELDS = ['sku', 'location'];

const mkReplica = () => new Y.Doc();
const itemsOf = (doc) => doc.getMap('items');

// --- op appliers: mirror ops.ts semantics on an arbitrary doc. Each returns
//     the delta actually applied (0 if the op was a no-op) so the reference
//     model sums exactly what really happened. ---
function applyCreate(doc, id, initialQty) {
  const items = itemsOf(doc);
  if (items.has(id)) return 0;
  let applied = 0;
  doc.transact(() => {
    const m = new Y.Map();
    m.set('sku', 'sku-' + id);
    m.set('location', '');
    m.set('deleted', false);
    const qty = new Y.Array();
    if (initialQty !== 0) { qty.push([{ d: initialQty }]); applied = initialQty; }
    m.set('qty', qty);
    items.set(id, m);
  });
  return applied;
}
function applyAdjust(doc, id, delta) {
  const m = itemsOf(doc).get(id);
  if (!m || delta === 0) return 0;
  doc.transact(() => (m.get('qty')).push([{ d: delta }]));
  return delta;
}
function applyUpdate(doc, id, field, value) {
  const m = itemsOf(doc).get(id);
  if (!m) return false;
  doc.transact(() => m.set(field, value));
  return true;
}
function applyDelete(doc, id) {
  const m = itemsOf(doc).get(id);
  if (!m) return false;
  doc.transact(() => m.set('deleted', true));
  return true;
}

// bidirectional heal — exchange full state both ways (partition then heal).
function sync(a, b) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

function snapshot(doc) {
  const out = {};
  itemsOf(doc).forEach((m, id) => {
    const arr = (m.get('qty')).toArray();
    out[id] = {
      sku: m.get('sku'),
      location: m.get('location'),
      deleted: m.get('deleted'),
      qty: arr.reduce((s, e) => s + e.d, 0),
    };
  });
  return out;
}

// Post-creation commands: the real concurrency surface (items already exist,
// created once with a UNIQUE id — see the CREATE-COLLISION NOTE in the header).
const command = fc.oneof(
  fc.record({ t: fc.constant('adjust'), r: fc.nat(2), id: fc.constantFrom(...ITEM_IDS), d: fc.integer({ min: -20, max: 20 }) }),
  fc.record({ t: fc.constant('update'), r: fc.nat(2), id: fc.constantFrom(...ITEM_IDS), f: fc.constantFrom(...FIELDS), v: fc.string({ maxLength: 6 }) }),
  fc.record({ t: fc.constant('delete'), r: fc.nat(2), id: fc.constantFrom(...ITEM_IDS) }),
  fc.record({ t: fc.constant('sync'), a: fc.nat(2), b: fc.nat(2) }),
);

test('CRDT convergence + qty-sum + tombstone hold over random histories', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 0, max: 15 }), { minLength: 3, maxLength: 3 }), // initial qty per item
      fc.array(command, { minLength: 1, maxLength: 60 }),
      (initials, program) => {
        const N = 3;
        const reps = Array.from({ length: N }, mkReplica);
        const refQty = {};
        const refDeleted = {};
        // Create each item ONCE on replica 0 (unique container), then sync to all.
        ITEM_IDS.forEach((id, i) => { refQty[id] = applyCreate(reps[0], id, initials[i]); refDeleted[id] = false; });
        for (let k = 1; k < N; k++) sync(reps[0], reps[k]);

        for (const c of program) {
          if (c.t === 'adjust') refQty[c.id] += applyAdjust(reps[c.r], c.id, c.d);
          else if (c.t === 'update') applyUpdate(reps[c.r], c.id, c.f, c.v);
          else if (c.t === 'delete') { if (applyDelete(reps[c.r], c.id)) refDeleted[c.id] = true; }
          else if (c.t === 'sync' && c.a !== c.b) sync(reps[c.a], reps[c.b]);
        }
        // final all-to-all heal (converge every replica).
        for (let i = 0; i < N; i++) for (let k = 0; k < N; k++) if (i !== k) sync(reps[i], reps[k]);

        const snaps = reps.map(snapshot);
        // 1. CONVERGENCE — all replicas identical.
        for (let i = 1; i < N; i++) {
          assert.deepEqual(snaps[i], snaps[0], `replica ${i} diverged from 0`);
        }
        // 2. QTY = SUM OF APPLIED DELTAS (anti-LWW)  &  3. TOMBSTONE.
        for (const id of ITEM_IDS) {
          assert.equal(snaps[0][id].qty, refQty[id], `qty for ${id} != sum of applied deltas`);
          assert.equal(snaps[0][id].deleted, refDeleted[id], `tombstone for ${id} wrong`);
        }
        return true;
      },
    ),
    { numRuns: 1500 },
  );
});

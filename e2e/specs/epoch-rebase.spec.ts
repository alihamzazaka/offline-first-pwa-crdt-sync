/**
 * S8 — Epoch compaction + rebase-not-resurrect (Phase 2 · v2.0).
 *
 * Two layers of proof in one spec file:
 *
 *  1. REAL-MODULE test (node side): drives the actual shipped modules — the
 *     server's `sealEpoch` (server/src/compaction.mjs) and the client's
 *     `adoptServerEpoch` (app/src/crdt/rebase.ts) — through a deterministic
 *     seal/rebase cycle. This is the same algorithm the 800-history fuzzer
 *     (fuzz/epoch-compaction.fuzz.mjs) proves via a model; here the real
 *     TypeScript module executes.
 *
 *  2. FULL-STACK browser test: two real clients, the real sync server, a real
 *     `POST /rooms/:room/compact` seal while both are offline, then the whole
 *     client protocol on reconnect: stale-writer guard → epoch detection →
 *     clear + reload → pending-op replay → re-declared reconnect → all
 *     replicas converge with the collected item GONE and the pending
 *     adjustment PRESERVED. (The webServer config sets
 *     SYNC_COMPACT_TOMBSTONE_MS=0 so the seal can collect a fresh tombstone.)
 */

import { test, expect, type Page } from '@playwright/test'
import * as Y from 'yjs'
// the REAL shipped modules — compaction from the server, rebase from the app
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs module, no type declarations
import { sealEpoch, effectiveQty, qtyLen } from '../../server/src/compaction.mjs'
import { adoptServerEpoch, readEpoch } from '../../app/src/crdt/rebase'
import type { JournalEntry } from '../../app/src/queue/mutationLog'
import {
  roomFor, launchAB, goOffline, goOnline, waitForSynced,
  createItem, adjustQty, deleteItem, getState, expectPending,
  expectConvergedWithServer, serverItems
} from '../helpers/clients'

const SERVER_HTTP = 'http://127.0.0.1:4444'

// --------------------------------------------------------------------------
// 1. Real-module test — sealEpoch (server) + adoptServerEpoch (app), executed
// --------------------------------------------------------------------------

function mkItem(doc: Y.Doc, id: string, qty: number): void {
  const items = doc.getMap('items')
  doc.transact(() => {
    const m = new Y.Map()
    m.set('sku', `sku-${id}`)
    m.set('name', `name-${id}`)
    m.set('location', '')
    m.set('deleted', false)
    m.set('createdAt', 1)
    m.set('lastCounted', null)
    m.set('notes', new Y.Text())
    const arr = new Y.Array()
    if (qty !== 0) arr.push([{ d: qty, op: `init-${id}`, ts: 1 }])
    m.set('qty', arr)
    items.set(id, m)
  })
}

test('real modules: sealEpoch collapses + GCs, adoptServerEpoch replays pending without resurrecting', () => {
  const server = new Y.Doc()
  mkItem(server, 'keep', 10)
  mkItem(server, 'gone', 3)
  // long adjustment history on the surviving item
  const keep = server.getMap('items').get('keep') as Y.Map<unknown>
  for (let i = 0; i < 100; i++) {
    server.transact(() => (keep.get('qty') as Y.Array<unknown>).push([{ d: 1, op: `k${i}`, ts: 2 }]))
  }
  // tombstone the other item, aged past the horizon
  const gone = server.getMap('items').get('gone') as Y.Map<unknown>
  server.transact(() => {
    gone.set('deleted', true)
    gone.set('deletedAt', 1_000)
  })

  const { doc: sealed, epoch, stats } = sealEpoch(server, { now: 2_000_000, tombstoneMaxAgeMs: 1_000_000 })
  expect(epoch).toBe(1)
  expect(stats.tombstonesDropped).toBe(1)
  const sealedItems = sealed.getMap('items')
  expect(sealedItems.has('gone')).toBe(false)
  expect(qtyLen(sealedItems.get('keep'))).toBe(1)          // 101 deltas → 1 base
  expect(effectiveQty(sealedItems.get('keep'))).toBe(110)  // value preserved

  // the client's REAL rebase module: pending ops on both a kept and a
  // collected item — the latter must be dropped, never resurrected.
  const pending: JournalEntry[] = [
    { opId: 'p1', ts: 3, type: 'adjustQty', payload: { id: 'keep', delta: 5 }, synced: 0 },
    { opId: 'p2', ts: 3, type: 'adjustQty', payload: { id: 'gone', delta: 9 }, synced: 0 },
    { opId: 'p3', ts: 3, type: 'deleteItem', payload: { id: 'gone' }, synced: 0 }
  ]
  const { doc: rebased, result } = adoptServerEpoch(0, Y.encodeStateAsUpdate(sealed), pending)

  expect(result.applied).toBe(1)
  expect(result.droppedResurrect).toBe(2)
  expect(result.fromEpoch).toBe(0)
  expect(result.toEpoch).toBe(1)
  expect(readEpoch(rebased)).toBe(1)
  const rItems = rebased.getMap('items')
  expect(rItems.has('gone')).toBe(false)                    // NOT resurrected
  expect(effectiveQty(rItems.get('keep'))).toBe(115)        // base 110 + pending 5

  // and the rebased doc converges with a server replica via a normal exchange
  const server2 = new Y.Doc()
  Y.applyUpdate(server2, Y.encodeStateAsUpdate(sealed))
  Y.applyUpdate(server2, Y.encodeStateAsUpdate(rebased))
  Y.applyUpdate(rebased, Y.encodeStateAsUpdate(server2))
  expect(effectiveQty(server2.getMap('items').get('keep'))).toBe(115)
  expect(server2.getMap('items').has('gone')).toBe(false)
})

// --------------------------------------------------------------------------
// 2. Full-stack browser test — the whole wire protocol, reload included
// --------------------------------------------------------------------------

interface EpochWindow {
  __inv: {
    getEpoch: () => number
    getLastRebase: () => { applied: number; droppedResurrect: number } | null
    getState: () => unknown[]
  }
}

async function waitForEpoch(page: Page, epoch: number): Promise<void> {
  // The rebase path clears IndexedDB and RELOADS the page; poll across the
  // navigation until the freshly-booted store reports the adopted epoch.
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as EpochWindow).__inv?.getEpoch?.() ?? -1)
        .catch(() => -1), // page mid-reload — retry
      { message: `client should adopt epoch ${epoch}`, timeout: 30_000 }
    )
    .toBe(epoch)
  await waitForSynced(page)
}

test('S8: offline edits across a compaction seal — clients rebase, collected item stays dead, pending survives', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  // Seed: two items, fully converged (server included).
  const xId = await createItem(a.page, { sku: 'X-1', name: 'Doomed', qty: 3 })
  const yId = await createItem(a.page, { sku: 'Y-1', name: 'Survivor', qty: 10 })
  await expectConvergedWithServer(room, a.page, b.page)

  // A tombstones X (deletedAt stamped) and the delete syncs everywhere.
  await deleteItem(a.page, xId)
  await expectConvergedWithServer(room, a.page, b.page)

  // Both clients go offline → the room is idle → the seal checkpoint is safe.
  await goOffline(a.page)
  await goOffline(b.page)

  // B (offline, pre-seal) queues a pending adjustment on the SURVIVING item.
  await adjustQty(b.page, yId, 5)
  await expectPending(b.page, 1)

  // Seal epoch 1: X's tombstone is past the (0 ms) horizon → collected;
  // Y's delta history collapses to a single base delta.
  const res = await a.page.request.post(`${SERVER_HTTP}/rooms/${encodeURIComponent(room)}/compact`)
  expect(res.ok()).toBeTruthy()
  const seal = await res.json()
  expect(seal.ok).toBe(true)
  expect(seal.epoch).toBe(1)
  expect(seal.stats.tombstonesDropped).toBe(1)

  const afterSeal = await serverItems(a.page, room)
  expect(afterSeal.find((i) => i.id === xId)).toBeUndefined()
  expect(afterSeal.find((i) => i.id === yId)?.qty).toBe(10)

  // B reconnects: stale-writer guard blocks its pre-seal doc from polluting
  // the server; B detects epoch 1 > 0, clears + reloads, replays the pending
  // +5 via rebase.ts, reconnects declaring epoch 1.
  await goOnline(b.page)
  await waitForEpoch(b.page, 1)
  await expectPending(b.page, 0)

  const rb = await b.page.evaluate(() => (window as unknown as EpochWindow).__inv.getLastRebase())
  expect(rb, 'B must have performed a rebase').not.toBeNull()
  expect(rb!.applied).toBe(1)              // the pending +5 on Y

  // A reconnects too (no pending) and rebases the same way.
  await goOnline(a.page)
  await waitForEpoch(a.page, 1)

  // Endgame: every replica (A, B, server) agrees — X is gone for good
  // (no resurrection from either client's pre-seal doc), Y = 10 + 5.
  const converged = await expectConvergedWithServer(room, a.page, b.page)
  expect(converged.find((i) => i.id === xId)).toBeUndefined()
  expect(converged.find((i) => i.id === yId)?.qty).toBe(15)

  const srv = await serverItems(a.page, room)
  expect(srv.find((i) => i.id === xId), 'server must not resurrect X').toBeUndefined()
  expect(srv.find((i) => i.id === yId)?.qty).toBe(15)

  await a.context.close()
  await b.context.close()
})

/**
 * S3 — Offline create ×N → reconnect (+ replay).
 *
 * Create N items entirely offline, reconnect, and prove there are EXACTLY N
 * records — no duplicates — identified by their stable client-generated ULIDs.
 * Then REPLAY the same op set (window.__inv.replay → ops.replayJournal) more
 * than once and prove the count is still N: stable op IDs make replay
 * idempotent. Guarantee: no duplicates / idempotency.
 */
import { test, expect } from '@playwright/test'
import {
  launchAB,
  createItem,
  goOffline,
  goOnline,
  getState,
  replayJournal,
  expectConvergedWithServer,
  visible,
  roomFor
} from '../helpers/clients'

const N = 8

test('offline creates replay idempotently — exactly N records, no dupes', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  // A goes offline and creates N items with distinct SKUs.
  await goOffline(a.page)
  const ids: string[] = []
  for (let i = 0; i < N; i++) {
    ids.push(await createItem(a.page, { sku: `SKU-${i}`, name: `item-${i}`, qty: i }))
  }

  // All N are queued as pending offline ops; local ids are unique ULIDs.
  const uniqueLocal = new Set(ids)
  expect(uniqueLocal.size).toBe(N)

  // Reconnect A → the N creates drain to the server and to B.
  await goOnline(a.page)

  // Idempotent replay of the whole journal, run TWICE, must not duplicate.
  const r1 = await replayJournal(a.page)
  const r2 = await replayJournal(a.page)
  expect(r1.applied, 'first replay re-applies nothing already present').toBe(0)
  expect(r2.applied, 'second replay re-applies nothing already present').toBe(0)

  // A second offline→online cycle re-runs the sync handshake (state re-exchange)
  // — CRDT idempotency means it cannot spawn duplicates either.
  await goOffline(a.page)
  await goOnline(a.page)

  const state = await expectConvergedWithServer(room, a.page, b.page)

  // Exactly N records, all distinct ULIDs.
  expect(state.length).toBe(N)
  expect(visible(state).length).toBe(N)
  expect(new Set(state.map((i) => i.id)).size).toBe(N)
  // Every created id is present exactly once on B as well.
  const bIds = (await getState(b.page)).map((i) => i.id).sort()
  expect(bIds).toEqual([...ids].sort())

  await a.context.close()
  await b.context.close()
})

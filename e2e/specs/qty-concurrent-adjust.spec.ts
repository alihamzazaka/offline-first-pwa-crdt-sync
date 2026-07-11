/**
 * Qty concurrent adjust — the delta-counter proof.
 *
 * The failure this defends against: a plain `set('qty', n)` is last-writer-wins,
 * so two concurrent offline stock counts LOSE one increment. Here qty is an
 * accumulated Y.Array of signed deltas (a PN-counter built on Yjs), so
 * concurrent adjustments UNION and SUM.
 *
 * Start qty=10. A (offline) +5, B (offline) +3. Expected on every replica:
 * 10 + 5 + 3 = 18 — both adjustments survive (nothing overwritten).
 * Guarantee: no lost writes for counters.
 */
import { test, expect } from '@playwright/test'
import {
  launchAB,
  createItem,
  adjustQty,
  goOffline,
  goOnline,
  waitForItem,
  expectConvergedWithServer,
  roomFor
} from '../helpers/clients'

test('concurrent offline qty adjustments add up (+5 and +3 -> +8)', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  const id = await createItem(a.page, { sku: 'SKU-QTY', name: 'widget', qty: 10 })
  await waitForItem(b.page, id)

  await goOffline(a.page)
  await goOffline(b.page)

  // Concurrent, disconnected stock adjustments.
  await adjustQty(a.page, id, 5)
  await adjustQty(b.page, id, 3)

  await goOnline(a.page)
  await goOnline(b.page)

  const state = await expectConvergedWithServer(room, a.page, b.page)
  const item = state.find((i) => i.id === id)!

  // 10 + 5 + 3 = 18. A LWW register would have shown 15 or 13 (one lost).
  expect(item.qty).toBe(18)

  await a.context.close()
  await b.context.close()
})

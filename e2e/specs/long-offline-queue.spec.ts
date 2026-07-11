/**
 * S5 — Long-offline queue.
 *
 * Accumulate a LONG run of queued ops during one offline session (50 sequential
 * edits to the same field), then reconnect. Expected: the queue drains and all
 * ops replay correctly AND IN ORDER — the converged value is the LAST edit
 * (n-049) on every replica; had replay been reordered, a different value would
 * survive. Guarantee: ordered replay / queue durability.
 */
import { test, expect } from '@playwright/test'
import {
  launchAB,
  createItem,
  selectItem,
  setScalarSelected,
  goOffline,
  goOnline,
  waitForItem,
  expectPending,
  expectConvergedWithServer,
  roomFor
} from '../helpers/clients'

const OPS = 50

test('long offline queue of 50 ops replays correctly and in order', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  const id = await createItem(a.page, { sku: 'SKU-Q', name: 'n-init', qty: 0 })
  await waitForItem(b.page, id)
  // Baseline is synced, so the queue starts empty.
  await expectPending(a.page, 0)

  // Go offline and enqueue 50 ordered edits to the SAME field.
  await goOffline(a.page)
  await selectItem(a.page, id)
  const values: string[] = []
  for (let i = 0; i < OPS; i++) {
    const v = `n-${String(i).padStart(3, '0')}`
    values.push(v)
    await setScalarSelected(a.page, 'name', v)
  }
  const last = values[values.length - 1]

  // All 50 ops are durably queued while disconnected.
  await expectPending(a.page, OPS)

  // Reconnect → the queue drains completely.
  await goOnline(a.page)
  await expectPending(a.page, 0)

  const state = await expectConvergedWithServer(room, a.page, b.page)
  const item = state.find((i) => i.id === id)!

  // In-order replay: the final value is the LAST edit, on every replica.
  expect(item.name).toBe(last)

  await a.context.close()
  await b.context.close()
})

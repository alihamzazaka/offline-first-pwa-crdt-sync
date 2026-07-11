/**
 * S7 — Multi-tab on one device.
 *
 * Two tabs of the SAME browser context (shared IndexedDB) editing concurrently
 * is a real concurrency source, not just cross-device. Here both tabs go
 * OFFLINE first, so the server cannot be the path of convergence — the tabs
 * must reconcile purely via the shared-persistence + BroadcastChannel bridge
 * (crdt/store.ts). Then we reconnect and confirm the server replica agrees too.
 * Guarantee: cross-tab concurrency stays consistent.
 */
import { test, expect } from '@playwright/test'
import {
  launchClient,
  openTab,
  createItem,
  adjustQty,
  goOffline,
  goOnline,
  waitForItem,
  getItem,
  expectConverged,
  expectConvergedWithServer,
  roomFor
} from '../helpers/clients'

test('two tabs of one browser converge via shared IndexedDB (offline)', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const client = await launchClient(browser, room, 'tab1')
  const tab1 = client.page
  const tab2 = await openTab(client, 'tab2')

  // Take BOTH tabs offline so convergence cannot go through the server.
  await goOffline(tab1)
  await goOffline(tab2)

  // Create in tab1 → tab2 must see it via the cross-tab bridge, offline.
  const id = await createItem(tab1, { sku: 'SKU-TAB', name: 'shared', qty: 4 })
  await waitForItem(tab2, id)

  // Bidirectional: adjust qty in tab2 → tab1 sees it, still offline.
  await adjustQty(tab2, id, 6) // 4 + 6 = 10
  await expect
    .poll(async () => (await getItem(tab1, id))?.qty, { message: 'tab1 sees tab2 qty' })
    .toBe(10)

  // Both offline tabs hold identical state (no server involved).
  await expectConverged(tab1, tab2)

  // Reconnect both tabs → the server replica converges to the same state.
  await goOnline(tab1)
  await goOnline(tab2)
  const state = await expectConvergedWithServer(room, tab1, tab2)
  expect(state.find((i) => i.id === id)!.qty).toBe(10)

  await client.context.close()
})

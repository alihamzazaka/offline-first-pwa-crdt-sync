/**
 * S1 — Concurrent edit, SAME field.
 *
 * Two offline clients change the SAME scalar field (name) of the SAME item.
 * Expected: a DEFINED result — every replica converges to one deterministic
 * value (Yjs same-key concurrent set is resolved by internal client ordering,
 * a documented rule, never wall-clock LWW). Guarantee: defined conflict
 * behavior — never a silent overwrite into garbage, never divergence.
 */
import { test, expect } from '@playwright/test'
import {
  launchAB,
  createItem,
  editField,
  goOffline,
  goOnline,
  waitForItem,
  expectConvergedWithServer,
  roomFor
} from '../helpers/clients'

test('same-field concurrent edit converges to one defined value', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  // Baseline item, created online and synced to both clients.
  const id = await createItem(a.page, { sku: 'SKU-1', name: 'original', qty: 0 })
  await waitForItem(b.page, id)

  // Both go offline and edit the SAME field to DIFFERENT values.
  await goOffline(a.page)
  await goOffline(b.page)
  await editField(a.page, id, 'name', 'name-from-A')
  await editField(b.page, id, 'name', 'name-from-B')

  // Reconnect both.
  await goOnline(a.page)
  await goOnline(b.page)

  // Convergence across A, B, and the server replica.
  const state = await expectConvergedWithServer(room, a.page, b.page)

  const item = state.find((i) => i.id === id)
  expect(item, 'item survived the merge').toBeTruthy()
  // Deterministic winner: exactly one of the two candidate values — no silent
  // corruption, no partial merge, no lost-to-empty.
  expect(['name-from-A', 'name-from-B']).toContain(item!.name)

  await a.context.close()
  await b.context.close()
})

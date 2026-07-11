/**
 * S2 — Concurrent edit, DIFFERENT fields.
 *
 * A edits `name` offline; B edits `location` offline, on the same item.
 * Expected: BOTH survive (per-key Y.Map merge is field-level by construction).
 * Guarantee: no lost writes.
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

test('different-field concurrent edits both survive', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  const id = await createItem(a.page, {
    sku: 'SKU-2',
    name: 'original-name',
    qty: 0,
    location: 'original-loc'
  })
  await waitForItem(b.page, id)

  await goOffline(a.page)
  await goOffline(b.page)
  // A touches name only; B touches location only.
  await editField(a.page, id, 'name', 'edited-by-A')
  await editField(b.page, id, 'location', 'edited-by-B')

  await goOnline(a.page)
  await goOnline(b.page)

  const state = await expectConvergedWithServer(room, a.page, b.page)
  const item = state.find((i) => i.id === id)!

  // No lost writes: both concurrent edits persist.
  expect(item.name).toBe('edited-by-A')
  expect(item.location).toBe('edited-by-B')

  await a.context.close()
  await b.context.close()
})

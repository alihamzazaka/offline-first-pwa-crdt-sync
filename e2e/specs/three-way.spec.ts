/**
 * S6 — Three-way merge (A, B, and a third client vs. the server).
 *
 * Three independent clients all diverge offline — A edits name, B edits
 * location, C applies a qty delta — then all reconnect. Expected: A, B, C AND
 * the server replica converge to ONE identical state, with every divergent
 * edit surviving. Guarantee: full N-way convergence, not just pairwise.
 */
import { test, expect } from '@playwright/test'
import {
  launchClient,
  createItem,
  editField,
  adjustQty,
  goOffline,
  goOnline,
  waitForItem,
  expectConvergedWithServer,
  roomFor
} from '../helpers/clients'

test('three clients + server converge to one identical state', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const a = await launchClient(browser, room, 'A')
  const b = await launchClient(browser, room, 'B')
  const c = await launchClient(browser, room, 'C')

  const id = await createItem(a.page, {
    sku: 'SKU-3W',
    name: 'base-name',
    qty: 10,
    location: 'base-loc'
  })
  await waitForItem(b.page, id)
  await waitForItem(c.page, id)

  await goOffline(a.page)
  await goOffline(b.page)
  await goOffline(c.page)

  await editField(a.page, id, 'name', 'name-A')
  await editField(b.page, id, 'location', 'loc-B')
  await adjustQty(c.page, id, 7) // 10 + 7 = 17

  await goOnline(a.page)
  await goOnline(b.page)
  await goOnline(c.page)

  const state = await expectConvergedWithServer(room, a.page, b.page, c.page)
  const item = state.find((i) => i.id === id)!

  // Every divergent edit survived the three-way merge.
  expect(item.name).toBe('name-A')
  expect(item.location).toBe('loc-B')
  expect(item.qty).toBe(17)

  await a.context.close()
  await b.context.close()
  await c.context.close()
})

/**
 * S4 — Delete vs edit race.
 *
 * A deletes item X offline while B edits a field of X offline; both reconnect.
 * Documented tombstone rule (crdt/ops.ts header):
 *   DELETE WINS FOR VISIBILITY, EDITS ARE PRESERVED UNDER THE TOMBSTONE.
 * Both writes touch different keys of the item map, so both survive the merge:
 * `deleted=true` (from A) AND B's edited field. Every replica hides the item
 * from its list, yet the edit remains in state (auditable / restorable).
 * Guarantee: deterministic delete/edit outcome.
 */
import { test, expect } from '@playwright/test'
import {
  launchAB,
  createItem,
  editField,
  deleteItem,
  goOffline,
  goOnline,
  waitForItem,
  expectConvergedWithServer,
  visible,
  roomFor
} from '../helpers/clients'

test('delete-vs-edit resolves to a tombstone with the edit preserved', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  const id = await createItem(a.page, { sku: 'SKU-DEL', name: 'before', qty: 5 })
  await waitForItem(b.page, id)

  await goOffline(a.page)
  await goOffline(b.page)

  // A deletes; B (still sees the item, offline) edits its name.
  await deleteItem(a.page, id)
  await editField(b.page, id, 'name', 'edited-by-B')

  await goOnline(a.page)
  await goOnline(b.page)

  const state = await expectConvergedWithServer(room, a.page, b.page)
  const item = state.find((i) => i.id === id)!

  // Delete wins for visibility...
  expect(item.deleted).toBe(true)
  expect(visible(state).some((i) => i.id === id)).toBe(false)
  // ...and it is hidden from every client's list (no row rendered).
  await expect(a.page.locator(`[data-testid="item-row"][data-id="${id}"]`)).toHaveCount(0)
  await expect(b.page.locator(`[data-testid="item-row"][data-id="${id}"]`)).toHaveCount(0)
  // ...but B's edit is preserved under the tombstone.
  expect(item.name).toBe('edited-by-B')

  await a.context.close()
  await b.context.close()
})

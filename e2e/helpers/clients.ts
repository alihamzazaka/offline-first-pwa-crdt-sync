/**
 * Test harness for the offline-first sync suite.
 *
 * Every scenario in docs/04 is expressed with the same vocabulary:
 *   - launch isolated clients (each = its own browser context = its own
 *     IndexedDB + its own Y.Doc + its own y-websocket provider),
 *   - drive them through the REAL UI (create/edit/adjust/delete via the same
 *     buttons a user clicks — the data-testids in app/src/ui/*),
 *   - toggle connectivity DETERMINISTICALLY via the in-app OfflineToggle (which
 *     disconnects the provider — see crdt/store.setOffline), never via flaky
 *     network-layer offline,
 *   - read canonical state through `window.__inv` (derived straight from the
 *     Y.Doc — the same source the UI renders from) and assert convergence.
 *
 * The server's REST snapshot (/rooms/:room/snapshot) lets us assert the SERVER
 * replica converged too, not just the clients.
 */

import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

/** Base URL of the hand-rolled sync server (matches app/src/lib/room.ts). */
const SERVER_HTTP = 'http://127.0.0.1:4444'

export interface Client {
  context: BrowserContext
  page: Page
  room: string
  label: string
}

/** One item as the app derives it (crdt/store.ItemSnapshot / server exportItems). */
export interface ItemSnapshot {
  id: string
  sku: string
  name: string
  qty: number
  location: string
  notes: string
  lastCounted: number | null
  deleted: boolean
  createdAt: number
}

export type ScalarField = 'sku' | 'name' | 'location'

// ---------------------------------------------------------------------------
// Rooms — one fresh, isolated room per test (determinism by construction)
// ---------------------------------------------------------------------------

/**
 * A unique, filename-safe room id for this test. Includes the project name and
 * worker index so the two chromium projects (and parallel workers) never share
 * a room / Y.Doc / IndexedDB database.
 */
export function roomFor(testInfo: TestInfo, suffix = ''): string {
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  const project = testInfo.project.name.replace(/[^a-z0-9]+/gi, '')
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  return `t-${slug}-${project}-w${testInfo.workerIndex}-${uniq}${suffix ? `-${suffix}` : ''}`
}

// ---------------------------------------------------------------------------
// Launching clients
// ---------------------------------------------------------------------------

async function openApp(page: Page, room: string, label: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(room)}&client=${encodeURIComponent(label)}`)
  // Wait for the store to wire up the test API AND confirm the room matches.
  await page.waitForFunction(
    (r) => Boolean((window as unknown as InvWindow).__inv) &&
      (window as unknown as InvWindow).__inv.room === r,
    room
  )
  await waitForSynced(page)
}

/** Spawn an isolated client (own context) already synced with the server. */
export async function launchClient(browser: Browser, room: string, label: string): Promise<Client> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await openApp(page, room, label)
  return { context, page, room, label }
}

/** Spawn TWO isolated clients A and B pointed at the same fresh room. */
export async function launchAB(
  browser: Browser,
  room: string
): Promise<{ a: Client; b: Client }> {
  const a = await launchClient(browser, room, 'A')
  const b = await launchClient(browser, room, 'B')
  return { a, b }
}

/** Open a SECOND tab inside an existing client's context (shared IndexedDB — S7). */
export async function openTab(client: Client, label: string): Promise<Page> {
  const page = await client.context.newPage()
  await openApp(page, client.room, label)
  return page
}

// ---------------------------------------------------------------------------
// Connectivity — via the in-app OfflineToggle (deterministic)
// ---------------------------------------------------------------------------

export async function goOffline(page: Page): Promise<void> {
  const toggle = page.getByTestId('offline-toggle')
  if ((await toggle.getAttribute('data-offline')) !== 'true') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('data-offline', 'true')
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-offline-forced', 'true')
}

export async function goOnline(page: Page): Promise<void> {
  const toggle = page.getByTestId('offline-toggle')
  if ((await toggle.getAttribute('data-offline')) !== 'false') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('data-offline', 'false')
  await waitForSynced(page)
}

/** Wait until the provider is connected AND has completed its sync handshake. */
export async function waitForSynced(page: Page): Promise<void> {
  const status = page.getByTestId('sync-status')
  await expect(status).toHaveAttribute('data-ws', 'connected')
  await expect(status).toHaveAttribute('data-synced', 'true')
}

// ---------------------------------------------------------------------------
// Mutations — driven through the real UI components
// ---------------------------------------------------------------------------

export interface NewItem {
  sku: string
  name: string
  qty?: number
  location?: string
}

/** Create an item via the CreateItemForm; returns its server-stable ULID. */
export async function createItem(page: Page, item: NewItem): Promise<string> {
  const before = await getStateIds(page)
  await page.getByTestId('input-sku').fill(item.sku)
  await page.getByTestId('input-name').fill(item.name)
  await page.getByTestId('input-qty').fill(String(item.qty ?? 0))
  await page.getByTestId('input-location').fill(item.location ?? '')
  await page.getByTestId('btn-create').click()
  const handle = await page.waitForFunction((prev: string[]) => {
    const st = (window as unknown as InvWindow).__inv.getState()
    const created = st.find((i) => !prev.includes(i.id))
    return created ? created.id : null
  }, before)
  return (await handle.jsonValue()) as string
}

/** Click an item's row to load it into the editor. */
export async function selectItem(page: Page, id: string): Promise<void> {
  await page.locator(`[data-testid="item-row"][data-id="${id}"]`).click()
  await expect(page.getByTestId('item-editor')).toBeVisible()
}

/** Set a scalar field on the ALREADY-selected item (commit on Enter). */
export async function setScalarSelected(page: Page, field: ScalarField, value: string): Promise<void> {
  const input = page.getByTestId(`editor-${field}`)
  await input.fill(value)
  await input.press('Enter')
}

/** Select an item and set one of its scalar fields (sku/name/location). */
export async function editField(page: Page, id: string, field: ScalarField, value: string): Promise<void> {
  await selectItem(page, id)
  await setScalarSelected(page, field, value)
}

/** Select an item and apply a CRDT-safe quantity delta (+/-). */
export async function adjustQty(page: Page, id: string, delta: number): Promise<void> {
  await selectItem(page, id)
  await page.getByTestId('qty-delta-input').fill(String(Math.abs(delta)))
  await page.getByTestId(delta >= 0 ? 'qty-inc' : 'qty-dec').click()
}

/** Select an item and tombstone-delete it. */
export async function deleteItem(page: Page, id: string): Promise<void> {
  await selectItem(page, id)
  await page.getByTestId('editor-delete').click()
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

interface InvWindow {
  __inv: {
    room: string
    getState: () => ItemSnapshot[]
    getPending: () => Promise<number>
    replay: () => Promise<{ applied: number; skipped: number }>
    setOffline: (off: boolean) => void
  }
}

export async function getState(page: Page): Promise<ItemSnapshot[]> {
  return page.evaluate(() => (window as unknown as InvWindow).__inv.getState())
}

async function getStateIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as InvWindow).__inv.getState().map((i) => i.id))
}

export async function getPending(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as InvWindow).__inv.getPending())
}

/** Trigger idempotent journal replay in the browser (S3 proof). */
export async function replayJournal(page: Page): Promise<{ applied: number; skipped: number }> {
  return page.evaluate(() => (window as unknown as InvWindow).__inv.replay())
}

/** The server's view of a room (its authoritative replica), via REST. */
export async function serverItems(page: Page, room: string): Promise<ItemSnapshot[]> {
  const res = await page.request.get(`${SERVER_HTTP}/rooms/${encodeURIComponent(room)}/snapshot`)
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { items: ItemSnapshot[] }
  return body.items
}

/** Return one item by id (or undefined) from a page's state. */
export async function getItem(page: Page, id: string): Promise<ItemSnapshot | undefined> {
  const st = await getState(page)
  return st.find((i) => i.id === id)
}

/** Only the non-tombstoned items (what the list shows). */
export function visible(items: ItemSnapshot[]): ItemSnapshot[] {
  return items.filter((i) => !i.deleted)
}

// ---------------------------------------------------------------------------
// Convergence assertions
// ---------------------------------------------------------------------------

/** Wait until an item with `id` is present in this page's state. */
export async function waitForItem(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (wantId: string) => (window as unknown as InvWindow).__inv.getState().some((i) => i.id === wantId),
    id
  )
}

/** Wait until the pending-op count settles to `n`. */
export async function expectPending(page: Page, n: number): Promise<void> {
  await expect
    .poll(() => getPending(page), { message: `pending ops should be ${n}` })
    .toBe(n)
}

/**
 * Assert every client converges to byte-identical state, then hard-compare for
 * a readable diff. Returns the converged state.
 */
export async function expectConverged(...pages: Page[]): Promise<ItemSnapshot[]> {
  await expect
    .poll(
      async () => {
        const states = await Promise.all(pages.map((p) => getState(p)))
        const sigs = states.map((s) => JSON.stringify(s))
        return sigs.every((s) => s === sigs[0])
      },
      { message: 'clients did not converge to identical state', timeout: 20_000 }
    )
    .toBe(true)

  const finalStates = await Promise.all(pages.map((p) => getState(p)))
  for (let i = 1; i < finalStates.length; i++) {
    expect(finalStates[i], `client ${i} differs from client 0`).toEqual(finalStates[0])
  }
  return finalStates[0]
}

/**
 * Assert all clients AND the server replica converge to identical state — the
 * full "convergence" guarantee (all replicas, not just pairwise clients).
 */
export async function expectConvergedWithServer(
  room: string,
  ...pages: Page[]
): Promise<ItemSnapshot[]> {
  await expect
    .poll(
      async () => {
        const states = await Promise.all(pages.map((p) => getState(p)))
        const srv = await serverItems(pages[0], room)
        const sigs = [...states.map((s) => JSON.stringify(s)), JSON.stringify(srv)]
        return sigs.every((s) => s === sigs[0])
      },
      { message: 'clients + server did not converge', timeout: 20_000 }
    )
    .toBe(true)

  const finalStates = await Promise.all(pages.map((p) => getState(p)))
  const srv = await serverItems(pages[0], room)
  for (let i = 1; i < finalStates.length; i++) {
    expect(finalStates[i], `client ${i} differs from client 0`).toEqual(finalStates[0])
  }
  expect(srv, 'server replica differs from client 0').toEqual(finalStates[0])
  return finalStates[0]
}

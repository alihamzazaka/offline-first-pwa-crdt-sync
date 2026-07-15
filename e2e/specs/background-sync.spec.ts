/**
 * F4 — genuine Background Sync: offline mutations flush AFTER the tab would be
 * gone, over the HTTP journal-replay path, WITHOUT a live ws reconnect.
 *
 * WHY A SEPARATE ORIGIN (:5174)
 * -----------------------------
 * The Service Worker is only emitted for production builds
 * (vite.config.ts · devOptions.enabled=false), so the dev server on :5173 that
 * every other spec uses has NO SW and cannot exercise Background Sync. This
 * spec therefore targets the built + previewed app on :5174 (a webServer entry
 * in playwright.config.ts), where the real SW registers, claims the page, and
 * owns the workbox background-sync queue (app/src/sw/service-worker.ts).
 *
 * WHAT IS PROVEN
 * --------------
 *  1. While the device is offline, a mutation-journal POST to
 *     `POST /rooms/:room/ops` FAILS and is captured by the SW background-sync
 *     queue (asserted via the SW's queue-size message channel) — the server has
 *     NOT yet received the edits.
 *  2. When connectivity returns, the queued POST is REPLAYED and the server
 *     applies the ops — while the ws provider stays disconnected (offline
 *     toggle held ON). That isolates the proof to the HTTP background-sync path:
 *     the server converges via the replayed POST, not via a ws handshake.
 *
 * HONEST SCOPE OF THE "AFTER THE TAB CLOSES" CLAIM
 * ------------------------------------------------
 * A real closed-tab background `sync` event is not deterministically scriptable
 * in Playwright/Chromium (there is no API to fire it, and letting Chromium fire
 * it on its own is racy). So we drive the SAME code path the browser's `sync`
 * event would — the SW's `Queue.replayRequests()` — directly, via a message to
 * the SW (window.__inv.replayOpsQueue → app/src/sw/service-worker.ts). The tab
 * stays open only because the test harness needs it to send that message and to
 * read state; the request being replayed lives in the SW's IndexedDB queue,
 * independent of the page, exactly as it would after a real tab close. The SW
 * ALSO wires `onSync` to the real background `sync` event for production.
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  roomFor,
  goOffline,
  waitForSynced,
  createItem,
  adjustQty,
  getState,
  getPending,
  serverItems
} from '../helpers/clients'

const PREVIEW_BASE = 'http://127.0.0.1:5174'

/** Wait until the SW has claimed the page (so its fetch handler + queue are live). */
async function ensureControlled(page: Page, url: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controlled = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false
      await navigator.serviceWorker.ready.catch(() => null)
      if (navigator.serviceWorker.controller) return true
      // clients.claim() (on activate) fires controllerchange; wait briefly.
      return await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), 3000)
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(t)
            resolve(true)
          },
          { once: true }
        )
      })
    })
    if (controlled) return
    await page.goto(url) // reload; the now-active SW controls this navigation
    await page.waitForFunction(() => Boolean((window as unknown as { __inv?: unknown }).__inv), null, {
      timeout: 20_000
    })
  }
  throw new Error('service worker never took control of the preview page')
}

/** Open the BUILT app on :5174, wait for the store, the SW control, and sync. */
async function openPreview(context: BrowserContext, room: string, label: string): Promise<Page> {
  const page = await context.newPage()
  const url = `${PREVIEW_BASE}/?room=${encodeURIComponent(room)}&client=${encodeURIComponent(label)}`
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as unknown as { __inv?: unknown }).__inv), null, {
    timeout: 20_000
  })
  await ensureControlled(page, url)
  // The SW controls the page → background sync is available.
  await expect
    .poll(() => page.evaluate(() => window.__inv.bgSyncAvailable()), {
      message: 'a service worker should control the preview page'
    })
    .toBe(true)
  await waitForSynced(page)
  return page
}

test('F4: offline mutations queue in the SW and replay to the server without a ws reconnect', async ({
  browser
}, testInfo) => {
  const room = roomFor(testInfo, 'bgsync')
  const context = await browser.newContext()
  const page = await openPreview(context, room, 'A')

  // --- baseline: create an item ONLINE and confirm the server received it ----
  const xId = await createItem(page, { sku: 'S1', name: 'Widget', qty: 3 })
  await expect
    .poll(async () => (await serverItems(page, room)).some((i) => i.id === xId), {
      message: 'baseline item should sync to the server while online'
    })
    .toBe(true)

  // --- go offline: provider disconnected (ws down) AND device offline --------
  // The offline toggle sets shouldConnect=false so the provider will NOT auto-
  // reconnect when the network returns — that is what isolates the later proof
  // to the HTTP background-sync path.
  await goOffline(page)
  await context.setOffline(true)

  // --- offline edits: adjust the baseline + create a second item -------------
  await adjustQty(page, xId, 7) // 3 → 10
  const yId = await createItem(page, { sku: 'S2', name: 'Gadget', qty: 4 })
  await expect.poll(() => getPending(page)).toBeGreaterThan(0)

  // --- flush → the POST fails (offline) and the SW queue captures it ---------
  const flush = await page.evaluate(() => window.__inv.flushOps())
  expect(flush.attempted).toBeGreaterThan(0)
  expect(flush.ok).toBe(false)
  expect(flush.queued).toBe(true)

  await expect
    .poll(() => page.evaluate(() => window.__inv.opsQueueSize()), {
      message: 'the failed mutation POST should be stored in the SW background-sync queue'
    })
    .toBeGreaterThanOrEqual(1)

  // The server must NOT have the offline edits yet (ws down, POST failed).
  const before = await serverItems(page, room)
  expect(before.find((i) => i.id === xId)?.qty, 'baseline qty unchanged before replay').toBe(3)
  expect(before.find((i) => i.id === yId), 'offline-created item absent before replay').toBeUndefined()

  // --- connectivity returns; replay the queue (ws stays disconnected) --------
  await context.setOffline(false)
  await page.evaluate(() => window.__inv.replayOpsQueue())

  // The server converges via the replayed HTTP POST.
  await expect
    .poll(async () => (await serverItems(page, room)).find((i) => i.id === xId)?.qty, {
      message: 'server should receive the offline qty adjustment via the SW replay'
    })
    .toBe(10)
  await expect
    .poll(async () => (await serverItems(page, room)).some((i) => i.id === yId), {
      message: 'server should receive the offline-created item via the SW replay'
    })
    .toBe(true)

  // Queue drained, local pending cleared (SW notified the page after replay).
  await expect.poll(() => page.evaluate(() => window.__inv.opsQueueSize())).toBe(0)
  await expect.poll(() => getPending(page)).toBe(0)

  // --- prove it was the HTTP path, NOT a ws reconnect ------------------------
  const status = page.getByTestId('sync-status')
  await expect(status).toHaveAttribute('data-offline-forced', 'true')
  await expect(status).toHaveAttribute('data-ws', 'disconnected')

  // The client's own local state (authored offline) is intact and matches.
  const local = await getState(page)
  expect(local.find((i) => i.id === xId)?.qty).toBe(10)
  expect(local.find((i) => i.id === yId)?.name).toBe('Gadget')

  await context.close()
})

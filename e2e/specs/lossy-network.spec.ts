/**
 * NET1–NET3 — Adversarial lossy-network testing (Phase 2 · F2).
 *
 * Every other spec toggles connectivity DETERMINISTICALLY through the in-app
 * OfflineToggle (`provider.disconnect()`). This spec is the hostile
 * counterpart: the network itself misbehaves — real browser-level offline,
 * abortive server-side socket kills in the middle of active sync, and
 * CDP-emulated high latency — and the SAME `expectConvergedWithServer`
 * guarantee must still hold. Convergence has to be a property of the protocol
 * (Yjs state-vector handshake: exchange exactly the missing updates on every
 * reconnect), not of the clean toggle.
 *
 * Fault injection, honestly described:
 *  - `context.setOffline(true)` is real Chromium network emulation, but a
 *    KNOWN limitation is that it does not reliably sever an ALREADY-OPEN
 *    WebSocket (emulation gates new connections and fetches; established
 *    sockets can keep flowing). So NET1 pairs it with the test-only
 *    `POST /rooms/:room/kill-conns` endpoint (SYNC_TEST_ENDPOINTS=1, see
 *    server/src/index.mjs): the kill severs the live sockets, the offline
 *    emulation makes every reconnect attempt fail until heal. Together that
 *    IS a real partition — no writes can reach the server (asserted).
 *  - `kill-conns` uses ws `terminate()` — an abortive TCP drop with no close
 *    handshake, the closest scriptable stand-in for a crashed middlebox. The
 *    provider is given NO signal beyond the drop; recovery is entirely
 *    y-websocket's reconnect-with-backoff + a fresh sync handshake.
 *  - CDP `Network.emulateNetworkConditions` (NET3) adds high latency, with
 *    the honest caveat that Chromium's throttling does not shape established
 *    WebSocket frames (crbug 423246) — so NET3 also kills the sockets
 *    mid-burst, forcing the reconnect + sync handshake to happen under the
 *    emulated conditions.
 *
 * Determinism: unique room per (project, worker, title); every wait is an
 * `expect.poll` / `waitForFunction` on observable state (sync-status testids,
 * pending-op counts, replica snapshots) — no blind sleeps.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  launchAB,
  createItem,
  selectItem,
  setScalarSelected,
  editField,
  adjustQty,
  waitForItem,
  waitForSynced,
  expectPending,
  expectConvergedWithServer,
  serverItems,
  killRoomConns,
  roomFor
} from '../helpers/clients'

/** The provider lost its socket: not synced (and, soon after, not connected). */
async function expectDesynced(page: Page): Promise<void> {
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-synced', 'false')
}

test('NET1: real network offline during edits on both clients, then heal → convergence, no lost writes', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  const id = await createItem(a.page, { sku: 'SKU-NET', name: 'n-init', qty: 10 })
  await waitForItem(b.page, id)
  await expectPending(a.page, 0)

  // --- Partition: browser-level offline + sever the live sockets ----------
  await a.context.setOffline(true)
  await b.context.setOffline(true)
  await killRoomConns(a.page, room)
  await expectDesynced(a.page)
  await expectDesynced(b.page)

  // --- Concurrent edits while truly partitioned ---------------------------
  // Different scalar fields (A: name, B: location) + opposite-sign qty deltas
  // — every one of these writes must survive the heal.
  await editField(a.page, id, 'name', 'n-offline-A')
  await adjustQty(a.page, id, +5)
  await editField(b.page, id, 'location', 'aisle-9')
  await adjustQty(b.page, id, -3)
  await expectPending(a.page, 2)
  await expectPending(b.page, 2)

  // Proof the partition is real: the server replica has seen NONE of it.
  // (page.request runs in Playwright's Node process, unaffected by the
  // browser's offline emulation.)
  const during = await serverItems(a.page, room)
  const srvItem = during.find((i) => i.id === id)!
  expect(srvItem.name).toBe('n-init')
  expect(srvItem.location).toBe('')
  expect(srvItem.qty).toBe(10)

  // --- Heal: providers auto-reconnect with backoff -------------------------
  await a.context.setOffline(false)
  await b.context.setOffline(false)
  await waitForSynced(a.page)
  await waitForSynced(b.page)
  await expectPending(a.page, 0)
  await expectPending(b.page, 0)

  const state = await expectConvergedWithServer(room, a.page, b.page)
  const item = state.find((i) => i.id === id)!
  expect(item.name).toBe('n-offline-A') // A's field write survived
  expect(item.location).toBe('aisle-9') // B's field write survived
  expect(item.qty).toBe(12) // 10 + 5 − 3: BOTH deltas survived

  await a.context.close()
  await b.context.close()
})

test('NET2: repeated abortive socket kills during rapid concurrent edits → convergence still holds', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  const id = await createItem(a.page, { sku: 'SKU-KILL', name: 'n-init', qty: 0 })
  await waitForItem(b.page, id)

  // Rapid concurrent edits: A rewrites the same scalar field 24 times while B
  // applies 24 qty increments — and every 4th round BOTH clients' sockets are
  // terminated mid-flight. The providers are mid-sync (updates in the send
  // buffer, handshakes in progress) when the connection dies; each reconnect
  // must recover exactly the missing updates via the state-vector handshake.
  const ROUNDS = 24
  const KILL_EVERY = 4
  await selectItem(a.page, id)
  let kills = 0
  for (let i = 0; i < ROUNDS; i++) {
    await setScalarSelected(a.page, 'name', `n-${String(i).padStart(3, '0')}`)
    await adjustQty(b.page, id, +1)
    if (i % KILL_EVERY === KILL_EVERY - 1) {
      kills += await killRoomConns(a.page, room)
    }
  }
  // The kills really hit live connections (2 clients × 6 rounds of kills,
  // minus any round where a socket was still reconnecting from the last one).
  expect(kills).toBeGreaterThan(0)

  // Heal is automatic — y-websocket reconnects with backoff on its own.
  await waitForSynced(a.page)
  await waitForSynced(b.page)
  await expectPending(a.page, 0)
  await expectPending(b.page, 0)

  const state = await expectConvergedWithServer(room, a.page, b.page)
  const item = state.find((i) => i.id === id)!
  // A's edits are sequential from one client: the LAST write is the value.
  expect(item.name).toBe(`n-${String(ROUNDS - 1).padStart(3, '0')}`)
  // Not one of B's 24 increments was lost across 6 socket kills.
  expect(item.qty).toBe(ROUNDS)

  await a.context.close()
  await b.context.close()
})

test('NET3: high-latency network (CDP emulation) + a mid-burst socket kill → convergence still holds', async ({ browser }, testInfo) => {
  const room = roomFor(testInfo)
  const { a, b } = await launchAB(browser, room)

  const id = await createItem(a.page, { sku: 'SKU-SLOW', name: 'n-init', qty: 0 })
  await waitForItem(b.page, id)

  // 500 ms RTT latency + ~64 KiB/s both ways on BOTH clients. Chromium does
  // not shape frames on an already-established WebSocket (crbug 423246), so
  // the socket kill below forces a reconnect whose ws handshake — and all the
  // page's HTTP — does go through these conditions.
  const slow = {
    offline: false,
    latency: 500,
    downloadThroughput: 64 * 1024,
    uploadThroughput: 64 * 1024
  }
  const cdpA = await a.context.newCDPSession(a.page)
  const cdpB = await b.context.newCDPSession(b.page)
  await cdpA.send('Network.enable')
  await cdpB.send('Network.enable')
  await cdpA.send('Network.emulateNetworkConditions', slow)
  await cdpB.send('Network.emulateNetworkConditions', slow)

  const ROUNDS = 8
  await selectItem(a.page, id)
  for (let i = 0; i < ROUNDS; i++) {
    await setScalarSelected(a.page, 'name', `slow-${i}`)
    await adjustQty(b.page, id, +1)
    if (i === ROUNDS / 2) {
      // Mid-burst kill: the reconnect handshake now runs under 500 ms RTT.
      await killRoomConns(a.page, room)
    }
  }

  // Converge while STILL throttled — the guarantee must hold under latency,
  // not merely after it is lifted.
  await waitForSynced(a.page)
  await waitForSynced(b.page)
  const state = await expectConvergedWithServer(room, a.page, b.page)
  const item = state.find((i) => i.id === id)!
  expect(item.name).toBe(`slow-${ROUNDS - 1}`)
  expect(item.qty).toBe(ROUNDS)

  await cdpA.detach()
  await cdpB.detach()
  await a.context.close()
  await b.context.close()
})

/**
 * Background Sync — the HTTP replay path for the mutation journal (Phase 2 · F4).
 *
 * WHY THIS EXISTS
 * ---------------
 * The ws provider (y-websocket) is the primary sync engine, but it only retries
 * WHILE THE TAB IS OPEN. Close the tab with un-synced offline edits and those
 * edits wait until the app is reopened. A genuine offline-first app needs the
 * mutations to flush even after the tab is gone.
 *
 * The Background Sync API solves exactly this: a POST that fails because the
 * device is offline is stored by the Service Worker in IndexedDB and replayed by
 * the browser when connectivity returns — with no page open. This module is the
 * page-side half; app/src/sw/service-worker.ts is the SW half (a workbox
 * `Queue` on a NetworkOnly route for `POST /rooms/:room/ops`).
 *
 * THE FLOW
 * --------
 *   1. While the device is offline (`navigator.onLine === false`) and a SW is
 *      controlling the page, `flushPendingOps` POSTs the journal's unsynced ops
 *      to the server's `/ops` endpoint.
 *   2. The POST fails (no network); the SW's route captures it into the
 *      background-sync queue (see the SW's `fetchDidFail`).
 *   3. When connectivity returns the browser fires a `sync` event and the SW
 *      replays the queued POST — even if this tab has since closed. The server
 *      applies the ops idempotently (server/src/index.mjs `POST /rooms/:room/ops`
 *      reuses the epoch/rebase drop-not-resurrect semantics).
 *   4. On a SUCCESSFUL direct POST (online), the server durably holds the ops so
 *      they are marked synced immediately; the SW also notifies every client
 *      after a queued replay so a still-open tab clears its pending flag too.
 *
 * SAFETY / SCOPE
 * --------------
 * The whole path is a NO-OP unless a Service Worker actually controls the page
 * (`backgroundSyncAvailable()`), so it is inert under `vite dev` (SW disabled)
 * and the existing Playwright suite is unaffected. It is exercised against the
 * built+preview app in e2e/specs/background-sync.spec.ts.
 */

import { pendingOpsInOrder, markAllSynced } from './mutationLog'
import { ROOM, SERVER_HTTP_URL } from '../lib/room'

const OPS_URL = `${SERVER_HTTP_URL}/rooms/${encodeURIComponent(ROOM)}/ops`
/** localStorage key store.ts uses for the adopted epoch (read directly to avoid a cycle). */
const EPOCH_LS_KEY = `inv-epoch-${ROOM}`

function storedEpoch(): number {
  try {
    const n = Number(localStorage.getItem(EPOCH_LS_KEY) ?? '0')
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * True iff a Service Worker is actively controlling this page. Only then is a
 * failed POST captured by the background-sync queue — otherwise the ws provider
 * remains the only sync path and this module stays inert.
 */
export function backgroundSyncAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    !!navigator.serviceWorker.controller
  )
}

export interface FlushResult {
  /** number of unsynced ops the flush attempted to POST */
  attempted: number
  /** the direct POST succeeded (server durably holds the ops) */
  ok: boolean
  /** the POST failed and the SW background-sync queue captured it for replay */
  queued: boolean
  applied?: number
  skipped?: number
  dropped?: number
}

/**
 * POST the journal's unsynced ops to the server's `/ops` endpoint. When the
 * device is offline the request fails and the SW queues it (replay-after-close);
 * on success the ops are marked synced. Returns what happened.
 */
export async function flushPendingOps(): Promise<FlushResult> {
  const pending = await pendingOpsInOrder()
  if (pending.length === 0) return { attempted: 0, ok: true, queued: false }
  const ops = pending.map((o) => ({ opId: o.opId, ts: o.ts, type: o.type, payload: o.payload }))
  try {
    const res = await fetch(OPS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops, room: ROOM, epoch: storedEpoch() })
    })
    if (!res.ok) return { attempted: ops.length, ok: false, queued: false }
    const body = (await res.json().catch(() => ({}))) as Partial<FlushResult>
    // The server now durably holds these ops; clear the pending flag so we do
    // not double-post. The ws path, whenever it reconnects, is idempotent.
    await markAllSynced()
    return {
      attempted: ops.length,
      ok: true,
      queued: false,
      applied: body.applied,
      skipped: body.skipped,
      dropped: body.dropped
    }
  } catch {
    // Network failure → if a SW controls the page its background-sync queue
    // captured the POST and will replay it when connectivity returns.
    return { attempted: ops.length, ok: false, queued: backgroundSyncAvailable() }
  }
}

// ---------------------------------------------------------------------------
// SW control channel (deterministic size / replay — no scriptable 'sync' event)
// ---------------------------------------------------------------------------

function swMessage<T>(message: unknown, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const sw = navigator.serviceWorker?.controller
    if (!sw) {
      reject(new Error('no active service worker'))
      return
    }
    const ch = new MessageChannel()
    const timer = setTimeout(() => reject(new Error('sw message timeout')), timeoutMs)
    ch.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer)
      resolve(e.data as T)
    }
    sw.postMessage(message, [ch.port2])
  })
}

/** Ask the SW how many mutation POSTs are waiting in the background-sync queue. */
export async function opsQueueSize(): Promise<number> {
  if (!backgroundSyncAvailable()) return 0
  const r = await swMessage<{ size: number }>({ type: 'OPS_QUEUE_SIZE' })
  return r.size
}

/**
 * Ask the SW to replay the queued mutation POSTs NOW (the deterministic stand-in
 * for the browser's background 'sync' event, which is not scriptable in a test).
 * Returns how many were requested and how many remain (0 = fully drained).
 */
export async function replayOpsQueue(): Promise<{ requested: number; remaining: number }> {
  return swMessage<{ requested: number; remaining: number }>({ type: 'REPLAY_OPS_QUEUE' })
}

// ---------------------------------------------------------------------------
// Auto-flush wiring
// ---------------------------------------------------------------------------

let flushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Schedule a debounced flush IFF the device is offline and a SW can capture the
 * POST. Gating on `navigator.onLine === false` is deliberate: Background Sync is
 * for a genuinely offline DEVICE. When the device is back online we do NOT fire
 * a fresh direct POST here — the SW replays the already-queued request instead,
 * which is the path this feature exists to prove.
 */
export function maybeScheduleFlush(): void {
  if (typeof navigator === 'undefined') return
  if (navigator.onLine) return
  if (!backgroundSyncAvailable()) return
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPendingOps()
  }, 300)
}

let wired = false

/**
 * Wire the auto-flush triggers once. Called from crdt/store.ts. Idempotent.
 *  - `offline` window event → the device just went offline: schedule a flush so
 *    the unsynced journal enters the SW queue for replay-after-close.
 *  - `pendingChanged` (a fresh mutation while offline) → schedule another flush.
 *  - SW `OPS_QUEUE_REPLAYED` message → the server durably applied the queued
 *    ops (this or another tab), so clear the local pending flag.
 */
export function setupBackgroundSync(onPendingChanged: (cb: () => void) => void): void {
  if (wired || typeof window === 'undefined') return
  wired = true

  window.addEventListener('offline', () => maybeScheduleFlush())
  onPendingChanged(() => maybeScheduleFlush())

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as { type?: string } | undefined
      if (data && data.type === 'OPS_QUEUE_REPLAYED') {
        void markAllSynced()
      }
    })
  }
}

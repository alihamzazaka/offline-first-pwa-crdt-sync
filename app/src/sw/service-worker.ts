/// <reference lib="webworker" />
/**
 * Custom service worker (vite-plugin-pwa `injectManifest`) — Phase 2 · F4.
 *
 * We switched from the generated SW to a hand-written one for ONE reason: a
 * genuine Background Sync queue for the mutation journal. The generated SW can
 * precache and runtime-cache, but it cannot expose a deterministic "replay the
 * queue now" hook, and the browser's real background `sync` event is not
 * scriptable from a test. So this SW owns a workbox `Queue` and adds a small
 * message channel to drive/inspect it.
 *
 * Everything else mirrors the documented v1.0 policy (vite.config.ts):
 *   - precache the built shell (offline load),
 *   - NetworkFirst for the sync server's REST surface (fresh online, cached
 *     fallback offline),
 *   - `clientsClaim()` so every tab runs one version, but NEVER `skipWaiting()`
 *     — an offline-first app may hold un-synced mutations; the user opts into an
 *     update via the toast in app/src/sw/register.ts.
 *
 * BACKGROUND SYNC (the new part)
 * ------------------------------
 * `POST /rooms/:room/ops` (the HTTP mutation-journal replay endpoint) is routed
 * NetworkOnly with a fetchDidFail hook that pushes the failed request into a
 * workbox `Queue`. workbox registers a `sync` listener, so when connectivity
 * returns the browser replays the queued POST — EVEN IF THE TAB HAS CLOSED. The
 * `message` handler additionally lets a page report the queue size or trigger a
 * replay immediately (used by e2e/specs/background-sync.spec.ts, and usable as a
 * "sync now" affordance).
 */
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { clientsClaim } from 'workbox-core'
import { registerRoute } from 'workbox-routing'
import { NetworkFirst, NetworkOnly } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { Queue } from 'workbox-background-sync'

declare const self: ServiceWorkerGlobalScope

// --- Precache the built shell (manifest injected by vite-plugin-pwa) --------
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Claim clients so every tab runs one version; do NOT skipWaiting (see header).
clientsClaim()

// --- NetworkFirst for the sync server REST surface (parity with v1.0) -------
registerRoute(
  ({ url }) => /(?:\/rooms\/[^/]+\/snapshot|\/health)$/.test(url.pathname),
  new NetworkFirst({
    cacheName: 'api-v1',
    networkTimeoutSeconds: 3,
    plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 })]
  })
)

// --- Background Sync queue for the mutation journal (Phase 2 · F4) -----------
const OPS_QUEUE_NAME = 'mutation-ops-queue'

async function broadcast(message: unknown): Promise<void> {
  const clients = await self.clients.matchAll({ includeUncontrolled: true })
  for (const client of clients) client.postMessage(message)
}

const opsQueue = new Queue(OPS_QUEUE_NAME, {
  // Drop replays older than a day (a stale mutation is not worth resurrecting).
  maxRetentionTime: 24 * 60, // minutes
  // Fired by the browser's real `sync` event when connectivity returns.
  onSync: async ({ queue }) => {
    await queue.replayRequests()
    await broadcast({ type: 'OPS_QUEUE_REPLAYED', remaining: await queue.size() })
  }
})

// A POST to /rooms/:room/ops that fails (offline) is stored for replay. The
// route is scoped to POST so GET snapshot/health never enter the queue.
registerRoute(
  ({ url, request }) =>
    request.method === 'POST' && /\/rooms\/[^/]+\/ops$/.test(url.pathname),
  new NetworkOnly({
    plugins: [
      {
        fetchDidFail: async ({ request }) => {
          await opsQueue.pushRequest({ request })
        }
      }
    ]
  }),
  'POST'
)

// --- Deterministic control channel (size / replay) --------------------------
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string } | undefined
  if (!data || !data.type) return
  const port = event.ports && event.ports[0]

  if (data.type === 'OPS_QUEUE_SIZE') {
    event.waitUntil(
      opsQueue.size().then((size) => {
        if (port) port.postMessage({ type: 'OPS_QUEUE_SIZE_RESULT', size })
      })
    )
  } else if (data.type === 'REPLAY_OPS_QUEUE') {
    event.waitUntil(
      (async () => {
        const requested = await opsQueue.size()
        try {
          await opsQueue.replayRequests()
        } catch {
          // A still-failing request is re-queued by workbox; report best-effort.
        }
        const remaining = await opsQueue.size()
        if (port) port.postMessage({ type: 'OPS_QUEUE_REPLAYED', requested, remaining })
        await broadcast({ type: 'OPS_QUEUE_REPLAYED', requested, remaining })
      })()
    )
  }
})

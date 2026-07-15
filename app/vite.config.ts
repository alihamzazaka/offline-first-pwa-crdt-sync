import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * PWA / service-worker strategy (documented choice)
 * -------------------------------------------------
 * - Strategy: `injectManifest` with a HAND-WRITTEN SW (src/sw/service-worker.ts).
 *   Phase 2 · F4 added a genuine Background Sync queue for the mutation journal
 *   (`workbox-background-sync`), which needs SW-owned code the generated SW
 *   cannot express (a `Queue` instance + a deterministic replay/inspect message
 *   channel). The custom SW still does everything the generated one did:
 * - Precache: the whole built app shell (js/css/html/svg) so the app *loads*
 *   with zero connectivity. Data does NOT come through the SW — it lives in
 *   IndexedDB (y-indexeddb + the Dexie mutation journal), which is what makes
 *   the app *usable* (not just loadable) offline.
 * - Runtime caching: NetworkFirst for the sync server's REST surface
 *   (`/rooms/:room/snapshot`, `/health`) — fresh when online, last-known-good
 *   when offline. Versioned cache name (`api-v1`) so a strategy change can
 *   invalidate cleanly.
 * - Background Sync: `POST /rooms/:room/ops` is routed NetworkOnly with a
 *   background-sync `Queue`, so an offline mutation POST is stored and replayed
 *   by the browser when connectivity returns — even after the tab closes.
 * - Update flow: `registerType: 'prompt'` — we deliberately do NOT
 *   auto-`skipWaiting`. An offline-first app may hold un-synced local
 *   mutations; yanking the controller out from under a live page mid-session
 *   is how you corrupt in-flight state. Instead the new SW waits, the UI shows
 *   an "update available" toast (src/sw/register.ts), and the user opts in.
 *   `clientsClaim()` is safe and kept (in the SW): once the *user-approved* SW
 *   activates it takes control of all tabs immediately so every tab runs the
 *   same app version (mixed versions across tabs is a real cross-tab hazard).
 * - `cleanupOutdatedCaches()` = versioned-cache hygiene; old precaches are
 *   dropped on activation (SPEC pitfall: "service worker cache staleness").
 *
 * Icons: authored as SVG (public/icons/*.svg) with `purpose: 'any'`.
 * vite-plugin-pwa/Chromium accept SVG manifest icons. If a store or an older
 * UA requires raster icons, export the two SVGs to icon-192.png / icon-512.png
 * (e.g. `npx svgexport`) and swap `type`/`src` below — nothing else changes.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'service-worker.ts',
      includeAssets: ['icons/icon-192.svg', 'icons/icon-512.svg'],
      manifest: {
        name: 'Offline Stock Count',
        short_name: 'StockCount',
        description:
          'Offline-first inventory / stock-count PWA with CRDT sync and correct conflict resolution.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icons/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any'
          },
          {
            src: '/icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any'
          },
          {
            src: '/icons/icon-512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable'
          }
        ]
      },
      // injectManifest: what to precache. Runtime caching + Background Sync now
      // live in the hand-written SW (src/sw/service-worker.ts).
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2}']
      },
      // Dev/E2E note: the SW is intentionally OFF in `vite dev`. The core sync
      // suite proves *sync* correctness deterministically via the in-app
      // OfflineToggle (provider disconnect), which does not depend on the SW.
      // The SW's offline-shell + Background Sync behaviour is exercised on the
      // built+preview app (e2e/specs/background-sync.spec.ts, served on :5174).
      devOptions: { enabled: false }
    })
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})

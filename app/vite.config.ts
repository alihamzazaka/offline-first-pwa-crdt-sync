import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * PWA / service-worker strategy (documented choice)
 * -------------------------------------------------
 * - Precache: the whole built app shell (js/css/html/svg) so the app *loads*
 *   with zero connectivity. Data does NOT come through the SW — it lives in
 *   IndexedDB (y-indexeddb + the Dexie mutation journal), which is what makes
 *   the app *usable* (not just loadable) offline.
 * - Runtime caching: NetworkFirst for the sync server's REST surface
 *   (`/rooms/:room/snapshot`, `/health`) — fresh when online, last-known-good
 *   when offline. Versioned cache name (`api-v1`) so a strategy change can
 *   invalidate cleanly.
 * - Update flow: `registerType: 'prompt'` — we deliberately do NOT
 *   auto-`skipWaiting`. An offline-first app may hold un-synced local
 *   mutations; yanking the controller out from under a live page mid-session
 *   is how you corrupt in-flight state. Instead the new SW waits, the UI shows
 *   an "update available" toast (src/sw/register.ts), and the user opts in.
 *   `clientsClaim: true` is safe and kept: once the *user-approved* SW
 *   activates it takes control of all tabs immediately so every tab runs the
 *   same app version (mixed versions across tabs is a real cross-tab hazard).
 * - `cleanupOutdatedCaches: true` = versioned-cache hygiene; old precaches are
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
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
        runtimeCaching: [
          {
            // Sync server REST surface (cross-origin :4444): fresh when
            // online, cached fallback when offline.
            urlPattern: /^https?:\/\/[^/]+\/(rooms\/[^/]+\/snapshot|health)$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-v1',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 }
            }
          }
        ]
      },
      // Dev/E2E note: the SW is intentionally OFF in `vite dev`. The Playwright
      // suite proves *sync* correctness deterministically via the in-app
      // OfflineToggle (provider disconnect), which does not depend on the SW.
      // The SW's offline-shell behaviour is exercised on the built app
      // (`npm run build && npm run preview`).
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

import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for the offline-first sync correctness suite.
 *
 * webServer array — Playwright boots BOTH backends before the suite and tears
 * them down after, so a reviewer runs one command with nothing pre-started:
 *   1. the hand-rolled Node sync server  (ws + REST on :4444)
 *   2. the Vite dev server for the PWA   (:5173)
 * `cwd: '..'` runs each command from the repo root (this config lives in e2e/).
 * Readiness is gated on a real URL per server (the sync server's /health and
 * the app's root), not a blind sleep.
 *
 * Two chromium projects — the suite runs end-to-end under two independent
 * Desktop-Chrome configurations (`chromium-client-a`, `chromium-client-b`).
 * Each *test* still spins up its own isolated A/B browser contexts internally
 * (see helpers/clients.ts); the two projects prove the whole catalogue is
 * green across parameterised browser configs, and every test derives a UNIQUE
 * room per (project, worker, title) so the two project runs never collide.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The sync backend is shared state; keep worker parallelism modest so a
  // laptop run stays deterministic. Rooms are unique per test regardless.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    video: 'retain-on-failure'
  },

  projects: [
    {
      name: 'chromium-client-a',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'chromium-client-b',
      use: { ...devices['Desktop Chrome'] }
    }
  ],

  webServer: [
    {
      command: 'node server/src/index.mjs',
      cwd: '..',
      url: 'http://127.0.0.1:4444/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // Epoch-rebase spec: make tombstones instantly collectible so an
        // explicit POST /rooms/:room/compact GCs them without waiting out the
        // 7-day production horizon. Auto-compaction stays OFF, so every other
        // spec sees an epoch-0 room and is unaffected.
        SYNC_COMPACT_TOMBSTONE_MS: '0',
        // Lossy-network spec (F2): expose the test-only socket-kill endpoint
        // POST /rooms/:room/kill-conns. Off by default outside this suite.
        SYNC_TEST_ENDPOINTS: '1'
      }
    },
    {
      command: 'npm run dev --workspace=app',
      cwd: '..',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe'
    },
    {
      // Built + previewed app on :5174 — the SW (and Background Sync, F4) is
      // ONLY emitted for production builds (devOptions.enabled=false), so the
      // dev server on :5173 cannot exercise it. background-sync.spec.ts targets
      // this origin explicitly; every other spec keeps using the dev server.
      command:
        'npm run build --workspace=app && npm run preview --workspace=app -- --port 5174 --strictPort',
      cwd: '..',
      url: 'http://127.0.0.1:5174/',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe'
    }
  ]
})

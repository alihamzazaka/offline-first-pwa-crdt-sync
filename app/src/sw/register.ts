/**
 * Service-worker registration + update flow.
 *
 * Uses vite-plugin-pwa's `virtual:pwa-register` (which wraps workbox-window).
 * Strategy (mirrors vite.config.ts): `registerType: 'prompt'` — the new SW
 * installs and WAITS; we surface a small "Update available" toast and only on
 * user consent call `updateSW(true)`, which messages the waiting SW to
 * skipWaiting and reloads. Rationale: an offline-first app may be holding
 * un-synced local mutations mid-session; silently swapping the controller is
 * the classic way to strand or double-apply them. (All data is in IndexedDB,
 * so even the reload is safe — but we still let the user pick the moment.)
 */

import { registerSW } from 'virtual:pwa-register'

export function setupSW(): void {
  // The SW is only emitted for production builds (devOptions.enabled=false);
  // in `vite dev` this is a harmless no-op registration guard.
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      showToast('A new version is available.', 'Update now', () => {
        void updateSW(true)
      })
    },
    onOfflineReady() {
      showToast('App is ready to work offline.', 'OK', dismissToast)
    },
    onRegisterError(err: unknown) {
      console.error('[sw] registration failed', err)
    }
  })
}

// --- tiny dependency-free toast ---------------------------------------------

let toastEl: HTMLDivElement | null = null

function dismissToast(): void {
  toastEl?.remove()
  toastEl = null
}

function showToast(message: string, actionLabel: string, onAction: () => void): void {
  dismissToast()
  toastEl = document.createElement('div')
  toastEl.className = 'sw-toast'
  toastEl.setAttribute('role', 'status')
  toastEl.setAttribute('data-testid', 'sw-toast')

  const text = document.createElement('span')
  text.textContent = message

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = actionLabel
  btn.addEventListener('click', () => {
    onAction()
  })

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'sw-toast-close'
  close.setAttribute('aria-label', 'Dismiss')
  close.textContent = '×'
  close.addEventListener('click', dismissToast)

  toastEl.append(text, btn, close)
  document.body.appendChild(toastEl)
}

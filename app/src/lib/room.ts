/**
 * Room / connection configuration — kept in its own module so that
 * crdt/store.ts and queue/mutationLog.ts can both import it without a cycle.
 *
 * The room name is taken from the `?room=` query param. This is what lets the
 * Playwright suite give every test a fresh, isolated room (fresh Y.Doc on the
 * server, fresh IndexedDB database name on the client) — determinism by
 * construction instead of cleanup code.
 */

const params = new URLSearchParams(window.location.search)

/** Sync room (one Y.Doc per room). */
export const ROOM: string = params.get('room') ?? 'inventory-main'

/** Human label for this client (shown in the header; set by tests: A/B/C). */
export const CLIENT_LABEL: string = params.get('client') ?? 'local'

/** WebSocket endpoint of the sync server. */
export const WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `ws://${window.location.hostname}:4444`

/** HTTP endpoint of the sync server (health + snapshot REST). */
export const SERVER_HTTP_URL: string =
  (import.meta.env.VITE_SERVER_HTTP_URL as string | undefined) ??
  `http://${window.location.hostname}:4444`

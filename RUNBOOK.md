# RUNBOOK — Offline-First PWA + Yjs CRDT Sync

Everything needed to run this project **from scratch on another machine**: bring
up both servers, drive the manual two-window demo, run the automated correctness
suite, and diagnose the usual failures.

No GPU. No database server. Node 18+ and a Chromium that Playwright installs.

---

## 0. Prerequisites

- **Node.js 18 or newer** (`node -v`). Node 20/22/25 are fine.
- **npm 9+** (ships with Node; workspaces are used).
- ~1 GB free disk for `node_modules` + the Chromium Playwright downloads.
- Ports **5173** (Vite app) and **4444** (sync server, ws + REST) free.

This repo is an **npm workspace** with three packages: `app/` (the PWA),
`server/` (the sync relay), `e2e/` (the Playwright suite).

---

## 1. Install (root, once)

```bash
# from the repo root: 06-offline-first-pwa-sync-conflict/
npm install
```

`npm install` at the root installs **all three** workspaces and hoists shared
deps (Yjs, etc.) into the root `node_modules`. Do **not** run install inside the
subfolders.

Then install the Chromium browser Playwright drives (one-time, ~150 MB):

```bash
npx playwright install chromium
```

> On a fresh Linux box you may also need `npx playwright install-deps chromium`
> for the system libraries. Not required on Windows/macOS.

---

## 2. Run both servers (dev)

```bash
# from the repo root
npm run dev
```

This runs `concurrently` and starts **both** servers:

- `[server]` the sync relay → `http://127.0.0.1:4444`
  (WebSocket `ws://127.0.0.1:4444/<room>`, REST `/health` and
  `/rooms/<room>/snapshot`)
- `[app]` the Vite dev server → `http://127.0.0.1:5173`

Expected console (abridged):

```
[server] [sync] listening on http://127.0.0.1:4444
[server] [sync]   preloaded 0 room snapshot(s) on boot
[app]  VITE v5.x  ready in NNN ms
[app]  ➜  Local:   http://127.0.0.1:5173/
```

Sanity-check the sync server independently:

```bash
curl http://127.0.0.1:4444/health
# {"status":"ok","uptimeMs":..,"rooms":[],"roomCount":0,"peers":0}
```

Run just one side if needed: `npm run dev:app` or `npm run dev:server`.

---

## 3. Manual two-window demo (the "whoa" moment)

Use **`127.0.0.1`, not `localhost`** in the URL (the sync server binds
`127.0.0.1`; some systems resolve `localhost` to IPv6 `::1` first).

1. **Window 1 (Client A):** open
   `http://127.0.0.1:5173/?room=demo&client=A`
2. **Window 2 (Client B):** open
   `http://127.0.0.1:5173/?room=demo&client=B`
   (same `room=demo`, different `client`). Put them side by side. Both status
   bars should read **connected · synced**.
3. **In A:** add an item — SKU `A-1`, Name `Widget`, Qty `10`, then **Add item**.
   It appears in **both** windows (live sync).
4. **Go offline in BOTH windows** — click **Go offline** (top-right). Each status
   bar flips to **offline (forced)**. This disconnects each client's sync
   provider deterministically.
5. **Make conflicting edits while offline:**
   - Select the item in **both** windows.
   - **Different fields (no lost writes):** in A change **Name** to `Widget-A`;
     in B change **Location** to `Aisle-7`. Watch the **queue: N** badge climb.
   - **The counter (delta-counter):** in A set the qty delta to `5` and click
     **+**; in B set the qty delta to `3` and click **+**.
6. **Reconnect BOTH** — click **Go online** in each window. Providers reconnect
   and exchange exactly the missing updates.
7. **Watch the merge:** both windows converge to the **same** state —
   Name `Widget-A`, Location `Aisle-7`, and **Qty `18`** (`10 + 5 + 3`, *both*
   adjustments survived — a naive last-write-wins would show 15 or 13). The
   **Merge log** panel logs each concurrent-edit merge; the **queue** drains to 0.
8. **Delete-vs-edit (optional):** offline again, delete the item in A while
   editing its Name in B, reconnect — the item is hidden everywhere (tombstone
   wins visibility) but B's edit is preserved under the tombstone.
9. **Server replica:** confirm the backend converged too:
   `curl http://127.0.0.1:4444/rooms/demo/snapshot`

---

## 4. Run the automated correctness suite

The Playwright config **starts both servers itself** (`webServer`), so you do
**not** need `npm run dev` running first — but if it is already running, the
suite reuses it (`reuseExistingServer` outside CI).

```bash
# from the repo root
npm run test:e2e
```

or from `e2e/`: `npx playwright test`.

The suite runs the whole scenario catalogue under **two chromium projects**
(`chromium-client-a`, `chromium-client-b`), each test spinning up its own
isolated A/B (and C) browser contexts and a unique sync room.

Expected output (abridged, all green):

```
Running 26 tests using 2 workers

  ✓ same-field-concurrent-edit.spec.ts:… same-field concurrent edit converges to one defined value
  ✓ different-field.spec.ts:…            different-field concurrent edits both survive
  ✓ offline-create-idempotent.spec.ts:…  offline creates replay idempotently — exactly N records, no dupes
  ✓ delete-vs-edit.spec.ts:…             delete-vs-edit resolves to a tombstone with the edit preserved
  ✓ long-offline-queue.spec.ts:…         long offline queue of 50 ops replays correctly and in order
  ✓ three-way.spec.ts:…                  three clients + server converge to one identical state
  ✓ qty-concurrent-adjust.spec.ts:…      concurrent offline qty adjustments add up (+5 and +3 -> +8)
  ✓ cross-tab.spec.ts:…                  two tabs of one browser converge via shared IndexedDB (offline)
  ✓ epoch-rebase.spec.ts:…               real modules: sealEpoch collapses + GCs, adoptServerEpoch replays…
  ✓ epoch-rebase.spec.ts:…               S8: offline edits across a compaction seal — clients rebase…
  ✓ lossy-network.spec.ts:…              NET1: real network offline during edits on both clients, then heal…
  ✓ lossy-network.spec.ts:…              NET2: repeated abortive socket kills during rapid concurrent edits…
  ✓ lossy-network.spec.ts:…              NET3: high-latency network (CDP emulation) + a mid-burst socket kill…

  26 passed (…s)
```

> 13 tests (11 spec files) × 2 chromium projects = **26 test runs**. Each maps
> to a scenario in [docs/04-data-and-datasets.md](docs/04-data-and-datasets.md)
> (S1–S8) or the Phase-2 adversarial NET catalogue (§4e) and asserts
> **convergence across all replicas (clients + server)** plus its guarantee.

Useful variants:

```bash
npx playwright test same-field           # one spec by name
npx playwright test --project=chromium-client-a
npx playwright test --headed             # watch the browsers
npx playwright test --debug              # step through
npx playwright show-report               # open the HTML report after a run
```

---

## 4b. Property-based fuzzers (no browser needed)

```bash
npm run test:fuzz          # both fuzzers: 1500 convergence + 800 seal/rebase histories
npm run test:fuzz:epoch    # just the epoch-compaction fuzzer
```

## 4c. Epoch compaction (Phase 2 · v2.0)

The server can seal a room into a new **epoch** — collapsing each item's
qty-delta array to a single base entry and garbage-collecting tombstones past a
horizon — while a client that was offline across the seal automatically
**rebases** on reconnect (adopts the base, replays only its pending journal
ops, drops ops on collected items; the UI reloads once).

```bash
# on-demand seal (refused with peers connected unless force=1):
curl -X POST http://127.0.0.1:4444/rooms/<room>/compact
curl -X POST "http://127.0.0.1:4444/rooms/<room>/compact?force=1"

# room epoch is visible in the REST snapshot:
curl http://127.0.0.1:4444/rooms/<room>/snapshot   # -> { epoch, items, ... }
```

Env vars (server):

| Var | Default | Meaning |
|---|---|---|
| `SYNC_AUTO_COMPACT` | off | `1` = auto-seal an idle room when there is enough to shed |
| `SYNC_COMPACT_TOMBSTONE_MS` | 7 days | tombstones older than this are GC'd on seal |
| `SYNC_COMPACT_MIN_PRESSURE` | 64 | min shedable entries before an idle auto-seal fires |

Proof: `fuzz/epoch-compaction.fuzz.mjs` (800 histories) +
`e2e/specs/epoch-rebase.spec.ts` (real modules + full-stack S8).

## 4d. Pluggable snapshot persistence (Phase 2 · v2.0 · F3)

Room snapshots are written through a **StorageAdapter**
(`server/src/storage.mjs`). The default is the v1.0 file backend — nothing to
configure, byte-identical behaviour (`server/data/<room>.yss`, atomic
temp+rename, prune/load on boot). Setting `SYNC_STORAGE=postgres` upserts the
same `encodeStateAsUpdate` blob into a `yss_snapshots` table instead:

```bash
# default — file snapshots, exactly as v1.0:
npm run dev:server

# Postgres-backed snapshots (table is created on boot if missing):
SYNC_STORAGE=postgres SYNC_PG_URL=postgres://user:pass@127.0.0.1:5432/inventory npm run dev:server

# adapter unit tests (FileAdapter vs a temp dir; PostgresAdapter vs a fake client):
npm run test:storage
```

Env vars (server persistence):

| Var | Default | Meaning |
|---|---|---|
| `SYNC_STORAGE` | `file` | snapshot backend: `file` \| `postgres` |
| `SYNC_PG_URL` | — | Postgres connection string (required when `SYNC_STORAGE=postgres`) |
| `SYNC_DATA_DIR` | `server/data` | snapshot directory for the `file` backend |
| `SYNC_PERSIST_MS` | `750` | debounce window — a burst of edits costs one snapshot write |
| `SNAPSHOT_MAX_AGE_DAYS` | `30` | snapshots untouched for longer are pruned on boot |
| `SYNC_PG_TEST_URL` | — | test-only: enables the live-Postgres integration test in `server/test/storage.test.mjs` (skipped otherwise) |

> Honest status: the Postgres adapter's SQL/upsert contract is unit-tested
> against a fake query client; it has not been exercised against a live
> Postgres on this machine (none reachable). Point `SYNC_PG_TEST_URL` at a real
> DB to run the skipped integration test.

## 4e. Adversarial lossy-network spec (Phase 2 · v2.0 · F2)

Every other spec toggles connectivity deterministically through the in-app
`OfflineToggle` (`provider.disconnect()`).
[`e2e/specs/lossy-network.spec.ts`](e2e/specs/lossy-network.spec.ts) is the
hostile counterpart — the network itself misbehaves, and the SAME all-replica
convergence assertion must still hold:

- **NET1 — real offline.** `context.setOffline(true)` on both clients plus a
  server-side socket kill, concurrent edits, heal → convergence, zero lost
  writes. The spec asserts *server-side* that no write leaked through the
  partition before healing.
- **NET2 — socket kills mid-sync.** 24 rapid concurrent edits per client while
  every ws connection of the room is abortively `terminate()`d six times;
  the y-websocket reconnect + Yjs state-vector handshake must recover exactly
  the missing updates (last name edit wins, all 24 qty increments survive).
- **NET3 — high latency.** CDP `Network.emulateNetworkConditions` (500 ms RTT)
  with a mid-burst kill so the reconnect handshake runs under the emulated
  conditions, converging while still throttled.

```bash
npx playwright test lossy-network                    # 3 tests × 2 projects = 6 runs
npx playwright test lossy-network --repeat-each=5    # flake budget: expect 30/30
```

The socket kill uses a **test-only** endpoint the Playwright config enables via
`SYNC_TEST_ENDPOINTS=1` — it is OFF by default so a deployed relay never
exposes a remote kill switch:

```bash
# only with SYNC_TEST_ENDPOINTS=1 on the server:
curl -X POST http://127.0.0.1:4444/rooms/<room>/kill-conns   # -> { killed: N }
```

Honest scoping (documented in the spec header): Chromium's network emulation
does not reliably sever or throttle an **already-established** WebSocket —
that is exactly why NET1 pairs `setOffline` with the kill endpoint (emulation
then blocks every reconnect until heal) and NET3 kills mid-burst so the
handshake actually runs under the emulated latency.

## 5. Production build / offline-shell check (optional)

The service worker is intentionally **off in `vite dev`** (the suite proves sync
via the in-app toggle, which does not need the SW). To exercise the installable,
offline-loading PWA shell:

```bash
npm run build --workspace=app      # tsc --noEmit + vite build
npm run preview --workspace=app    # serves the built app on http://127.0.0.1:5173
```

Then in the browser: load once online, toggle DevTools → Network → **Offline**,
reload — the shell still loads (precached), and all data is served from
IndexedDB.

---

## 6. Troubleshooting

**Port already in use (`EADDRINUSE`).**
Something is on 5173 or 4444. Find and stop it, or override the sync port.
```bash
# Windows (PowerShell): find the PID on a port
netstat -ano | findstr :4444
taskkill /PID <pid> /F
# macOS/Linux:
lsof -i :4444    # then kill <pid>
```
Override the sync server port/host if you must (the app derives the ws URL from
the page host on port 4444, so if you change the port also set the app's
`VITE_WS_URL` / `VITE_SERVER_HTTP_URL`):
```bash
SYNC_PORT=4555 npm run dev:server
# and run the app with:
VITE_WS_URL=ws://127.0.0.1:4555 VITE_SERVER_HTTP_URL=http://127.0.0.1:4555 npm run dev:app
```

**Status bar stuck on `connecting` / never `synced`.**
The sync server isn't reachable. Confirm `curl http://127.0.0.1:4444/health`
responds. Check you opened the app via **`127.0.0.1`** (not `localhost`) so the
ws URL host matches the server bind. Corporate proxies/VPNs sometimes break
`ws://` on localhost — disable for the demo.

**WebSocket connects then immediately drops.**
Usually a stale server holding the port, or two servers both bound to 4444. Stop
all node processes and re-run `npm run dev`. The client auto-reconnects with
backoff, so a brief blip self-heals.

**Playwright: "Timed out waiting for http://127.0.0.1:5173".**
Vite didn't come up within the `webServer` timeout — run `npm run dev:app`
manually to see the real error (usually a missing `npm install`). If a previous
run left servers up, either let `reuseExistingServer` use them or stop them.

**Playwright: "browserType.launch: Executable doesn't exist".**
You skipped step 1's browser install. Run `npx playwright install chromium`.

**Tests flake on a very slow machine.**
Increase parallelism headroom: `npx playwright test --workers=1`. Rooms are
unique per test, so serial execution is always safe.

**Reset all sync state.**
Stop the servers and delete the snapshot directory:
```bash
rm -rf server/data           # macOS/Linux
Remove-Item -Recurse -Force server/data   # PowerShell
```
Per-client state lives in the browser's IndexedDB (`inv-<room>` /
`inv-journal-<room>`); clear site data for `127.0.0.1:5173` to wipe a client.

---

## 7. Command quick-reference

| Goal | Command (repo root) |
|---|---|
| Install everything | `npm install` |
| Install the test browser | `npx playwright install chromium` |
| Run both servers | `npm run dev` |
| Run only the app | `npm run dev:app` |
| Run only the sync server | `npm run dev:server` |
| Run the correctness suite | `npm run test:e2e` |
| Health check | `curl http://127.0.0.1:4444/health` |
| Server's view of a room | `curl http://127.0.0.1:4444/rooms/<room>/snapshot` |
| Production build | `npm run build --workspace=app` |
| Preview built PWA | `npm run preview --workspace=app` |

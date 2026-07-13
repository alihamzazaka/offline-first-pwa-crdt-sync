# 06 — Environment Setup (v2.0)

> The new dependencies, services, environment variables, and setup steps v2.0
> adds **on top of** the Phase 1 environment. It assumes the v1.0 environment
> (Node 18+, the npm workspace, Playwright's Chromium) is already working per
> [../06-environment-setup.md](../06-environment-setup.md) and
> [../../RUNBOOK.md](../../RUNBOOK.md). **No GPU. Nothing here is required to run
> v1.0 — the `file` storage default and the two clean Playwright projects keep
> working untouched.**

---

## 1. What v2.0 adds to the stack

| Layer | v1.0 (already installed) | v2.0 adds |
|---|---|---|
| Compaction (F1) | Yjs `encodeStateVector`/`encodeStateAsUpdate` | *nothing* — pure Yjs + Node |
| Adversarial tests (F2) | `@playwright/test ^1.49.1` | *nothing* — uses `routeWebSocket` + CDP already in Playwright ≥1.48 |
| Persistence (F3) | file snapshots (`fs`) | `pg` **or** `mysql2` in the `server` workspace; a Postgres/MySQL server (Docker) |
| Background sync (F4) | Workbox via `vite-plugin-pwa ^0.21.1` | `workbox-background-sync` |
| CI | none | GitHub Actions workflow (+ DB service container for F3) |

The two features that carry the deepest engineering (F1, F2) need **zero new
dependencies** — they are pure protocol/test work on the existing stack.

---

## 2. Prerequisites (delta over v1.0)

- Everything in [../06-environment-setup.md §3](../06-environment-setup.md) —
  Node 18+, npm, Git, a Chromium Playwright installs.
- **For F3 only:** Docker (or a local Postgres/MySQL), to host the SQL store.
- **For CI:** a GitHub repository with Actions enabled.

Verify the additions:

```bash
docker --version        # for the F3 database container (F3 only)
node -e "require('pg')"        2>/dev/null && echo "pg present"      # after install
node -e "require('mysql2')"    2>/dev/null && echo "mysql2 present"  # after install
```

---

## 3. Install steps (delta)

All commands run from the repo root (`06-offline-first-pwa-sync-conflict/`), which
is an npm workspace — deps install into the right workspace via `--workspace`.

### 3.1 F1 — Epoch compaction (no install)

Nothing to install. New source files only:
`server/src/compaction.mjs`, `server/src/storage/…` (shared with F3),
`e2e/specs/epoch-rebase.spec.ts`, and the fuzzer compaction step.

### 3.2 F2 — Adversarial tests (no install)

`routeWebSocket` and CDP `Network.emulateNetworkConditions` are already in
`@playwright/test ^1.49.1`. Only config + specs change:
new `chromium-adversarial` project in `e2e/playwright.config.ts`, and the
`net-offline` / `throttled-reconnect` / `socket-drop-midsync` specs.

### 3.3 F3 — SQL persistence drivers

```bash
# Postgres driver:
npm install pg --workspace=server
# and/or MySQL driver:
npm install mysql2 --workspace=server
```

Bring up a local database with Docker (pick one):

```bash
# Postgres
docker run --name pwa-pg -e POSTGRES_PASSWORD=pwa -e POSTGRES_DB=offline_pwa \
  -p 5432:5432 -d postgres:16

# MySQL
docker run --name pwa-mysql -e MYSQL_ROOT_PASSWORD=pwa -e MYSQL_DATABASE=offline_pwa \
  -p 3306:3306 -d mysql:8
```

Create the snapshot table (schema in
[04-data-and-resources.md §3](04-data-and-resources.md#3-new-datastores--their-schemas-f3);
the adapter also creates it on first boot if absent).

### 3.4 F4 — Background Sync module

```bash
npm install workbox-background-sync --workspace=app
```

Workbox itself is already pulled in by `vite-plugin-pwa`; this adds the
`BackgroundSyncPlugin` used in `app/vite.config.ts`.

---

## 4. New environment variables

All new vars have **safe defaults that reproduce v1.0 behaviour**, so an
unconfigured checkout runs exactly as before.

```bash
# --- F1: epoch compaction (server) ------------------------------------------
SYNC_EPOCH_MAX_DELTAS=5000     # compact a room once total qty deltas exceed this
SYNC_EPOCH_TOMBSTONE_DAYS=30   # sweep tombstones older than N days (defaults to SNAPSHOT_MAX_AGE_DAYS)
SYNC_EPOCH_QUIESCE_MS=60000    # a room with no live peer for this long may compact freely

# --- F3: pluggable persistence (server) -------------------------------------
SYNC_STORAGE=file              # file | postgres | mysql  (default: file — v1.0 behaviour)
DATABASE_URL=                  # required when SYNC_STORAGE=postgres|mysql
# e.g. postgres://postgres:pwa@127.0.0.1:5432/offline_pwa
# e.g. mysql://root:pwa@127.0.0.1:3306/offline_pwa

# --- F4: background sync (app, build-time) ----------------------------------
VITE_ENABLE_BG_SYNC=true       # gate the BackgroundSyncPlugin route (progressive enhancement)

# --- carried over from v1.0 (unchanged) -------------------------------------
SYNC_HOST=127.0.0.1
SYNC_PORT=4444
SYNC_DATA_DIR=./server/data
SYNC_PERSIST_MS=750
SNAPSHOT_MAX_AGE_DAYS=30
# app ws/http overrides (v1.0): VITE_WS_URL, VITE_SERVER_HTTP_URL
```

---

## 5. Running v2.0 locally

### 5.1 Default (file storage — identical to v1.0)

```bash
npm install
npx playwright install chromium
npm run dev            # server :4444 + app :5173, file snapshots — unchanged
```

### 5.2 With Postgres storage (F3)

```bash
docker start pwa-pg    # or the run command in §3.3
SYNC_STORAGE=postgres DATABASE_URL=postgres://postgres:pwa@127.0.0.1:5432/offline_pwa \
  npm run dev:server
npm run dev:app        # in another shell
```

Sanity check the store is being used:

```bash
curl http://127.0.0.1:4444/health   # rooms census as usual
# after some edits, confirm the row exists:
docker exec -it pwa-pg psql -U postgres -d offline_pwa -c \
  "select room, epoch, octet_length(snapshot) as bytes, updated_at from room_snapshots;"
```

### 5.3 Adversarial suite (F2)

```bash
# run only the hostile project (real offline + throttle + socket-kill):
npx playwright test --project=chromium-adversarial
# with the flake budget CI uses:
npx playwright test --project=chromium-adversarial --repeat-each=5
```

### 5.4 Fuzzer with the compaction step (F1)

```bash
npm run test:fuzz      # now includes a random compaction point + no-resurrection invariant
```

---

## 6. CI setup (GitHub Actions)

A new `.github/workflows/ci.yml` runs the whole suite on push. Sketch:

```yaml
name: ci
on: [push, pull_request]
jobs:
  fuzz-and-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:fuzz
      - run: npm run test:e2e        # a/b + chromium-adversarial

  e2e-postgres:                       # F3 adapter parity + durable restart
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: pwa, POSTGRES_DB: offline_pwa }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s
          --health-timeout 5s --health-retries 5
    env:
      SYNC_STORAGE: postgres
      DATABASE_URL: postgres://postgres:pwa@127.0.0.1:5432/offline_pwa
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: node --test server/test/adapter-parity.test.mjs
```

This makes v1.0's implicit "green locally" into v2.0's explicit "green on push"
(closing the no-CI gap).

---

## 7. Verify your v2.0 install (smoke check)

1. **v1.0 still green with defaults** — `npm run test:e2e` → 16/16 (the
   regression floor; F3 file adapter and the new projects must not break it).
2. **Fuzzer + compaction** — `npm run test:fuzz` passes with the compaction step
   enabled.
3. **Adversarial project loads** — `npx playwright test --project=chromium-adversarial --list`
   shows the NET specs.
4. **SQL adapter round-trips** — with `SYNC_STORAGE=postgres`, edit a room,
   restart the server, confirm the room reloads (F3 durable restart).
5. **Background Sync route present** — build the app
   (`npm run build --workspace=app`) and confirm the generated `sw.js` references
   the `inv-mutations` queue (F4, when `VITE_ENABLE_BG_SYNC=true`).
6. **CI green** — push and watch both jobs pass.

If all six pass, the environment is ready for the milestones in
[07-build-roadmap.md](07-build-roadmap.md).

---

## 8. Deployment notes (delta)

- **Frontend / relay:** unchanged from
  [../06-environment-setup.md §7](../06-environment-setup.md) — static shell on
  Vercel/Netlify, small Node relay on any host.
- **Database (F3):** a managed Postgres/MySQL (or a small self-hosted instance);
  set `SYNC_STORAGE` + `DATABASE_URL` on the relay. The `file` default remains
  valid for single-instance deploys.
- **Background Sync (F4):** no server infra beyond the new `POST /rooms/:room/ops`
  endpoint; the queue lives in the browser's service worker.

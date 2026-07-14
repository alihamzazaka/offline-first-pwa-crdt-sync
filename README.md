# Project 06 — Offline-First PWA with Sync + Conflict Resolution

> A web app that keeps working with zero connectivity, queues every change locally, and — on reconnect — merges concurrent edits correctly instead of silently overwriting someone's work. Real bidirectional sync, not a cached shell.

---

## Honest positioning (read this first)

"Offline support" is common in portfolios — but almost all of it is a service worker
caching the app **shell** so the page merely *loads* offline. That is not sync. The
moment two clients (or two browser tabs) edit the same record while disconnected, naive
**last-write-wins silently destroys data**.

The gap this project fills is the hard part everyone skips: **correct conflict
resolution**. Demonstrating **CRDT-based (or a well-designed OT / vector-clock) merge
with an offline mutation queue, Background Sync, and a visible, provable
conflict-resolution story** is genuinely senior distributed-systems work wearing a
web-app costume. The credible claim is a **measured, reproducible correctness win** on a
named axis — not "first offline PWA ever."

---

## Headline goal (metric + constraint)

> **After any interleaving of offline edits and reconnects across two or more clients,
> every client and the server converge to byte-identical state with zero lost writes and
> zero duplicate records — proven by an automated Playwright multi-context test suite
> that anyone can run.**

- **Metric:** convergence (all replicas reach identical state) + no lost writes + no
  duplicates + defined same-field conflict behavior.
- **Constraint:** proven reproducibly in CI via Playwright with real offline toggling —
  not a hand-waved demo. No GPU required.

---

## Conflict model (state this explicitly in the build)

Per the SPEC, the conflict model is a deliberate, documented choice:

| Model | What it gives you | When to use |
|---|---|---|
| **CRDT** (Yjs / Automerge) | Automatic, mathematically-guaranteed convergence | Collaborative text / structured data — easiest path to a *correct* result |
| **OT** (Operational Transform) | Powers Google Docs | Powerful but complex to implement correctly |
| **App-level merge / LWW + vector clocks** | Simplest; explicit conflict handling | Forms / records — surface conflicts or field-level merge |

---

## Documentation

| Doc | What's inside |
|---|---|
| [SPEC.md](SPEC.md) | The authoritative build spec — everything here is grounded in it |
| [docs/01-overview.md](docs/01-overview.md) | Problem → solution, honest positioning vs SOTA, why it's rare, success criteria |
| [docs/02-architecture.md](docs/02-architecture.md) | System architecture, Mermaid diagrams, component walkthrough, key design decisions |
| [docs/03-requirements.md](docs/03-requirements.md) | Functional + non-functional requirements, in/out of scope, deliverables checklist |
| [docs/04-data-and-datasets.md](docs/04-data-and-datasets.md) | The test-scenario catalogue (concurrent-edit cases) — "datasets" here = tests |
| [docs/05-evaluation-metrics.md](docs/05-evaluation-metrics.md) | Metric definitions, the money table, eval harness, how the win is proven |
| [docs/06-environment-setup.md](docs/06-environment-setup.md) | Tech stack, prerequisites, install commands, hardware fit, smoke check |
| [docs/07-build-roadmap.md](docs/07-build-roadmap.md) | Phased build plan (Phase 0–4), milestones, code skeletons |
| [docs/08-risks-pitfalls.md](docs/08-risks-pitfalls.md) | Every pitfall expanded (risk / why / mitigation) + risk register |
| [docs/09-references.md](docs/09-references.md) | Papers, libraries, tools, MDN specs — grouped |
| [docs/10-glossary.md](docs/10-glossary.md) | Every domain term defined in one clear sentence |

---

## Phase 2 / v2.0 (planned)

The next-phase suite targets the four most senior distributed-systems
capabilities left in the repo. **(1) Server-side epoch compaction / GC is now
built and wired end-to-end** ✅ — `server/src/compaction.mjs` seals a new epoch
at a safe checkpoint (an idle room), collapsing every ever-growing qty-delta
array to a single base delta and garbage-collecting tombstones past a horizon.
A pre-horizon client is forced to **rebase, not resurrect**, and the whole wire
protocol ships: the client declares its adopted epoch as a ws query param, the
server's **stale-writer guard** serves state to — but discards writes from —
pre-epoch connections (`server/src/index.mjs`), and on detecting the epoch
advance the client discards its pre-seal doc and replays **only** its pending
journal ops onto the adopted base, dropping any that target a collected item
(`app/src/crdt/rebase.ts` + the epoch state machine in `app/src/crdt/store.ts`).
Proven three ways: **800 random seal/rebase histories** in
[`fuzz/epoch-compaction.fuzz.mjs`](fuzz/epoch-compaction.fuzz.mjs)
(bounded-growth · value-preserving · no-resurrect · no-double-count ·
convergence), the **real shipped modules** executed in
[`e2e/specs/epoch-rebase.spec.ts`](e2e/specs/epoch-rebase.spec.ts), and a
**full-stack browser scenario (S8)** in the same spec — two live clients, a real
`POST /rooms/:room/compact` seal while offline, reconnect, automatic rebase
(clear + reload + pending replay), and convergence with the collected item gone
and the pending edit preserved. Idle auto-compaction is opt-in
(`SYNC_AUTO_COMPACT=1`). Known scoped limitation: simultaneous multi-tab rebase
has a narrow re-persistence window (documented in `store.ts`). A GitHub Actions
**CI workflow** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) is now
written — `npm ci` → Playwright chromium → `test:fuzz` → `test:e2e`, report
uploaded on failure — but has **not yet run remotely** (pending first push).
**(3) Pluggable snapshot persistence is now built** ✅ — the relay's debounced
snapshot writes go through a **`StorageAdapter`**
([`server/src/storage.mjs`](server/src/storage.mjs)): `SYNC_STORAGE=file`
(default — the exact v1.0 `data/<room>.yss` atomic temp+rename behaviour,
extracted verbatim) or `SYNC_STORAGE=postgres` (`yss_snapshots` upsert table
via `SYNC_PG_URL`, `pg` driver with an injectable query client). Same
`encodeStateAsUpdate` blob either way; debounce, flush-on-shutdown,
prune-on-boot, and load-on-boot are preserved, and the full e2e suite boots the
server through the adapter path. Honest caveat: the Postgres adapter is proven
by unit tests against a fake query client
([`server/test/storage.test.mjs`](server/test/storage.test.mjs), 19 passing —
SQL/param/upsert contract) — it has **not** been run against a live Postgres
here (no reachable DB on the build machine; a skipped integration test enables
with `SYNC_PG_TEST_URL`).
**(2) Adversarial lossy-network testing is now built** ✅ —
[`e2e/specs/lossy-network.spec.ts`](e2e/specs/lossy-network.spec.ts) (NET1–NET3)
re-proves the same all-replica convergence guarantee while the network itself
misbehaves, instead of the clean `provider.disconnect()` toggle the rest of the
suite uses: **NET1** real browser-level offline (`context.setOffline`) across
concurrent edits on both clients — with a server-side assertion that **no write
leaked through the partition** — then heal, converge, zero lost writes; **NET2**
repeated **abortive socket kills mid-sync** — a test-only
`POST /rooms/:room/kill-conns` endpoint (guarded behind `SYNC_TEST_ENDPOINTS=1`,
`server/src/index.mjs`) `terminate()`s every ws connection of the room six times
during 24 rapid concurrent edits per client, and the y-websocket reconnect +
Yjs state-vector handshake must recover exactly the missing updates; **NET3**
CDP-emulated 500 ms-latency network conditions with a mid-burst kill.
**6/6 green, 0 flakes across `--repeat-each=5` (30/30)**. Honest scoping:
Chromium's network emulation does not reliably sever or throttle an
already-open WebSocket, so NET1 pairs `setOffline` with the socket kill (the
emulation then blocks every reconnect until heal) and NET3 kills mid-burst so
the reconnect handshake actually runs under the emulated latency; the socket
kill is a server-side abortive TCP drop, not Playwright `routeWebSocket`.
Still **planned**: (4) **real Background Sync** (Workbox).
See [docs/phase-2/README.md](docs/phase-2/README.md).

---

## Tech stack (compact)

**Next.js / React (PWA)** · **IndexedDB via Dexie.js** · **Yjs / Automerge (CRDT)** ·
**Workbox + Background Sync API** · **WebSocket (y-websocket) / HTTP sync** ·
**Node backend** · **MySQL / Postgres** · **Playwright (multi-context offline tests)**.
No GPU.

---

## Good demo domains

Field-worker inspection forms · a collaborative notes/kanban app · an offline-capable
POS/inventory tool (ties to Candela POS / Shopify client work) · a survey-collection app
for low-connectivity areas (regionally relevant).

---

## Deliverables (the proof)

1. **Live installable PWA demo** — open two windows, go offline, make conflicting edits, reconnect, watch the correct merge.
2. **Demo video** of the concurrent-edit merge (the "whoa" moment).
3. **Repo with the Playwright correctness suite** anyone can run — this is the proof.
4. **README / blog**: chosen conflict model, why, architecture diagram, guarantees, and the naive-LWW failure mode avoided.
5. Optional: a write-up comparing **Yjs vs Automerge** (or CRDT vs OT) for the use case.

---

## Conflict model chosen (Phase 0 — decided)

**Yjs CRDT**, hand-rolled sync over WebSocket, demo domain = **offline
stock-count / inventory**. Rationale: CRDT is the easiest path to a *provably
correct* automatic merge, and inventory has the one shape that breaks naive CRDT
modelling — a **counter** — which we solve with a **delta-counter (PN-counter on
a `Y.Array`)** so concurrent offline stock adjustments **add up** instead of
overwriting. Same-field scalar edits converge by Yjs's deterministic client
ordering; different-field edits merge for free (per-key `Y.Map`); deletes are
**tombstones** (delete wins visibility, edits preserved under it). Full rationale
and the as-built decisions are in
[docs/02-architecture.md §7 "As built"](docs/02-architecture.md#7-as-built).

## Status

**Built and proven.** Local-first PWA (React + Vite + Yjs + `y-indexeddb` +
Workbox), a hand-rolled `y-websocket` sync server with debounced file-snapshot
persistence, and a **green Playwright correctness suite** covering every scenario
in the catalogue — each asserting convergence across **all replicas (both
clients and the server)** plus its specific guarantee (no lost writes / no
duplicates / tombstone / ordered replay / cross-tab).

- **Run it:** see [RUNBOOK.md](RUNBOOK.md) — `npm install`,
  `npx playwright install chromium`, `npm run dev`, `npm run test:e2e`.
- **The proof (examples):** `e2e/specs/` (11 specs → scenarios S1–S8 including
  the delta-counter money shot and the epoch-rebase full-stack scenario, plus
  the NET1–NET3 adversarial lossy-network scenarios — real offline, abortive
  socket kills mid-sync, CDP latency), run under two chromium projects —
  **26/26 green**.
- **The proof (property-based):** `fuzz/crdt-convergence.fuzz.mjs` — a
  Jepsen-style fuzzer that generates **1500 random operation histories** (random
  adjust/update/delete interleaved with random partition/heal points across 3
  replicas) and asserts the three invariants on every one: **convergence**,
  **qty = sum of applied deltas** (anti-LWW), and **tombstone** — plus
  `fuzz/epoch-compaction.fuzz.mjs`, **800 random seal/rebase histories** for the
  Phase-2 compaction protocol (bounded-growth · value-preserving · no-resurrect
  · no-double-count · convergence). Run `npm run test:fuzz`.
  The convergence fuzzer also surfaced a genuine model property (documented in
  the file header): *concurrent creates of the **same** id would discard one
  container's deltas — the app avoids this by minting a fresh ULID per create,
  so ids never collide.*
- **Demo:** [demo/script.md](demo/script.md) — the 60-second concurrent-merge clip.

## Repository layout

```
06-offline-first-pwa-sync-conflict/
├── package.json              # npm workspace root (app · server · e2e); dev + test:e2e + test:fuzz scripts
├── README.md                 # this file
├── RUNBOOK.md                # run/demo/test/troubleshoot on another machine
├── SPEC.md                   # authoritative build spec
├── demo/
│   └── script.md             # 60-second demo video shot list
├── docs/                     # 01–10: overview, architecture (§7 "As built"), scenarios, metrics…
├── app/                      # the PWA (React + Vite + Yjs)
│   ├── vite.config.ts        # PWA / Workbox / service-worker strategy
│   ├── index.html
│   └── src/
│       ├── main.tsx          # entry: mounts App, wires the store, registers the SW
│       ├── crdt/
│       │   ├── store.ts      # the single Y.Doc: persistence, transports, snapshots, epoch state machine, window.__inv
│       │   ├── ops.ts        # typed CRDT ops (create/update/adjustQty/delete/editNotes) + replayJournal
│       │   └── rebase.ts     # epoch rebase: adopt server base + replay pending, drop-not-resurrect (v2.0)
│       ├── queue/
│       │   └── mutationLog.ts# Dexie journal: visible offline queue + idempotent-replay evidence
│       ├── lib/              # ulid.ts (stable op IDs) · room.ts (room/ws config)
│       ├── sw/register.ts    # service-worker registration + update-prompt flow
│       └── ui/               # App, ItemList, ItemEditor, SyncStatusBar, ConflictLog, OfflineToggle
├── server/                   # the sync backend
│   ├── package.json          # yjs · y-websocket · ws · y-protocols · lib0 (pure JS, no native deps)
│   └── src/
│       ├── index.mjs         # hand-rolled setupWSConnection · stale-writer guard · snapshots · /health · REST · /compact · test-only /kill-conns
│       └── compaction.mjs    # epoch seal: collapse qty deltas + GC aged tombstones (v2.0)
├── e2e/                      # the reproducible proof (example-based)
│   ├── package.json          # @playwright/test
│   ├── playwright.config.ts  # webServer array (sync server + vite) · two chromium projects
│   ├── helpers/clients.ts    # isolated A/B contexts, offline toggle, CRUD, convergence assertions
│   └── specs/                # one spec per scenario (S1–S8 + qty delta-counter + epoch-rebase + NET1–NET3 lossy-network)
└── fuzz/                     # the reproducible proof (property-based)
    ├── crdt-convergence.fuzz.mjs  # 1500 random histories · convergence + qty-sum + tombstone
    └── epoch-compaction.fuzz.mjs  # 800 random seal/rebase histories · bounded + no-resurrect (v2.0)
```

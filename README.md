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
- **The proof:** `e2e/specs/` (8 specs → the 7 scenarios S1–S7 plus the
  delta-counter money shot), run under two chromium projects.
- **Demo:** [demo/script.md](demo/script.md) — the 60-second concurrent-merge clip.

## Repository layout

```
06-offline-first-pwa-sync-conflict/
├── package.json              # npm workspace root (app · server · e2e); dev + test:e2e scripts
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
│       │   ├── store.ts      # the single Y.Doc: persistence, transports, snapshots, window.__inv
│       │   └── ops.ts        # typed CRDT ops (create/update/adjustQty/delete/editNotes) + replayJournal
│       ├── queue/
│       │   └── mutationLog.ts# Dexie journal: visible offline queue + idempotent-replay evidence
│       ├── lib/              # ulid.ts (stable op IDs) · room.ts (room/ws config)
│       ├── sw/register.ts    # service-worker registration + update-prompt flow
│       └── ui/               # App, ItemList, ItemEditor, SyncStatusBar, ConflictLog, OfflineToggle
├── server/                   # the sync backend
│   ├── package.json          # yjs · y-websocket · ws · y-protocols · lib0 (pure JS, no native deps)
│   └── src/index.mjs         # hand-rolled setupWSConnection · data/<room>.yss snapshots · /health · REST
└── e2e/                      # the reproducible proof
    ├── package.json          # @playwright/test
    ├── playwright.config.ts  # webServer array (sync server + vite) · two chromium projects
    ├── helpers/clients.ts    # isolated A/B contexts, offline toggle, CRUD, convergence assertions
    └── specs/                # one spec per scenario (S1–S7 + qty delta-counter)
```

# Phase 2 / v2.0 — Documentation Suite

> The next phase of Project 06. v1.0 shipped a **provably correct** offline-first
> inventory PWA (Yjs CRDT + hand-rolled `y-websocket` relay) with a green
> Playwright suite and a 1500-history property fuzzer. v2.0 takes the three
> honest gaps v1.0 called out — **unbounded CRDT growth**, **clean-disconnect-only
> testing**, and **single-process file persistence** — plus the one deliverable
> v1.0 re-scoped (**real Background Sync**) and turns them into the four
> most senior distributed-systems capabilities left in the repo.

---

## ⚠️ Status banner — F1 built; F2–F4 planned

**F1 (epoch compaction + rebase) is now IMPLEMENTED and wired end-to-end**:
`server/src/compaction.mjs` (seal: collapse qty deltas, GC aged tombstones),
the server stale-writer guard + `POST /rooms/:room/compact` (`server/src/index.mjs`),
the client epoch state machine + pending-op rebase (`app/src/crdt/store.ts`,
`app/src/crdt/rebase.ts`) — proven by an 800-history fuzzer
(`fuzz/epoch-compaction.fuzz.mjs`) and a full-stack browser scenario
(`e2e/specs/epoch-rebase.spec.ts`, S8; suite 20/20 green). **F2–F4 remain a
PLAN.** This suite is written to the same standard as
the Phase 1 docs — it distinguishes *built* from *planned*, quotes the real,
measured v1.0 baseline, and states concrete target numbers — but the targets are
**targets**, not results. The only measured numbers in this suite are the v1.0
baseline numbers, and they are labelled as such everywhere they appear.

The authoritative, *as-built* state lives in the Phase 1 docs
([../01-overview.md](../01-overview.md) … [../10-glossary.md](../10-glossary.md))
and in [../../README.md](../../README.md) §Status. Read those first; this suite
only describes the **delta** on top of them.

---

## What Phase 2 is

v1.0's own docs are unusually candid about what was left undone. From
[../02-architecture.md §7 "As built"](../02-architecture.md#7-as-built),
[../../SPEC.md](../../SPEC.md), and the pitfalls register
([../08-risks-pitfalls.md](../08-risks-pitfalls.md)), the standing gaps were:

- **P7 — Unbounded CRDT growth.** `qty` is a `Y.Array` of signed deltas and
  deletes are tombstones; both grow for the life of the room and are never
  compacted. v1.0 says so explicitly: *"compactable with the same snapshot/epoch
  strategy as tombstones"* ([../02-architecture.md §7.1](../02-architecture.md#7-as-built)).
- **Testing fidelity.** Connectivity in the suite is toggled through the in-app
  `OfflineToggle` (`provider.disconnect()`), which is deterministic *by design*
  but **never exercises real network-layer offline, throttling, or an interrupted
  sync handshake**.
- **Single-process persistence.** The server writes one debounced file snapshot
  per room (`server/data/<room>.yss`); the SPEC names an authoritative
  **MySQL/Postgres** store this build never reached.
- **No real Background Sync.** Offline edits retry via `y-websocket` reconnect
  **only while the tab is open**; the SPEC's Background Sync deliverable was
  re-scoped, not shipped.

Phase 2 closes each one. The four features are ordered by seniority — the epoch
compaction / rebase work (F1) is the deepest distributed-systems capability in
the whole repository.

---

## The v1.0 → v2.0 delta (one table)

| Axis | v1.0 — built & proven | v2.0 — planned |
|---|---|---|
| **CRDT growth (F1)** | `qty` delta array + tombstones retained for the life of the room; `data/<room>.yss` grows monotonically | ✅ **BUILT** — server-side epoch-checkpoint compaction collapses each item's deltas to one base entry and drops aged tombstones; a long-offline client past the horizon **rebases, never resurrects** (fuzzer + S8 e2e proven) |
| **Test fidelity (F2)** | Deterministic `provider.disconnect()` via `OfflineToggle`; 8 specs × 2 chromium projects = **16/16 green** | A **second Playwright project** using real `context.setOffline`, CDP throttling, and `routeWebSocket` **socket kills mid-`SyncStep2`** — convergence must survive *interrupted* sync |
| **Persistence (F3)** | Single-process debounced file snapshot (`Y.encodeStateAsUpdate` → `data/<room>.yss`, atomic temp+rename, load-on-boot) | A **pluggable `StorageAdapter`** (`file` \| `postgres` \| `mysql`) writing the **same** `encodeStateAsUpdate` blob — aligns with the SPEC's named authoritative DB and opens the path to multi-instance |
| **Background sync (F4)** | `y-websocket` reconnect **while the tab is open** only | A genuine **Workbox `BackgroundSyncPlugin`** queue so offline edits retry **after the tab closes** — or an **honest README re-scope** if the browser support proves too thin |
| **CI (cross-cutting)** | None — suite is green locally, run by hand | **GitHub Actions** runs `test:fuzz` + `test:e2e` (all projects) on every push; "green" becomes continuously demonstrable |

---

## The four v2.0 features

| ID | Feature | One-line goal | Deepest new artifact |
|---|---|---|---|
| **F1** | **Epoch compaction / GC** | Bound the ever-growing qty-delta array + tombstones; prove a pre-horizon client **rebases** | `e2e/specs/epoch-rebase.spec.ts` |
| **F2** | **Adversarial / lossy-network testing** | Prove convergence survives real offline, throttling, and a **socket drop mid-handshake** | `chromium-adversarial` Playwright project |
| **F3** | **Pluggable authoritative persistence** | Same blob to `file` \| Postgres \| MySQL; scale past one process | `server/src/storage/*Adapter.mjs` |
| **F4** | **Real background sync** | Offline edits retry **after tab close** — or an honest re-scope | Workbox `BackgroundSyncPlugin` + `POST /rooms/:room/ops` |

---

## Documentation (this suite mirrors Phase 1's ten-doc structure)

| Doc | What's inside |
|---|---|
| [01-overview.md](01-overview.md) | v2.0 vision, motivation from the v1.0 gaps, goals, non-goals, headline success criteria |
| [02-architecture.md](02-architecture.md) | The architectural additions v2.0 makes on top of the v1.0 client/relay; Mermaid diagrams; the epoch + adapter + background-sync flows |
| [03-requirements.md](03-requirements.md) | Functional + non-functional requirements per feature; in/out of scope; the deliverables checklist |
| [04-data-and-resources.md](04-data-and-resources.md) | New "datasets" (adversarial scenarios), datastores, drivers, hardware, and external resources each feature needs, with licensing notes |
| [05-evaluation-metrics.md](05-evaluation-metrics.md) | How each feature's success is measured; the v2.0 money table with concrete **target** numbers against the v1.0 baseline |
| [06-environment-setup.md](06-environment-setup.md) | The new deps, services, env vars, and setup steps v2.0 adds on top of the Phase 1 environment |
| [07-build-roadmap.md](07-build-roadmap.md) | The executable, milestone-by-milestone plan (Phase 2.0–2.5) with a Definition of Done, effort/impact, and dependencies |
| [08-risks-pitfalls.md](08-risks-pitfalls.md) | Risks and mitigations specific to each feature; the v2.0 risk register |
| [09-references.md](09-references.md) | Papers, standards, tools, and datasets each feature relies on, with identifiers |
| [10-glossary.md](10-glossary.md) | New terms v2.0 introduces (epoch, horizon, rebase, state vector, adapter, Background Sync queue, …) |

---

## How to read this suite

1. Start at [01-overview.md](01-overview.md) for the *why* and the headline
   success criteria.
2. [02-architecture.md](02-architecture.md) for the *how* — the epoch model is
   the centrepiece.
3. [07-build-roadmap.md](07-build-roadmap.md) is the executable plan: it
   sequences the four features so each is shippable and provable on its own.
4. Every claim of a *number* traces back to either the v1.0 baseline (measured,
   labelled) or a v2.0 target (labelled). Nothing here is presented as a result
   that has not been produced.

---

*Anchors on the real v1.0 build: `app/src/crdt/{store,ops}.ts`,
`app/src/queue/mutationLog.ts`, `server/src/index.mjs`, `e2e/` (16/16 green),
`fuzz/crdt-convergence.fuzz.mjs` (1500 histories). Ports 5173 (app) / 4444 (sync
server). No GPU — a pure web / distributed-systems project.*

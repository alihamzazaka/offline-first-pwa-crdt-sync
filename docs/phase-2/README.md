# Phase 2 / v2.0 — Documentation Suite

> The next phase of Project 06. v1.0 shipped a **provably correct** offline-first
> inventory PWA (Yjs CRDT + hand-rolled `y-websocket` relay) with a green
> Playwright suite and a 1500-history property fuzzer. v2.0 takes the three
> honest gaps v1.0 called out — **unbounded CRDT growth**, **clean-disconnect-only
> testing**, and **single-process file persistence** — plus the one deliverable
> v1.0 re-scoped (**real Background Sync**) and turns them into the four
> most senior distributed-systems capabilities left in the repo.

---

## ⚠️ Status banner — F1 + F2 + F3 built; F4 planned

**F1 (epoch compaction + rebase) is now IMPLEMENTED and wired end-to-end**:
`server/src/compaction.mjs` (seal: collapse qty deltas, GC aged tombstones),
the server stale-writer guard + `POST /rooms/:room/compact` (`server/src/index.mjs`),
the client epoch state machine + pending-op rebase (`app/src/crdt/store.ts`,
`app/src/crdt/rebase.ts`) — proven by an 800-history fuzzer
(`fuzz/epoch-compaction.fuzz.mjs`) and a full-stack browser scenario
(`e2e/specs/epoch-rebase.spec.ts`, S8; suite 20/20 green).
**F3 (pluggable persistence) is now IMPLEMENTED**: `server/src/storage.mjs`
defines the `StorageAdapter` interface (`load` / `save` / `listRooms` / `prune`)
with a `FileAdapter` (the v1.0 atomic temp+rename file logic, extracted
verbatim) and a `PostgresAdapter` (`yss_snapshots` upsert via the `pg` driver,
injectable query client); `SYNC_STORAGE=file|postgres` selects it, default
`file` preserves v1.0 behaviour exactly, and the e2e suite boots the server
through the adapter path. Caveat, stated plainly: the Postgres adapter is
unit-proven against a fake query client (`server/test/storage.test.mjs`) — no
live Postgres was reachable on this machine, so its integration test is
skipped until `SYNC_PG_TEST_URL` points at a real DB.
**F2 (adversarial lossy-network testing) is now IMPLEMENTED**:
`e2e/specs/lossy-network.spec.ts` (NET1–NET3) asserts the identical
`expectConvergedWithServer` guarantee under real network adversity — real
browser offline (`context.setOffline`) with a proven partition, repeated
abortive socket kills mid-sync via a test-only `POST /rooms/:room/kill-conns`
endpoint (`SYNC_TEST_ENDPOINTS=1`, `server/src/index.mjs`), and CDP-emulated
500 ms latency — 6/6 green, 0 flakes at `--repeat-each=5` (30/30). Two honest
deviations from this plan, stated plainly: the socket kill is a **server-side
`terminate()`** (a real abortive TCP drop) rather than the planned
`routeWebSocket` interception, and the spec runs under the existing two
chromium projects rather than a third `chromium-adversarial` project — because
Chromium's network emulation does not reliably sever or throttle an
already-established WebSocket, a blanket "adversarial re-run of every spec"
would have quietly tested the clean path; the dedicated NET specs inject faults
that are verified to actually land. **F4 remains a
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
| **Test fidelity (F2)** | Deterministic `provider.disconnect()` via `OfflineToggle`; 8 specs × 2 chromium projects = **16/16 green** | ✅ **BUILT** — `e2e/specs/lossy-network.spec.ts` (NET1–NET3): real `context.setOffline` offline with a **server-side proof the partition held**, six **abortive socket kills** during 24 rapid concurrent edits per client (test-only `POST /rooms/:room/kill-conns`, `SYNC_TEST_ENDPOINTS=1`), and CDP 500 ms-latency emulation with a mid-burst kill — same `expectConvergedWithServer` assertion, **6/6 green, 0 flakes at `--repeat-each=5` (30/30)**. Deviations from plan, stated plainly: server-side `terminate()` instead of `routeWebSocket`; dedicated NET specs under the existing two projects instead of a `chromium-adversarial` re-run (Chromium emulation cannot sever/throttle an established ws, so a blanket re-run would have silently exercised the clean path) |
| **Persistence (F3)** | Single-process debounced file snapshot (`Y.encodeStateAsUpdate` → `data/<room>.yss`, atomic temp+rename, load-on-boot) | ✅ **BUILT** — a **pluggable `StorageAdapter`** (`server/src/storage.mjs`, `SYNC_STORAGE=file` \| `postgres`) writing the **same** `encodeStateAsUpdate` blob; `file` is the v1.0 logic extracted verbatim (default, byte-identical), `postgres` upserts `yss_snapshots` via `SYNC_PG_URL`. Unit-proven (19 tests: round-trip, atomicity, prune, SQL/upsert contract vs a fake client); live-Postgres integration test present but **skipped** until a real DB is reachable |
| **Background sync (F4)** | `y-websocket` reconnect **while the tab is open** only | A genuine **Workbox `BackgroundSyncPlugin`** queue so offline edits retry **after the tab closes** — or an **honest README re-scope** if the browser support proves too thin |
| **CI (cross-cutting)** | None — suite is green locally, run by hand | ✅ **BUILT, not yet run remotely** — `.github/workflows/ci.yml` runs `test:fuzz` + `test:e2e` (chromium, Playwright report uploaded on failure) on every push/PR; equivalent minimal workflows added to the other five portfolio repos. Validated locally (YAML parse + the suites it invokes are green); first remote run pending push to GitHub |

---

## The four v2.0 features

| ID | Feature | One-line goal | Deepest new artifact |
|---|---|---|---|
| **F1** | **Epoch compaction / GC** | Bound the ever-growing qty-delta array + tombstones; prove a pre-horizon client **rebases** | `e2e/specs/epoch-rebase.spec.ts` |
| **F2** | **Adversarial / lossy-network testing** ✅ built | Prove convergence survives real offline, throttling, and a **socket drop mid-sync** | `e2e/specs/lossy-network.spec.ts` + test-only `POST /rooms/:room/kill-conns` |
| **F3** | **Pluggable authoritative persistence** ✅ built | Same blob to `file` \| Postgres; scale past one process | `server/src/storage.mjs` + `server/test/storage.test.mjs` |
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

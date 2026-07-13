# 01 — Overview (v2.0)

> The v2.0 vision, its motivation drawn directly from the gaps v1.0 documented
> about itself, the goals and non-goals, and the single headline success
> criterion each of the four features is judged on. **Phase 2 is a plan; the
> baseline it builds on is real.**

---

## 0. Where we are (the v1.0 baseline — built and proven)

Before any v2.0 framing, the honest anchor. v1.0 **shipped and is green**:

- An **offline-first inventory / stock-count PWA** — React + Vite + **Yjs CRDT**
  + `y-indexeddb` + Workbox — where the UI reads/writes the local `Y.Doc` first
  and works fully with the network off.
- A **hand-rolled `y-websocket` relay** (`server/src/index.mjs`): one
  authoritative `Y.Doc` per room, debounced file-snapshot persistence
  (`data/<room>.yss` via `Y.encodeStateAsUpdate`), `/health`, and a REST
  `GET /rooms/:room/snapshot` used to prove the **server replica** converged.
- The signature modelling win: **`qty` is a PN-counter** — a `Y.Array` of signed
  deltas `{d, op, ts}` summed to an effective quantity — so concurrent offline
  adjustments **add up** (`10 + 5 + 3 = 18`) instead of a register overwrite
  losing one (`../02-architecture.md §7.1`, `app/src/crdt/ops.ts`).
- **The proof:** 8 Playwright specs × 2 chromium projects = **16/16 green**
  (S1–S7 + the qty delta-counter money shot), each asserting convergence across
  **all replicas including the server**; plus a **1500-history property fuzzer**
  (`fuzz/crdt-convergence.fuzz.mjs`) checking convergence, qty=sum-of-deltas, and
  tombstone on every random history.

And the gaps v1.0 named about itself — verbatim honesty from its own docs:

| v1.0 gap | Where v1.0 admits it |
|---|---|
| **Unbounded CRDT growth** — qty deltas + tombstones never compacted | `../08-risks-pitfalls.md` P7; `../02-architecture.md §7.1–7.2` |
| **Notes (`Y.Text`) uncovered by the suite** | `editNotes` exists in `ops.ts` but no e2e spec exercises it |
| **No CI** — green is demonstrated by hand, not continuously | `../05-evaluation-metrics.md §5` calls CI out as a *should* |
| **Clean-disconnect-only testing** — `provider.disconnect()`, never real network offline / interrupted sync | `../02-architecture.md §7.5`; `e2e/helpers/clients.ts` |
| **Single-process file persistence** — the SPEC's named MySQL/Postgres store was never reached | `../../SPEC.md §3`; `server/src/index.mjs` |
| **No real Background Sync** — retries only while the tab is open | `../../SPEC.md §7` FR-5 re-scoped |

v2.0 is exactly the work of closing these — in the order that maximises the
distributed-systems signal.

---

## 1. Problem → Solution (v2.0)

| | |
|---|---|
| **Problem** | v1.0 proves *correctness* but not *longevity or robustness at the edges*. A room that lives for weeks grows without bound; a sync that is interrupted mid-handshake is never tested; the durable store is a single file on one box; and an edit made offline is lost to the server if the user closes the tab before reconnecting. These are the properties a reviewer probes *after* they believe the merge is correct. |
| **Solution** | Four targeted features that each convert a documented v1.0 gap into a proven capability: **(F1)** server-side **epoch compaction** that bounds growth and forces pre-horizon clients to **rebase**; **(F2)** an **adversarial Playwright project** that drops sockets mid-`SyncStep2` and throttles the reconnect; **(F3)** a **pluggable storage adapter** (`file` \| Postgres \| MySQL) writing the same blob; **(F4)** a **real Workbox Background Sync** queue that survives tab close — or an honest re-scope. |
| **Why it's rare** | Anyone can cache a shell; few prove a *correct* merge (v1.0 did). Almost **no** portfolio then goes on to prove that the merge **survives log compaction, an interrupted handshake, a database-backed multi-instance store, and a closed tab**. That is production distributed-systems maturity, not a demo. |

---

## 2. Honest positioning vs the v1.0 claim

v1.0's credible headline was a *measured, reproducible correctness win on a named
axis*. v2.0 does **not** dilute that — it extends the axis:

> **After any interleaving of offline edits and reconnects — including an epoch
> compaction that has already run, a sync handshake killed mid-`SyncStep2`, a
> Postgres-backed authoritative store, and edits made while the tab was closed —
> every client and the server still converge to identical state with zero lost
> writes and zero resurrected deletes, proven by an expanded automated suite that
> anyone can run in CI.**

Two guardrails on the honesty:

- **This is a plan.** No target number here is a result. The v1.0 numbers
  (16/16, 1500 histories, `+5 & +3 → +8`) are the *only* measured figures, and
  they are labelled *baseline* everywhere.
- **F4 may re-scope in public.** The Background Sync API is Chromium-only and
  absent on iOS Safari. If a genuine post-tab-close retry cannot be made reliable
  across the target browsers, v2.0's deliverable becomes an **honest README
  section** documenting the limitation and keeping the reconnect-while-open path
  as the guaranteed one — *exactly* the move v1.0 already made, and it counts as
  a valid outcome (see [08-risks-pitfalls.md](08-risks-pitfalls.md) R-F4).

---

## 3. Goals

- **G1 — Bounded growth with provable correctness.** Compaction must never cost a
  correctness guarantee. A room that has been compacted, and a client that missed
  the compaction, must still converge — the pre-horizon client **rebases** onto
  the new epoch and never resurrects a tombstoned or compacted record.
- **G2 — Robustness under a hostile network.** Every v1.0 convergence guarantee
  must re-pass under real `context.setOffline`, CDP throttling, and a WebSocket
  killed mid-handshake — not just the clean in-app toggle.
- **G3 — Persistence that scales past one process.** The authoritative state must
  be writable to Postgres/MySQL through one interface, byte-for-byte identical to
  the file path, opening a documented route to multiple server instances.
- **G4 — Durability across tab close.** An offline edit should reach the server
  after reconnect even if the tab was closed in between — or the limitation is
  documented honestly.
- **G5 — Continuously demonstrable.** The whole suite (fuzzer + all Playwright
  projects) runs in **CI** so "green" is a fact on every push, not a local claim.

---

## 4. Non-goals

- **Rewriting the CRDT model.** `qty`-as-PN-counter, tombstone-delete, `Y.Text`
  notes, per-key field merge — all of v1.0's data model is **kept**. v2.0 adds
  around it; it does not re-litigate `../02-architecture.md §7`.
- **Real-time multi-region replication / consensus.** F3 reaches a
  database-backed store and a *documented* multi-instance path; it does **not**
  ship Raft/Paxos, CRDT-over-Postgres-logical-replication, or geo-distribution.
- **A general-purpose sync product.** The demo domain stays offline stock-count.
- **Throughput / load benchmarking.** Correctness and robustness remain the
  headline; F1's size numbers are the *only* quantitative growth targets, and
  they measure **bounding**, not speed.
- **OT, Automerge, or a turnkey provider swap.** Out of scope, as in v1.0.
- **Auth / multi-tenant / RBAC on the relay.** The relay stays an unauthenticated
  local-first demo; F3 notes where auth *would* attach, without building it.

---

## 5. Headline success criteria (per feature)

Each feature is judged on **one** crisp, automatable criterion. Full metric
definitions and target numbers are in
[05-evaluation-metrics.md](05-evaluation-metrics.md).

| Feature | Single headline criterion |
|---|---|
| **F1 — Epoch compaction / GC** | After a compaction at epoch *E*, a client whose state predates the horizon reconnects and **rebases**: it converges with the compacted room, resurrects **0** tombstoned/compacted records, and its qty equals `compacted_base + its_own_unmerged_deltas`. Proven by `e2e/specs/epoch-rebase.spec.ts`. |
| **F2 — Adversarial testing** | Every S1–S7 guarantee re-passes under the `chromium-adversarial` project, where at least one scenario has its WebSocket **killed during `SyncStep2`** and reconnected — convergence still holds, **0** flakes across the CI-repeat budget. |
| **F3 — Pluggable persistence** | The `postgres` and `mysql` adapters persist and reload a room to **byte-identical** converged state vs the `file` adapter (same `encodeStateAsUpdate` blob), verified by an adapter-parity test; and a two-instance smoke run converges through the shared store. |
| **F4 — Real background sync** | An edit made offline with the tab then **closed** is delivered to the server within the Background Sync retry window (asserted against `/rooms/:room/snapshot`) — **or** the README documents, with the browser-support matrix, why it is a progressive enhancement over the guaranteed reconnect-while-open path. |
| **Cross-cutting — CI** | `test:fuzz` + `test:e2e` (all projects, incl. adversarial) run green in GitHub Actions on every push. |

---

## 6. Success, stated as one sentence

> **v2.0 is done when a reviewer can clone the repo, run one command in CI, and
> watch the v1.0 correctness guarantees hold *after* compaction, *through* a
> socket drop mid-handshake, *against* a Postgres-backed store, and *across* a
> closed tab — with every number that is a target labelled as a target and every
> number that is measured traceable to a green run.**

---

## 7. Where to go next

- The architecture of each addition → [02-architecture.md](02-architecture.md)
- Exactly what must be built and what is out of scope → [03-requirements.md](03-requirements.md)
- The new adversarial scenarios and datastores → [04-data-and-resources.md](04-data-and-resources.md)
- How each win is measured, with target numbers → [05-evaluation-metrics.md](05-evaluation-metrics.md)
- The executable, sequenced plan → [07-build-roadmap.md](07-build-roadmap.md)

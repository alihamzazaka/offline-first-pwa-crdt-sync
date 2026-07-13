# 05 — Evaluation & Metrics (v2.0)

> How each v2.0 feature's success is measured, the new metrics it introduces, and
> the concrete **target** numbers stated against the **measured** v1.0 baseline —
> plus the v2.0 "money table" the suite must produce. **Correctness and
> robustness, not throughput, remain the headline.** Every number below is either
> a labelled *baseline (measured)* or a labelled *target (planned)*; nothing here
> is presented as an achieved v2.0 result.

---

## 1. The headline (unchanged, extended)

v1.0's headline was *correctness, not throughput*. v2.0 keeps that and adds
**robustness and longevity**: correctness must survive compaction, a hostile
network, a SQL-backed store, and a closed tab. Every metric is a **pass/fail
assertion** first; the one quantitative family is F1's **size-bounding** numbers,
which measure that growth is bounded — not speed.

---

## 2. The v1.0 baseline (measured — the anchor)

| Baseline metric | Measured value (v1.0) | Source |
|---|---|---|
| Playwright convergence runs | **16 / 16 green** (8 specs × 2 chromium projects) | `RUNBOOK.md §4`, `e2e/` |
| Property-fuzzer histories | **1500** random histories, 3 invariants each | `fuzz/crdt-convergence.fuzz.mjs` |
| Concurrent qty money shot | `+5` and `+3` offline → **+8** (start 10 → 18) | `e2e/specs/qty-concurrent-adjust.spec.ts` |
| qty history growth | **+1 `Y.Array` entry per adjustment, unbounded** | `app/src/crdt/ops.ts` |
| Tombstone retention | **life of the room** (no sweep) | `app/src/crdt/ops.ts` §tombstone |
| Persistence | **1 file snapshot/room**, debounced 750 ms | `server/src/index.mjs` |
| Connectivity in tests | **`provider.disconnect()`** only | `e2e/helpers/clients.ts` |
| CI | **none** | — |
| Notes (`Y.Text`) coverage | **0 specs** | `e2e/specs/` |

These are the only measured numbers in the entire v2.0 suite. Everything below is
a target relative to them.

---

## 3. Metric definitions (per feature)

### F1 — Epoch compaction / GC

**M-F1a — Snapshot-size bounding (quantitative).**
- *Definition:* the persisted snapshot size after compaction as a function of
  **live item count**, independent of historical adjustment count.
- *How measured:* create a room with `L` live items and apply `A` total qty
  adjustments; record `|snapshot|` before and after `buildNextEpoch`.
- *Baseline (measured):* size grows `O(A)` — one delta entry per adjustment,
  forever.
- *Target (planned):* after compaction, size is `O(L)` — each item's deltas
  collapse to **1** base entry. For a room with `L=100`, `A=10 000`, the
  compacted qty state holds **100** base deltas, not 10 000 — a **≥ 99 %**
  reduction in qty-delta count, and a snapshot-byte reduction **≥ 90 %** on that
  workload.

**M-F1b — Rebase correctness (pass/fail, the headline).**
- *Definition:* a pre-horizon client converges after rebase with **0**
  resurrected records and `qty = compacted_base + its_own_unmerged_deltas`.
- *How measured:* `epoch-rebase.spec.ts` asserts `expectConvergedWithServer`
  after compaction + rebase, and asserts the swept item never reappears.
- *Target:* **PASS**, and `resurrected_count == 0` exactly.

**M-F1c — No premature compaction (pass/fail).**
- *Definition:* compaction does not run while a connected peer is behind the
  checkpoint.
- *Target:* the liveness gate blocks; **PASS**.

**M-F1d — Fuzzer no-resurrection invariant (pass/fail over N histories).**
- *Definition:* across randomly-placed compaction points, no swept tombstone
  reappears and every qty-sum is preserved.
- *Target:* invariant holds over **≥ 1500** histories (matching the v1.0 fuzz
  budget), with the compaction step enabled.

### F2 — Adversarial / lossy-network testing

**M-F2a — Convergence under real faults (pass/fail).**
- *Definition:* every S1–S7 guarantee re-passes under `context.setOffline`, CDP
  throttling, and a socket killed mid-`SyncStep2`.
- *Target:* **PASS** for NET1–NET4; identical `expectConvergedWithServer`
  assertion as the clean projects — no weaker bar.

**M-F2b — Flake budget (quantitative).**
- *Definition:* failures across repeated adversarial runs.
- *Target:* **0** failures across `--repeat-each=5` on the adversarial specs in
  CI.

**M-F2c — Interrupted-handshake coverage (boolean).**
- *Definition:* at least one scenario provably interrupts `SyncStep2` (verified
  by the `routeWebSocket` route logging the close) and still converges.
- *Target:* **true**.

### F3 — Pluggable authoritative persistence

**M-F3a — Adapter blob parity (pass/fail).**
- *Definition:* the bytes `postgres`/`mysql` persist equal the bytes `file`
  persists for the same converged doc.
- *How measured:* adapter-parity test: persist a known room via each adapter,
  read back, assert `Uint8Array` equality and identical decoded `exportItems`.
- *Target:* **byte-identical** across all three adapters.

**M-F3b — Durable restart (pass/fail).**
- *Definition:* with a SQL adapter, a relay restart reloads every room to
  identical converged state.
- *Target:* **PASS** (the F3 analogue of v1.0 load-on-boot).

**M-F3c — Two-instance convergence smoke (pass/fail, documented).**
- *Definition:* two relay instances sharing one SQL store converge a room through
  the store, within the stated multi-writer boundary.
- *Target:* **PASS** for the documented smoke; the multi-writer limitation is
  stated, not hidden.

### F4 — Real background sync

**M-F4a — Post-tab-close delivery (pass/fail, browser-gated).**
- *Definition:* an op made offline is delivered to the server after reconnect with
  the tab closed in between.
- *How measured:* a test makes an offline op, closes the page/context, reconnects
  the context, and polls `/rooms/:room/snapshot` for the op.
- *Target:* **PASS on a Background-Sync-capable browser (Chromium)** — **or** the
  re-scope (M-F4b).

**M-F4b — Honest re-scope (boolean, alternative completion).**
- *Definition:* if M-F4a cannot be made cross-browser-honest, the README ships a
  browser-support matrix and keeps reconnect-while-open as guaranteed.
- *Target:* **documented** — a valid completion, mirroring v1.0's re-scope
  discipline.

**M-F4c — Idempotent ingest (pass/fail).**
- *Definition:* replaying the queued POST twice does not double-apply.
- *Target:* record count / qty unchanged on retry; **PASS** (ULID idempotency).

### Cross-cutting

**M-CIa — CI green (pass/fail).** `test:fuzz` + `test:e2e` (all projects) green in
GitHub Actions on every push. *Target:* **PASS**.

**M-COVa — Notes coverage (count).** *Baseline:* 0 notes specs. *Target:* **1**
(`concurrent-notes.spec.ts`) green.

---

## 4. The v2.0 "money table"

Every row is an automated assertion (or a documented outcome for F4's re-scope
branch). This is the table v2.0 must produce, green, in CI.

| # | Capability | Baseline (measured, v1.0) | Target (planned, v2.0) | Verified by |
|---|---|---|---|---|
| 1 | qty-delta count after heavy use | `O(A)` — one per adjustment, unbounded | **`O(L)`** — 1 base delta/item; ≥ 99 % fewer deltas | `epoch-rebase` + fuzzer |
| 2 | snapshot bytes (L=100, A=10 000) | grows with A | **≥ 90 % smaller** after compaction | size assertion |
| 3 | pre-horizon client outcome | n/a (no compaction) | **rebases, 0 resurrected** | `epoch-rebase.spec.ts` |
| 4 | premature compaction | n/a | **blocked by liveness gate** | S10 spec |
| 5 | convergence under real offline | untested (clean toggle only) | **PASS** | `chromium-adversarial` NET1 |
| 6 | convergence, socket killed mid-`SyncStep2` | untested | **PASS** | NET3 (`routeWebSocket`) |
| 7 | convergence under throttled reconnect | untested | **PASS** | NET2 (CDP) |
| 8 | adversarial flake budget | n/a | **0 / `repeat-each=5`** | CI |
| 9 | storage blob parity (file vs PG vs MySQL) | file only | **byte-identical** | adapter-parity test |
| 10 | durable restart (SQL) | file only | **PASS** | F3 restart test |
| 11 | multi-instance convergence | single process | **PASS (smoke, bounded)** | two-instance smoke |
| 12 | offline edit survives tab close | **no** (WS-while-open only) | **PASS (Chromium)** or documented re-scope | F4 tab-close test |
| 13 | idempotent HTTP ingest | n/a | **no double-apply** | F4 idempotency test |
| 14 | concurrent notes merge | **0 specs** | **1 spec green** | `concurrent-notes.spec.ts` |
| 15 | CI | none | **green on push** | GitHub Actions |

> The magnitudes (`L=100`, `A=10 000`, `≥ 90 %`, `≥ 99 %`, `repeat-each=5`) are
> **illustrative targets** chosen to make the bounding property visible; the fixed
> contract is the *shape* of the win — size becomes a function of live items, and
> every correctness guarantee survives each new stressor — not a specific
> magnitude. They will be replaced by measured numbers only once produced.

---

## 5. The eval harness / tooling

- **Playwright** — three projects now: `chromium-client-a`, `chromium-client-b`
  (clean, deterministic regression) and **`chromium-adversarial`** (real
  offline/throttle/socket-kill). Same `helpers/clients.ts` vocabulary; the
  connectivity primitive is swapped per project.
- **Property fuzzer** — `node --test fuzz/crdt-convergence.fuzz.mjs`, extended
  with a random compaction point and the no-resurrection invariant.
- **Adapter-parity test** — a small `node --test` over the three
  `StorageAdapter`s, asserting byte-equal blobs (Postgres/MySQL via service
  containers in CI, Docker locally).
- **CI** — GitHub Actions runs `npm run test:fuzz` then `npm run test:e2e`
  (all projects), with a matrixed F3 job that attaches a Postgres/MySQL service.

---

## 6. How the v2.0 win is proven

1. **Extend the fuzzer** with compaction + the no-resurrection invariant; keep it
   green over ≥ 1500 histories.
2. **Add `epoch-rebase.spec.ts`** — the pre-horizon rebase proof (the F1
   headline).
3. **Add the `chromium-adversarial` project** — re-run S1–S7 under real faults,
   including a socket killed mid-`SyncStep2`, at zero flake.
4. **Add the adapter-parity test** — byte-identical blob across file/PG/MySQL,
   plus a durable-restart check.
5. **Ship F4** — the tab-close delivery test on Chromium, **or** the documented
   re-scope with the browser-support matrix.
6. **Turn CI green** — the whole thing on every push, so "green" is a fact.

The claim stands or falls on step 6, exactly as v1.0's did: **a reproducible,
green suite — now including compaction, adversarial faults, SQL storage, and
(where honest) tab-close durability — is the evidence.**

---

## 7. Related docs

- The scenarios behind each metric → [04-data-and-resources.md](04-data-and-resources.md)
- Success criteria per feature → [01-overview.md](01-overview.md#5-headline-success-criteria-per-feature)
- Where each metric's code is built → [07-build-roadmap.md](07-build-roadmap.md)
- The v1.0 metrics this extends → [../05-evaluation-metrics.md](../05-evaluation-metrics.md)

# 05 — Evaluation & Metrics

> Precise metric definitions, the baselines to beat, the "money table" from the SPEC, the eval harness, and exactly how the win is proven. **Correctness, not throughput, is the headline.**

---

## 1. The headline

> **Correctness, not throughput, is the headline.**

The project is judged on whether concurrent offline edits reconcile **correctly** — not on
how fast or how many. Every metric below is a **correctness assertion** first; latency and
drain time are optional, secondary, background measurements.

---

## 2. Metric definitions

Each metric is defined precisely so the Playwright suite can assert it unambiguously.

### Convergence (primary)

- **Definition:** After **any interleaving** of offline edits and reconnects, **all
  clients + the server reach identical state**.
- **How measured:** Snapshot each replica's state after sync settles; assert byte/field
  equality across all of them.
- **Pass condition:** All replicas equal, for every scenario, every run.

### No lost writes

- **Definition:** Concurrent edits to **different fields** of the same record **both
  persist**.
- **How measured:** After S2, assert both edited fields hold both clients' values.
- **Pass condition:** Neither write is overwritten.

### No duplicates

- **Definition:** Offline creates **replay idempotently** — replaying the same op set
  produces no duplicate records.
- **How measured:** After S3 (create ×N, reconnect, replay), assert record count equals N.
- **Pass condition:** Exactly N records; stable op IDs prevent dupes.

### Defined conflict behavior

- **Definition:** Same-field conflicts resolve **per the documented rule** (deterministic
  automatic result) **or** are **surfaced to the user**.
- **How measured:** After S1, assert the final value matches the documented rule (or that
  the conflict UI is shown with both candidate values).
- **Pass condition:** Deterministic, documented outcome — never a silent overwrite.

### Offline UX

- **Definition:** The app remains **fully usable with the network off**.
- **How measured:** With Playwright offline, drive core CRUD flows and assert they
  succeed and persist locally.
- **Pass condition:** All core flows work offline.

### Sync latency (optional, secondary)

- **Definition:** Time from reconnect to convergence.
- **How measured:** Timestamp reconnect → timestamp all-replicas-equal.
- **Pass condition:** Reported as an observed number (illustrative, not a hard gate).

### Queue-drain time (optional, secondary)

- **Definition:** Time to drain the mutation queue after a **long** offline period.
- **How measured:** Fill queue with many ops offline, reconnect, time until empty.
- **Pass condition:** Bounded, reported (illustrative, not a hard gate).

---

## 3. Baselines to beat (named)

The comparison is against the **common portfolio baseline** and the **naive default**,
both of which the SPEC calls out explicitly:

| Baseline | What it does | Its failure |
|---|---|---|
| **"Fake offline" (cache-the-shell)** | Service worker precaches the app shell so the page *loads* offline | **Cannot reconcile concurrent writes** — it is not sync at all |
| **Naive last-write-wins (LWW)** | On reconnect, the last write to arrive overwrites | **Silent data loss** — the first client's edit vanishes |

The **win** is beating both: real bidirectional sync where **both** concurrent edits
survive a **correct automatic merge** (CRDT) or a **defined conflict resolution**, proven
reproducibly. This is the "measured win on a named axis," not a novelty claim.

---

## 4. The "money table"

Reproduced from the SPEC — the core proof table. Every row is an automated Playwright
assertion. The scenarios trace back to [04-data-and-datasets.md](04-data-and-datasets.md).

| Scenario | Expected | Verified by |
|---|---|---|
| Same-field concurrent edit | Converges to defined result | Playwright assert |
| Different-field concurrent edit | Both survive | Playwright assert |
| Offline create ×N → reconnect | No duplicates | Playwright assert |
| Delete vs edit race | Defined tombstone outcome | Playwright assert |

Extended proof matrix (adds the remaining SPEC scenarios):

| Scenario | Expected | Guarantee | Verified by |
|---|---|---|---|
| Same-field concurrent edit | Converges to defined result (or surfaced conflict) | Defined conflict behavior | Playwright assert |
| Different-field concurrent edit | Both survive | No lost writes | Playwright assert |
| Offline create ×N → reconnect | No duplicates | Idempotency | Playwright assert |
| Delete vs edit race | Defined tombstone outcome | Deterministic delete/edit | Playwright assert |
| Long-offline queue | Replays correctly, in order | Ordered replay | Playwright assert |
| Three-way (A, B, server) | All converge to identical state | Convergence | Playwright assert |
| Multi-tab, one device | Tabs stay consistent | Cross-tab concurrency | Playwright assert |

> Numbers such as "create ×N" and any reported sync-latency / queue-drain figures are
> **illustrative placeholders** — the fixed contract is the *expected outcome*, not a
> specific magnitude.

---

## 5. The eval harness / tooling

- **Playwright** — **multi-context** (independent clients) with **network
  throttling/offline** toggling. This is the SPEC's designated proof tool.
- **Assertions** — state-equality across replicas, record-count checks (duplicates),
  field-survival checks (lost writes), value/rule checks (conflict behavior), tombstone
  checks (delete/edit).
- **Reproducibility** — one command runs the whole suite; a reviewer can clone and verify.
- **CI** — run the suite in CI so "green" is continuously demonstrable.

---

## 6. How the win is proven

1. **Automate every scenario** in [04-data-and-datasets.md](04-data-and-datasets.md) as a
   Playwright multi-context test.
2. **Assert** convergence, no lost writes, no duplicates, and defined conflict behavior —
   not just eyeball a demo.
3. **Turn the suite green** in CI so anyone can reproduce it.
4. **Record the demo video** — two windows, both offline, conflicting edits, reconnect,
   correct merge (the "whoa" moment).
5. **Write it up** — the chosen conflict model, the architecture diagram, the guarantees,
   and the **naive-LWW failure mode avoided**.

The claim stands or falls on step 3: **a reproducible, green correctness suite** is the
evidence. That is the entire evaluation strategy.

---

## 7. Related docs

- Scenario catalogue → [04-data-and-datasets.md](04-data-and-datasets.md)
- Success criteria → [01-overview.md](01-overview.md#6-success-criteria-the-single-headline-metric--constraint)
- Where the suite is built → [07-build-roadmap.md](07-build-roadmap.md)
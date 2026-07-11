# 04 — "Datasets" = the Test-Scenario Catalogue

> This is not an ML project. Here, "datasets" means the **concurrent-edit test scenarios** that prove correctness. The artifact's credibility is a **reproducible correctness test**, so the scenarios are designed first-class.

---

## 1. Why test scenarios are the "data"

> Your artifact's credibility is a **reproducible correctness test**, so design the
> scenarios.

There is no training corpus, no labeling, and no train/val/test split. The equivalent of
a dataset is a **catalogue of concurrent-edit scenarios**, each with a defined expected
outcome and each **automated in Playwright** (two browser contexts, offline toggling) so
that **anyone can run them**. The scenarios *are* the ground truth.

---

## 2. The scenario catalogue

Every scenario from the SPEC, with its expected result and the concurrency it exercises.

### S1 — Concurrent edit, same field

- **Setup:** Two clients (A, B) both go offline. Both change the **same value** of the
  same record X.
- **Expected:** Converge to a **defined result** (CRDT convergence) **or** a **surfaced
  conflict** (app-level model). The outcome must be deterministic and documented — never a
  silent overwrite.
- **Exercises:** The central conflict path; the documented same-field rule.

### S2 — Concurrent edit, different fields

- **Setup:** A and B, both offline, edit **different fields** of the same record.
- **Expected:** **Both survive** (field-level merge). No lost writes.
- **Exercises:** Field-level merge; the "no lost writes" guarantee.

### S3 — Offline create → reconnect

- **Setup:** Create N records while offline, then reconnect (and, ideally, replay the same
  op set more than once).
- **Expected:** **No duplicates** — creates replay **idempotently** thanks to stable
  client-generated op IDs.
- **Exercises:** Idempotency; op-ID stability.

### S4 — Delete vs edit race

- **Setup:** A deletes record X offline while B edits X offline; both reconnect.
- **Expected:** A **defined tombstone behavior** — the documented outcome (e.g. delete
  wins, or edit resurrects, per your rule). Deterministic, not accidental.
- **Exercises:** Tombstones; delete/edit ordering.

### S5 — Long-offline queue

- **Setup:** Accumulate **many** queued ops during a long offline period, then reconnect.
- **Expected:** All queued ops **replay correctly and in order**.
- **Exercises:** Queue durability, replay ordering, drain behavior.

### S6 — Three-way merge (A, B, server)

- **Setup:** A, B, and the server all diverge, then reconcile.
- **Expected:** All three converge to **one identical state**.
- **Exercises:** Full three-way convergence, not just pairwise.

### S7 — Multi-tab on one device (from the pitfalls)

- **Setup:** Two tabs of the **same browser** edit concurrently (a real concurrency
  source, not just cross-device).
- **Expected:** Tabs stay consistent via **BroadcastChannel / shared persistence**.
- **Exercises:** Intra-device concurrency; shared IndexedDB / cross-tab signalling.

---

## 3. Scenario → guarantee mapping

| Scenario | Expected | Guarantee proven | Verified by |
|---|---|---|---|
| **S1** Same-field concurrent edit | Converges to defined result (or surfaced conflict) | Defined conflict behavior | Playwright assert |
| **S2** Different-field concurrent edit | Both survive | No lost writes | Playwright assert |
| **S3** Offline create ×N → reconnect | No duplicates | Idempotency | Playwright assert |
| **S4** Delete vs edit race | Defined tombstone outcome | Deterministic delete/edit | Playwright assert |
| **S5** Long-offline queue | Replays correctly, in order | Ordered replay / durability | Playwright assert |
| **S6** Three-way (A, B, server) | All converge to identical state | Convergence | Playwright assert |
| **S7** Multi-tab one device | Tabs stay consistent | Cross-tab concurrency | Playwright assert |

---

## 4. How the scenarios are automated

- **Tool:** **Playwright**, using **multiple browser contexts** to simulate independent
  clients, plus **network throttling / offline toggling** to force the disconnected state.
- **Pattern per scenario:**
  1. Open two (or more) contexts pointed at the app.
  2. Set both **offline**.
  3. Perform the divergent edits.
  4. Bring both **online**.
  5. Wait for sync to settle.
  6. **Assert** the final state on every client (and the server) matches the expected
     result — identical state, correct survivors, no duplicates, correct tombstone.
- **Goal:** the suite is **self-contained and reproducible** — a reviewer clones the repo,
  runs one command, and watches every scenario pass.

See [05-evaluation-metrics.md](05-evaluation-metrics.md) for the precise assertions
(convergence, no lost writes, no duplicates, defined conflict behavior) and
[07-build-roadmap.md](07-build-roadmap.md) Phase 4 for where the suite is built.

---

## 5. Scenario design checklist

When adding a scenario, make sure it specifies:

- [ ] The number of clients / tabs and their initial state.
- [ ] The exact offline edits each makes (and in what interleaving).
- [ ] The reconnect order.
- [ ] The **single, documented expected outcome**.
- [ ] The Playwright assertion that proves it (equality of state, count checks, tombstone
      checks).
- [ ] That it is **deterministic** — no reliance on wall-clock timing or race luck.

---

## 6. What this is *not*

- Not an ML dataset — no pulling from Hugging Face, no labeling, no splits.
- Not a throughput/load benchmark — correctness, not volume, is the point (though optional
  **sync latency** and **queue-drain time** may be measured).
- Not a manual click-through demo — the scenarios are **automated** so the proof is
  reproducible, not anecdotal.
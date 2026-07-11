# 08 — Risks & Pitfalls

> Every common pitfall from the SPEC, expanded into the risk, why it happens, and the concrete mitigation — plus a risk register (likelihood / impact) for the top items.

---

## 1. Expanded pitfalls

### P1 — Fake offline

- **Risk:** Shipping "offline support" that is just the app shell cached by a service
  worker, so the page *loads* offline but cannot sync.
- **Why it happens:** Caching the shell is easy and looks like offline support; the hard
  part (reconciling concurrent writes) is invisible until two clients collide.
- **Mitigation:** Set the bar at **correct reconciliation of concurrent writes**, not
  loading offline. Prove it with the concurrent-edit test suite — the shell-cache demo
  does not pass those tests.

### P2 — Naive last-write-wins (LWW)

- **Risk:** On reconnect, the last write to arrive silently overwrites earlier concurrent
  writes → **silent data loss**.
- **Why it happens:** LWW is the default, simplest reconciliation; it is invisible in
  single-user testing and only bites under concurrency.
- **Mitigation:** Use a **CRDT** (automatic convergence) or **explicit conflict handling**
  (field-level merge / surfaced conflict). Never let a same-field conflict resolve by
  accident.

### P3 — Non-idempotent replay

- **Risk:** Replaying queued ops on reconnect creates **duplicate** records.
- **Why it happens:** If op identity is server-assigned or derived from timing, a
  retry/replay looks like a new op.
- **Mitigation:** Give **every op a stable, client-generated ID** so replay is idempotent.
  Assert "no duplicates" in scenario S3.

### P4 — IndexedDB quirks

- **Risk:** Broken upgrades or data loss from **versioning/migrations** and **storage
  eviction** under pressure.
- **Why it happens:** IndexedDB has an explicit versioned-upgrade model, and browsers can
  **evict** storage when the device is low on space.
- **Mitigation:** Handle versioning/migrations deliberately and **degrade gracefully** on
  eviction (detect, re-hydrate from server, warn the user). Consider requesting persistent
  storage where appropriate.

### P5 — Service worker cache staleness

- **Risk:** Users stuck on an **old cached** version after a deploy.
- **Why it happens:** Service workers aggressively serve cached assets; without cache
  versioning, updates never reach the client.
- **Mitigation:** **Version your caches** and adopt a safe update strategy — use
  `skipWaiting` / `clientsClaim` **carefully** so you do not swap assets out from under an
  active session.

### P6 — Clock skew

- **Risk:** Ordering decisions based on **wall-clock time** are wrong because device clocks
  disagree.
- **Why it happens:** Client clocks drift and are user-settable; comparing timestamps
  across devices is unreliable.
- **Mitigation:** **Do not trust wall-clock time for ordering.** Use **logical / vector
  clocks** or **CRDT metadata** to order and merge.

### P7 — Unbounded CRDT growth

- **Risk:** Long-lived Yjs/Automerge docs **accumulate history** and grow without bound.
- **Why it happens:** CRDTs retain the metadata/history needed to guarantee convergence.
- **Mitigation:** Plan **snapshotting / compaction** for long-lived docs so storage and
  load times stay bounded.

### P8 — Multi-tab on one device

- **Risk:** Two tabs of the same browser are **also a concurrency source** and can diverge
  or corrupt shared state.
- **Why it happens:** Tabs share the same origin/IndexedDB but run independently; edits in
  one are not automatically visible to the other.
- **Mitigation:** Treat cross-tab as first-class concurrency — coordinate via
  **BroadcastChannel** / shared persistence and **test it** (scenario S7).

---

## 2. Risk register (top items)

Likelihood and impact are qualitative (Low / Medium / High). "Impact" is on the headline
correctness guarantee.

| ID | Risk | Likelihood | Impact | Priority | Primary mitigation |
|---|---|---|---|---|---|
| **P2** | Naive LWW → silent data loss | High | High | **Critical** | CRDT or explicit conflict handling |
| **P3** | Non-idempotent replay → duplicates | High | High | **Critical** | Stable client-generated op IDs |
| **P6** | Clock skew → wrong ordering | Medium | High | High | Logical/vector clocks, CRDT metadata |
| **P1** | Fake offline (shell only) | Medium | High | High | Bar = correct reconciliation; prove with tests |
| **P8** | Multi-tab concurrency | Medium | Medium | Medium | BroadcastChannel / shared persistence + test |
| **P4** | IndexedDB versioning/eviction | Medium | Medium | Medium | Migrations + graceful degradation |
| **P5** | Service worker cache staleness | Medium | Medium | Medium | Versioned caches, careful update strategy |
| **P7** | Unbounded CRDT growth | Low–Medium | Medium | Medium | Snapshotting / compaction |

---

## 3. Cross-cutting guidance

- The two **Critical** risks (P2, P3) map directly to the two headline guarantees — **no
  lost writes** and **no duplicates**. Guard them with automated assertions
  ([05-evaluation-metrics.md](05-evaluation-metrics.md)), not manual checks.
- Most of these pitfalls are **invisible in single-user, always-online testing** — they
  only surface under concurrency and offline toggling, which is exactly why the
  **Playwright multi-context suite** ([04-data-and-datasets.md](04-data-and-datasets.md))
  is the project's proof.
- When in doubt about ordering, prefer **CRDT metadata / logical clocks** over any
  timestamp.
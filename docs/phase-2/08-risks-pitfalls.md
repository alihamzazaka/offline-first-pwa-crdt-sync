# 08 — Risks & Pitfalls (v2.0)

> The risks specific to each v2.0 feature, why each happens, the concrete
> mitigation, and a consolidated risk register. Extends the v1.0 pitfalls
> ([../08-risks-pitfalls.md](../08-risks-pitfalls.md)) — in particular P7
> ("unbounded CRDT growth"), which v2.0 sets out to close and, in closing,
> introduces the sharpest new risk (resurrection). **These are risks for planned
> work.**

---

## 1. The v1.0 pitfalls that carry forward

The v1.0 register (P1–P8) still applies to the shipped substrate. Two are
directly relevant to v2.0:

- **P7 — Unbounded CRDT growth.** The problem F1 exists to solve. v1.0 mitigated
  it only by *scoping rooms to a session*; v2.0 replaces that with real
  compaction.
- **P6 — Clock skew.** Compaction must **never** order or gate on wall-clock
  time. The horizon is a **state vector**, not a timestamp; the tombstone-age
  sweep uses a coarse retention window, not per-event clock comparison.

---

## 2. F1 — Epoch compaction / GC

### R-F1a — Resurrection (the sharpest risk in v2.0)

- **Risk:** compaction drops a tombstone or collapses deltas, then a pre-horizon
  client's stale Yjs updates **re-introduce** the removed state on next sync — a
  deleted item comes back, or a collapsed adjustment double-counts.
- **Why it happens:** merging raw pre-compaction updates into the new epoch doc is
  a set-union; Yjs faithfully re-adds whatever the client still holds.
- **Mitigation:** never merge raw pre-horizon updates. Force **rebase** (adopt the
  new epoch doc, replay only the client's *pending* journal ops through the
  idempotent path). This is v1.0's own stated rule
  (`../02-architecture.md §7.2`), now enforced in code and asserted by
  `epoch-rebase.spec.ts` with a `resurrected_count == 0` check and by the fuzzer's
  no-resurrection invariant.

### R-F1b — Compacting too early (stranding a live peer)

- **Risk:** compaction runs while a connected peer is still behind the checkpoint,
  discarding history it needed.
- **Why it happens:** a naive timer/size trigger ignores who is connected.
- **Mitigation:** the **liveness gate** (FR2-5) — compact only when every
  connected peer's state vector is `≥` the checkpoint, or the room has quiesced.
  Asserted by S10.

### R-F1c — qty-collapse arithmetic drift

- **Risk:** the base delta's sum disagrees with the pre-compaction effective qty.
- **Why it happens:** an off-by-one in summing, or dropping in-flight deltas.
- **Mitigation:** `buildNextEpoch` sums exactly `readItem`'s logic; S8 asserts
  effective qty is unchanged across compaction; the fuzzer checks qty-sum
  preservation on every history.

### R-F1d — Epoch churn

- **Risk:** compaction fires too often, thrashing clients into repeated rebases.
- **Why it happens:** too low a `SYNC_EPOCH_MAX_DELTAS` threshold.
- **Mitigation:** a conservative default (5000 deltas) + a minimum inter-epoch
  interval; epoch id is monotonic so a client rebases at most once per epoch bump.

---

## 3. F2 — Adversarial / lossy-network testing

### R-F2a — Non-determinism / flake

- **Risk:** real network faults make specs flaky, eroding trust in the suite.
- **Why it happens:** timing races between the fault injection and the client's
  backoff reconnect.
- **Mitigation:** bound and seed the faults (fixed throttle profile, deterministic
  `routeWebSocket` close point at `SyncStep2`); assert on the **settled** state via
  `expect.poll`/`expectConvergedWithServer`, never on transient state; enforce a
  **0-failure** budget across `repeat-each=5`. If a scenario cannot be made
  deterministic, it stays out of the gating set and is marked exploratory.

### R-F2b — Testing the harness, not the app

- **Risk:** the fault helper is so artificial it proves nothing about real
  reconnects.
- **Mitigation:** faults use **browser-real** primitives (`context.setOffline`,
  CDP, `routeWebSocket`) rather than app-internal shortcuts; the assertion is the
  *same* `expectConvergedWithServer` as production scenarios.

### R-F2c — Playwright API drift

- **Risk:** `routeWebSocket` is relatively new (Playwright ≥1.48).
- **Mitigation:** the repo is already on `^1.49.1`; pin the minor and cover the
  helper with a trivial self-check so a Playwright bump that changes semantics
  fails loudly.

---

## 4. F3 — Pluggable authoritative persistence

### R-F3a — Over-claiming multi-instance

- **Risk:** presenting a shared SQL row as full high-availability multi-writer,
  when two relays would last-write-wins each other's snapshots.
- **Why it happens:** "it's in Postgres now" sounds like HA.
- **Mitigation:** state the boundary explicitly (`../02-architecture.md §3.3`,
  FR2-18): F3 delivers **durable, shareable** storage and a **documented** path to
  true multi-writer (update-log fan-out via `LISTEN/NOTIFY` / a bus), which it does
  **not** build. The two-instance smoke is labelled a smoke.

### R-F3b — Blob divergence across adapters

- **Risk:** an adapter subtly re-encodes the blob (charset, base64, truncation),
  breaking parity.
- **Mitigation:** every adapter stores raw bytes (`BYTEA`/`LONGBLOB`); the
  adapter-parity test asserts **byte-identical** `Uint8Array` and identical
  decoded `exportItems`.

### R-F3c — Connection/pool failure modes

- **Risk:** a DB outage strands the relay or loses a debounced snapshot.
- **Mitigation:** `save` failures log and retain the in-memory doc (mirroring
  v1.0's file-write error handling); the debounce means at most one window of
  snapshots is at risk, and the live `Y.Doc` remains the authority until the next
  successful flush.

### R-F3d — Regressing the file path

- **Risk:** the refactor behind the interface changes v1.0 file behaviour.
- **Mitigation:** `FileAdapter` is behaviour-preserving; the existing 16/16 suite
  is the regression gate under `SYNC_STORAGE=file`.

---

## 5. F4 — Real background sync

### R-F4a — Browser support is thin (the headline F4 risk)

- **Risk:** the Background Sync API is Chromium-only; iOS Safari and Firefox lack
  it, so "survives tab close" is not universally true.
- **Why it happens:** it is a genuine platform gap, not a bug.
- **Mitigation:** ship F4 as a **progressive enhancement** with a documented
  browser-support matrix; keep reconnect-while-open as the **guaranteed** path.
  The **honest re-scope** (FR2-24 / M-F4b) is an accepted, valid completion — the
  same discipline v1.0 used when it re-scoped the original Background Sync
  deliverable.

### R-F4b — Double-apply on retry

- **Risk:** Background Sync retries a POST that already landed, double-counting.
- **Mitigation:** `POST /rooms/:room/ops` reuses the **ULID-idempotent** reapply
  (shared with `replayJournal`); a re-delivered op is a no-op. Asserted by the F4
  idempotency test.

### R-F4c — Two sync engines fighting

- **Risk:** the HTTP ingest and the WS path race and produce transient
  divergence.
- **Mitigation:** WS stays **primary while open** (FR2-23); the HTTP queue is a
  fallback for the closed-tab case. Both feed the same authoritative `Y.Doc`
  through idempotent ops, so ordering does not matter — convergence is preserved
  regardless of which path a given op arrives on.

---

## 6. Cross-cutting

### R-Xa — Scope creep beyond a portfolio phase

- **Risk:** F1's rebase and F3's multi-instance tempt a slide into building a full
  HA sync product.
- **Mitigation:** the non-goals ([01-overview.md §4](01-overview.md#4-non-goals))
  and the stated boundaries; F3's fan-out and true multi-writer are **documented,
  not built**.

### R-Xb — Presenting targets as results

- **Risk:** the docs' target numbers get read as achievements.
- **Mitigation:** every number is labelled target/baseline; the README carries the
  "planned, not yet built" banner; 2.5 includes a labelling re-scan before
  publishing.

---

## 7. Risk register

Likelihood/impact are qualitative (Low/Med/High). "Impact" is on the v2.0
headline (a correctness guarantee holding after the new stressor).

| ID | Risk | Feature | Likelihood | Impact | Priority | Primary mitigation |
|---|---|---|---|---|---|---|
| **R-F1a** | Resurrection of swept state | F1 | Med | High | **Critical** | Force rebase; replay pending journal ops; `resurrected==0` assert + fuzzer invariant |
| **R-F1b** | Premature compaction strands a peer | F1 | Med | High | **Critical** | Liveness gate (all-synced / quiesced); S10 |
| **R-F4a** | Background Sync browser support thin | F4 | High | Med | High | Progressive enhancement + honest re-scope + support matrix |
| **R-F3a** | Over-claiming multi-instance | F3 | Med | Med | High | State the boundary; document fan-out; label the smoke |
| **R-F2a** | Adversarial flake | F2 | Med | Med | Medium | Bounded/seeded faults; assert settled state; 0-flake budget |
| **R-F1c** | qty-collapse arithmetic drift | F1 | Low | High | Medium | Sum via `readItem` logic; S8 + fuzzer qty-sum check |
| **R-F4b** | Double-apply on retry | F4 | Med | Med | Medium | ULID-idempotent shared reapply |
| **R-F3b** | Blob divergence across adapters | F3 | Low | High | Medium | Raw-bytes storage; byte-identical parity test |
| **R-F3d** | Regressing the file path | F3 | Low | High | Medium | Behaviour-preserving `FileAdapter`; 16/16 regression gate |
| **R-F1d** | Epoch churn / repeated rebases | F1 | Low | Med | Low | Conservative threshold + min inter-epoch interval |
| **R-Xb** | Targets read as results | docs | Med | Low | Low | Explicit target/baseline labelling; status banner |

---

## 8. Cross-cutting guidance

- The two **Critical** risks (R-F1a, R-F1b) are both about F1 and both map to the
  single rule v1.0 wrote down and v2.0 must enforce: **a pre-horizon client
  rebases; it never resurrects.** Guard them with the `resurrected==0` assertion
  and the fuzzer's no-resurrection invariant — not manual review.
- Most v2.0 risks, like v1.0's, are **invisible in the clean, single-instance,
  always-open-tab path** — they surface only under compaction, real faults, a
  shared store, or a closed tab, which is exactly why the adversarial project, the
  epoch fuzzer step, the adapter-parity test, and the tab-close test exist.
- When in doubt about ordering or horizons, prefer **state vectors / CRDT
  metadata** over any timestamp (carrying P6 forward).

# 03 — Requirements (v2.0)

> Functional and non-functional requirements for each of the four v2.0 features,
> the explicit in/out-of-scope boundaries, assumptions, dependencies, and the
> deliverables checklist. Requirement IDs continue the v1.0 numbering
> conventionally (v1.0 used FR-1…FR-14; v2.0 uses **FR2-*** per feature) so the
> two suites never collide. **These are requirements for a planned phase.**

---

## 1. Functional requirements

### F1 — Epoch compaction / GC

| # | Requirement |
|---|---|
| **FR2-1** | **Bounded qty history.** Compaction collapses each live item's `Y.Array<QtyDelta>` to a single base delta `{ d: sum, op: 'epoch-<E>' }`; the effective quantity is unchanged. |
| **FR2-2** | **Tombstone sweep.** Items with `deleted:true` untouched for longer than `SYNC_EPOCH_TOMBSTONE_DAYS` (default = `SNAPSHOT_MAX_AGE_DAYS` = 30) are removed from the compacted epoch doc. |
| **FR2-3** | **Epoch publication.** A compaction increments the room's epoch integer, persists the new doc, captures the **horizon** state vector (`Y.encodeStateVector`), and emits an `epoch-bump` control message to connected clients. |
| **FR2-4** | **Safe rebase.** A client whose local state predates the horizon adopts the new epoch doc and replays **only its still-pending (`synced:0`) journal ops** through the idempotent replay path — it must **never** resurrect a swept tombstone or a collapsed delta. |
| **FR2-5** | **Liveness gate.** Compaction runs only when every connected peer has synced past the checkpoint, **or** the room has quiesced (`SYNC_EPOCH_QUIESCE_MS` with no live peer). |
| **FR2-6** | **Backward compatibility.** Epoch `0` equals the v1.0 room name; an unmodified v1.0 client is an epoch-0 client and continues to work. |
| **FR2-7** | **Trigger policy.** Compaction is triggered by a configurable threshold — total qty deltas in the room `> SYNC_EPOCH_MAX_DELTAS` (default 5000) or on an admin/`/health`-adjacent trigger — **never by wall-clock alone** while a pre-horizon peer is live. |

### F2 — Adversarial / lossy-network testing

| # | Requirement |
|---|---|
| **FR2-8** | **Real network offline.** A `chromium-adversarial` project toggles connectivity with `context.setOffline(true/false)` (true browser-level offline), not `provider.disconnect()`. |
| **FR2-9** | **Throttled reconnect.** At least one scenario reconnects under CDP `Network.emulateNetworkConditions` (bounded throughput/latency) and still converges. |
| **FR2-10** | **Mid-handshake socket kill.** At least one scenario uses `page.routeWebSocket()` to close the WebSocket **during `SyncStep2`**, then relies on the client's built-in backoff reconnect; convergence must still hold. |
| **FR2-11** | **Same invariants.** Adversarial specs assert the identical `expectConvergedWithServer` guarantee as the clean projects — no weaker assertion is accepted for the hostile path. |
| **FR2-12** | **Zero flake budget.** The adversarial project passes across the CI repeat count (`--repeat-each` ≥ 5 on the adversarial specs) with **0** failures. |

### F3 — Pluggable authoritative persistence

| # | Requirement |
|---|---|
| **FR2-13** | **Adapter interface.** A single `StorageAdapter` (`load`/`save`/`list`/`prune`) fronts persistence; the relay never calls `fs` directly for snapshots. |
| **FR2-14** | **Byte-identical blob.** Every adapter persists the **same** `Y.encodeStateAsUpdate(doc)` bytes; no adapter re-serializes decoded items. |
| **FR2-15** | **File parity (regression).** The `file` adapter reproduces v1.0 behaviour exactly; the existing 16/16 suite passes unchanged under `SYNC_STORAGE=file`. |
| **FR2-16** | **SQL adapters.** `postgres` (`pg`) and `mysql` (`mysql2`) adapters persist/reload a room to byte-identical converged state, selected by `SYNC_STORAGE` + `DATABASE_URL`. |
| **FR2-17** | **Durable restart.** With a SQL adapter, a relay restart reloads every room to identical converged state (the F3 analogue of v1.0's load-on-boot). |
| **FR2-18** | **Multi-instance smoke.** A documented two-instance run against one shared SQL store demonstrates convergence through the store, with the multi-writer boundary stated (log fan-out is out of scope). |

### F4 — Real background sync

| # | Requirement |
|---|---|
| **FR2-19** | **HTTP op-ingest.** `POST /rooms/:room/ops` applies a batch of journal ops to the authoritative `Y.Doc` via the shared idempotent reapply logic. |
| **FR2-20** | **Background Sync queue.** A Workbox `BackgroundSyncPlugin('inv-mutations')` queues failed `POST /rooms/*/ops` requests and replays them on the SW `sync` event. |
| **FR2-21** | **Survives tab close.** An op made offline is delivered to the server after reconnect even if the tab was closed in between (asserted against `/rooms/:room/snapshot`) — **on a Background-Sync-capable browser**. |
| **FR2-22** | **Idempotent ingest.** A Background-Sync retry cannot double-apply an op (ULID idempotency, shared with `replayJournal`). |
| **FR2-23** | **WS stays primary.** When the tab is open, `y-websocket` remains the primary sync path; the HTTP queue is a fallback, not a replacement. |
| **FR2-24** | **Honest re-scope path.** If reliable cross-browser Background Sync is not achievable, the deliverable is a README section documenting the browser-support matrix and keeping reconnect-while-open as the guaranteed path (a valid completion). |

### Cross-cutting

| # | Requirement |
|---|---|
| **FR2-25** | **CI.** `test:fuzz` + `test:e2e` (all projects incl. adversarial) run green in GitHub Actions on every push. |
| **FR2-26** | **Notes coverage.** Close the v1.0 gap — add an e2e spec exercising concurrent `editNotes` (`Y.Text`) merge, which no v1.0 spec covers. |

---

## 2. Non-functional requirements

| Category | Target / constraint |
|---|---|
| **Correctness (primary, inherited)** | Every v1.0 guarantee (convergence, no lost writes, no duplicates, defined conflict/tombstone behaviour) still holds after compaction, through interrupted sync, against SQL storage, and across tab close. No v2.0 feature may weaken a v1.0 guarantee. |
| **Bounded growth (F1)** | Compacted snapshot size is a function of **live item count**, not of historical adjustment count (see [05-evaluation-metrics.md](05-evaluation-metrics.md) for the numeric target). |
| **Robustness (F2)** | Convergence is a property of the protocol, not of the clean toggle — proven under real offline/throttle/socket-kill with a zero-flake budget. |
| **Storage parity (F3)** | Byte-identical blob across adapters; SQL round-trip adds no correctness risk over the file path. |
| **Durability (F4)** | Best-effort delivery after tab close on capable browsers; never worse than v1.0 (reconnect-while-open) on incapable ones. |
| **Determinism** | The clean projects stay deterministic; adversarial faults are seeded/bounded so failures are reproducible, not luck. |
| **No GPU** | Unchanged — pure web/distributed-systems + a small DB container for F3. |
| **Cost** | Local dev needs only Node + a Docker Postgres/MySQL for F3; CI uses a service container. |
| **Backward compatibility** | v1.0 clients, rooms, and the `file` default all keep working with zero config. |

---

## 3. In scope

- Server-side **epoch compaction** (qty collapse + tombstone sweep) with the
  **rebase** protocol and its liveness gate.
- A **compaction step added to the property fuzzer** and a dedicated
  `epoch-rebase.spec.ts`.
- A **third Playwright project** (`chromium-adversarial`) with real offline,
  CDP throttling, and `routeWebSocket` mid-handshake kills.
- A **`StorageAdapter`** interface with `file`, `postgres`, and `mysql`
  implementations and an adapter-parity test.
- A **Workbox Background Sync** queue + `POST /rooms/:room/ops` ingest — or the
  documented re-scope.
- A **GitHub Actions CI** workflow running the full suite.
- The **notes-merge e2e spec** that closes a named v1.0 coverage gap.

## 4. Out of scope

- **Any change to the v1.0 CRDT data model** (qty PN-counter, tombstones,
  `Y.Text` notes, per-key merge) beyond the epoch collapse.
- **True HA multi-writer replication** (Raft/Paxos, logical-replication fan-out,
  geo-distribution) — F3 documents the boundary; it does not build past it.
- **Auth / multi-tenancy / RBAC** on the relay.
- **OT / Automerge / turnkey-provider** swaps.
- **Throughput / load benchmarking** — F1 measures *bounding*, not speed.
- **A native app** — the artifact stays a PWA.

## 5. Assumptions

- The v1.0 build is the fixed substrate and remains green; v2.0 only adds.
- Rooms can be long-lived enough that unbounded growth is a real problem (the
  premise of F1).
- The Dexie journal's pending ops are a faithful, durable record of a client's
  unsynced intent (the premise of rebase, FR2-4).
- The target demo browser for F4's strongest claim is **Chromium**; other
  browsers fall back to reconnect-while-open.
- A single shared SQL store is acceptable for F3's durability claim; live
  multi-writer is explicitly deferred.

## 6. Dependencies

| Layer | New v2.0 dependency |
|---|---|
| Compaction (F1) | None beyond Yjs (`encodeStateVector`, `encodeStateAsUpdate`) already present |
| Adversarial tests (F2) | Playwright ≥1.48 `routeWebSocket` / CDP (already on `@playwright/test ^1.49.1`) |
| Persistence (F3) | `pg` (Postgres) and/or `mysql2` (MySQL) in the `server` workspace; Docker for local DBs |
| Background sync (F4) | `workbox-background-sync` (Workbox is already present via `vite-plugin-pwa`) |
| CI | GitHub Actions (+ a Postgres/MySQL service container for the F3 job) |

Full install commands are in [06-environment-setup.md](06-environment-setup.md).

## 7. Deliverables checklist

- [ ] **F1:** `server/src/compaction.mjs` + epoch/horizon/rebase wiring;
      `e2e/specs/epoch-rebase.spec.ts` green; fuzzer compaction step green.
- [ ] **F2:** `chromium-adversarial` project + `net-offline`,
      `throttled-reconnect`, `socket-drop-midsync` specs green, zero flake.
- [ ] **F3:** `StorageAdapter` + `file`/`postgres`/`mysql` adapters;
      adapter-parity test; two-instance smoke documented.
- [ ] **F4:** Workbox `BackgroundSyncPlugin` + `POST /rooms/:room/ops`; tab-close
      delivery test — **or** the honest README re-scope with the support matrix.
- [ ] **Cross-cutting:** GitHub Actions CI green on push; concurrent-notes e2e
      spec added.
- [ ] **Docs/blog:** the v2.0 write-up (epoch/rebase diagram, the adversarial
      "socket drop mid-`SyncStep2`" story, the adapter parity table).

## 8. Acceptance criteria

v2.0 is **done** when:

1. A compacted room + a pre-horizon client **rebase** to identical converged
   state with **0** resurrected records (`epoch-rebase.spec.ts` green).
2. The full S1–S7 catalogue re-passes under `chromium-adversarial`, including a
   socket killed mid-`SyncStep2`, with zero flake.
3. `postgres` and `mysql` adapters produce **byte-identical** converged state vs
   `file`, and a restart reloads it.
4. F4 either delivers a closed-tab edit within the retry window **or** ships the
   documented re-scope with the browser-support matrix.
5. Everything above runs **green in CI**, and every target number is labelled a
   target while every measured number traces to a green run.

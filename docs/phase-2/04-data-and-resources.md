# 04 — Data & Resources (v2.0)

> As in v1.0, this is **not** an ML project — there is no training corpus. The
> "data" of v2.0 is (a) an **expanded catalogue of adversarial + epoch test
> scenarios** and (b) the **new datastores, drivers, services, and hardware** the
> four features require, with sourcing and licensing notes. Mirrors
> [../04-data-and-datasets.md](../04-data-and-datasets.md), extended for v2.0.

---

## 1. The "datasets" are still test scenarios

v1.0's ground truth is its scenario catalogue (S1–S7 + the qty delta-counter),
each automated in Playwright and each also fuzzed over 1500 random histories. v2.0
**keeps every one of those** and adds new scenarios that exercise the four v2.0
capabilities. Nothing here is pulled from Hugging Face; there are no labels, no
splits.

---

## 2. New scenario catalogue (v2.0)

Continuing the v1.0 `S*` numbering for the new correctness scenarios and adding
a `NET*` family for the adversarial network faults.

### F1 — Epoch compaction scenarios

#### S8 — Compaction preserves converged state

- **Setup:** A room accumulates many qty adjustments and a tombstoned item, all
  synced. The compactor runs (qty collapse + tombstone sweep).
- **Expected:** Every *live* client's effective state is unchanged after
  compaction — same visible items, same effective qty; only history shrinks.
- **Exercises:** `buildNextEpoch` correctness; qty-sum invariance.

#### S9 — Pre-horizon client rebases (the headline F1 proof)

- **Setup:** Client A goes offline and makes adjustments/edits. While A is
  offline, the room compacts at epoch *E* (sweeping an item A had *also* edited,
  and collapsing deltas A contributed to). A reconnects **behind the horizon**.
- **Expected:** A **rebases** — adopts `doc_(E)`, replays only its pending journal
  ops, and converges with **0 resurrected** tombstones/deltas; A's still-unsynced
  offline adjustment lands exactly once; `qty = compacted_base + A's own deltas`.
- **Exercises:** The rebase protocol (FR2-4), journal-as-substrate, idempotency.
- **Automated by:** `e2e/specs/epoch-rebase.spec.ts` (the single most important
  new spec in the repo).

#### S10 — No premature compaction

- **Setup:** A pre-horizon peer is **still connected** but has not synced past the
  checkpoint.
- **Expected:** The liveness gate (FR2-5) **blocks** compaction until that peer
  catches up or disconnects.
- **Exercises:** The liveness gate; the anti-resurrection guarantee at its edge.

### F2 — Adversarial network scenarios

Each reuses an existing S1–S7 spec body under the `chromium-adversarial` project;
the difference is the connectivity primitive.

| ID | Fault injected | Reused scenario | Expected |
|---|---|---|---|
| **NET1** | `context.setOffline(true)` (real browser offline) | S2 different-field, S-qty delta-counter | Same convergence as the clean path |
| **NET2** | CDP `Network.emulateNetworkConditions` throttle on reconnect | S5 long-offline queue (50 ops) | Queue drains + converges despite slow link |
| **NET3** | `routeWebSocket()` **closes the socket during `SyncStep2`**, backoff reconnects | S6 three-way merge | Convergence survives the interrupted handshake |
| **NET4** | Repeated connect/drop flapping during drain | S3 offline-create idempotent | Still exactly N records, no duplicates |

### Coverage-gap closure

#### S11 — Concurrent notes merge (closes a v1.0 gap)

- **Setup:** A and B, offline, edit **different regions** of the same item's
  `Y.Text` notes; reconnect.
- **Expected:** Both edits survive (character-level `Y.Text` merge) — the
  `editNotes` path (`app/src/crdt/ops.ts`) that v1.0 shipped but **never covered
  with a spec**.
- **Automated by:** `e2e/specs/concurrent-notes.spec.ts` (new).

### Scenario → guarantee mapping (v2.0 additions)

| Scenario | Guarantee proven | Verified by |
|---|---|---|
| **S8** Compaction preserves state | Compaction is state-preserving | Playwright + fuzzer step |
| **S9** Pre-horizon rebase | No resurrection; rebase correctness | `epoch-rebase.spec.ts` |
| **S10** No premature compaction | Liveness gate | Playwright |
| **NET1–NET4** | Convergence under real faults | `chromium-adversarial` |
| **S11** Concurrent notes | `Y.Text` character-merge | `concurrent-notes.spec.ts` |

---

## 3. New datastores & their schemas (F3)

The only genuinely *new persisted data* in v2.0 is the SQL snapshot store. The
blob is unchanged — it is the same `Y.encodeStateAsUpdate(doc)` bytes v1.0 writes
to `data/<room>.yss`.

### Postgres (`pg`)

```sql
CREATE TABLE room_snapshots (
  room       TEXT PRIMARY KEY,
  epoch      INTEGER NOT NULL DEFAULT 0,
  snapshot   BYTEA   NOT NULL,   -- verbatim encodeStateAsUpdate blob
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### MySQL (`mysql2`)

```sql
CREATE TABLE room_snapshots (
  room       VARCHAR(128) PRIMARY KEY,
  epoch      INT NOT NULL DEFAULT 0,
  snapshot   LONGBLOB NOT NULL,  -- verbatim encodeStateAsUpdate blob
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**Seed / fixture data:** none required. Rooms are created on demand exactly as in
v1.0; the adapter-parity test writes a known room and reads it back. Local dev
uses a throwaway database (`offline_pwa`) in a Docker container; CI uses a service
container that is discarded after the run. No production data, no PII.

---

## 4. External resources, tools & services

| Resource | Used by | Sourcing | License |
|---|---|---|---|
| **Yjs** `encodeStateVector` / `encodeStateAsUpdate` | F1 epoch/horizon | already a dependency (`yjs ^13.6.20`) | MIT |
| **Playwright** `routeWebSocket` / CDP session | F2 | already a dependency (`@playwright/test ^1.49.1`) | Apache-2.0 |
| **`pg`** (node-postgres) | F3 Postgres adapter | npm | MIT |
| **`mysql2`** | F3 MySQL adapter | npm | MIT |
| **PostgreSQL** server | F3 dev/CI | Docker image `postgres:16` | PostgreSQL License (permissive) |
| **MySQL** server | F3 dev/CI | Docker image `mysql:8` | GPLv2 (server; client drivers are separate/MIT) |
| **`workbox-background-sync`** | F4 | npm (Workbox already present via `vite-plugin-pwa ^0.21.1`) | MIT |
| **GitHub Actions** | CI | GitHub-hosted runners | per GitHub terms |

All new npm dependencies are permissively licensed (MIT/Apache-2.0). The MySQL
**server** is GPLv2, but it runs as an external service (Docker) and is not linked
into the app; the `mysql2` **driver** is MIT. Postgres is under the permissive
PostgreSQL License. No dataset licensing applies — there is no dataset.

---

## 5. Hardware & environment fit

- **No GPU** — unchanged from v1.0; this remains a pure web/distributed-systems
  project.
- **F1/F2/F4:** run on the same footprint as v1.0 — Node 18+ and the Chromium
  Playwright installs. No new services.
- **F3:** adds **one local database container** (Postgres or MySQL) for dev and a
  **service container** in the F3 CI job. ~256 MB RAM for the DB; trivial disk.
- **CI:** GitHub-hosted `ubuntu-latest` runner; the F3 job attaches a
  `services:` database. The fuzzer + Playwright projects fit comfortably in a
  standard runner (v1.0 already runs the fuzzer's 1500 histories in seconds under
  `node --test`).

---

## 6. Data-generation for the fuzzer (F1 extension)

The property fuzzer (`fuzz/crdt-convergence.fuzz.mjs`) already **generates** its
own data: `fast-check` produces random operation histories over N Yjs replicas.
F1 extends the generator with a **random compaction point** — at a random heal in
the history, run `buildNextEpoch` on the merged doc, then continue the history and
assert the three invariants (convergence, qty=sum, tombstone) **plus** a fourth:
**no resurrection** (a swept tombstone never reappears; a collapsed delta-sum is
preserved). This is generated data, not sourced data — the same discipline as
v1.0, extended to cover the compaction surface a human would never hand-write.

---

## 7. What this is *not* (unchanged from v1.0)

- Not an ML dataset — no Hugging Face, no labels, no splits.
- Not a load/throughput benchmark — F1's size numbers measure **bounding**.
- Not a manual demo — every scenario, old and new, is **automated** so the proof
  stays reproducible.

See [05-evaluation-metrics.md](05-evaluation-metrics.md) for the precise
assertions and the target numbers, and [06-environment-setup.md](06-environment-setup.md)
for how to stand up the Postgres/MySQL services.

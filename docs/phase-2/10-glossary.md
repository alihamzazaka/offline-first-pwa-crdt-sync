# 10 — Glossary (v2.0)

> One clear sentence for every **new** term v2.0 introduces. Terms already defined
> in the Phase 1 glossary ([`../10-glossary.md`](../10-glossary.md)) — CRDT,
> Yjs, `Y.Map`/`Y.Array`/`Y.Text`, PN-counter, tombstone, LWW, convergence,
> eventual consistency, `y-websocket`, `y-indexeddb`, Service Worker, Workbox,
> offline-first, snapshot (`.yss`), state vector (intro'd there) — are not
> repeated; this list is the v2.0 delta.

---

### Epoch compaction / GC (F1)

- **Epoch** — a numbered checkpoint boundary; all deltas/edits before it are
  collapsed into a single compacted base state so the room's history stops growing.
- **Epoch checkpoint** — the server-produced compacted snapshot at an epoch: each
  item's `qty` delta array reduced to one base entry, aged tombstones dropped,
  tagged with the epoch number and the state vector at the horizon.
- **Horizon** — the point in history before which state has been compacted away; a
  client whose local state predates the horizon cannot be merged delta-by-delta and
  must rebase.
- **Rebase (vs resurrect)** — bringing a pre-horizon client forward by re-basing
  its un-synced local edits onto the compacted base, **without** re-introducing
  items/deltas the epoch already collapsed (which would be a *resurrection* bug —
  the exact failure the F1 test guards against).
- **Compaction invariant** — the property F1 must preserve: the effective state
  after compaction is byte-identical to the pre-compaction state for every live
  item; compaction changes representation, never meaning.
- **Delta collapse** — replacing a `Y.Array` of N signed `qty` deltas with a single
  delta equal to their sum, once no un-synced client can still be carrying an
  earlier delta.
- **Tombstone GC** — dropping delete-tombstones older than the horizon, safe only
  once every client is known to be past that epoch.
- **Monotonic growth** — the v1.0 property being fixed: `data/<room>.yss`, the
  qty-delta arrays, and the tombstone set only ever grew.

### Adversarial / lossy-network testing (F2)

- **`chromium-adversarial`** — the planned second Playwright project that runs the
  convergence specs under real network faults instead of the clean in-app
  `OfflineToggle`.
- **`context.setOffline`** — Playwright's real network-layer offline switch (drops
  the browser context's connectivity), vs v1.0's app-level `provider.disconnect()`.
- **CDP throttling** — Chrome DevTools Protocol `Network.emulateNetworkConditions`;
  imposes real latency/bandwidth caps to test sync under slow links.
- **`routeWebSocket`** — Playwright's WebSocket interception API used to **kill the
  socket mid-handshake** (during `SyncStep2`) and assert the relay + client
  recover.
- **`SyncStep1` / `SyncStep2`** — the two phases of the Yjs sync handshake
  (state-vector exchange, then missing-update delivery); F2 interrupts the second.
- **Interrupted sync** — a sync torn down after `SyncStep1` but before all updates
  land; convergence must still hold after reconnect — the core F2 assertion.
- **Fault injection** — deliberately introducing drops/throttling/partitions to
  prove the happy-path `disconnect()` result generalises (a Jepsen-style method).

### Pluggable authoritative persistence (F3)

- **`StorageAdapter`** — the planned interface (`load(room)` / `persist(room,
  update)`) with `file`, `postgres`, and `mysql` implementations, all writing the
  **same** `encodeStateAsUpdate` binary blob.
- **`encodeStateAsUpdate` blob** — the Yjs binary document-update the server
  persists; identical across adapters so the CRDT model is storage-agnostic.
- **Authoritative store** — the server-side source of truth for a room's converged
  state; v1.0's is a single-process file snapshot, v2.0's can be a shared database.
- **Multi-instance** — running more than one sync-server process against a shared
  authoritative DB; F3's persistence adapter is the precondition (not itself a
  multi-instance deliverable).
- **Transactional upsert** — the Postgres adapter's atomic write-or-replace of a
  room blob, the database analogue of the file adapter's temp-file+rename.

### Real Background Sync (F4)

- **Background Sync** — the browser capability (via a Service Worker `sync` event)
  that retries queued work **after the tab is closed**; v1.0 only retried via
  `y-websocket` reconnect while the tab was open.
- **`BackgroundSyncPlugin`** — the Workbox module that queues failed requests in
  IndexedDB and replays them when connectivity returns, on the `sync` event.
- **Background-sync queue** — the durable IndexedDB queue of pending offline ops
  awaiting replay to `POST /rooms/:room/ops`.
- **Close-the-tab-then-sync** — the concrete F4 acceptance scenario: make edits
  offline, close the tab, restore connectivity, and confirm the edits reach the
  server without the tab being reopened.
- **Honest re-scope** — the F4 fallback: if browser support proves too thin
  (one-shot Sync is Chromium-only), the README states the limitation plainly rather
  than implying a capability that is not shipped.

### Cross-cutting

- **CI (continuous integration)** — the planned GitHub Actions workflow running
  `test:fuzz` + `test:e2e` on every push, making the "proven reproducibly" claim
  literally true instead of a manual local run.
- **Seniority ordering** — the roadmap's sequencing of the four features by
  distributed-systems depth; the epoch compaction / rebase work (F1) is the
  deepest and is documented first.

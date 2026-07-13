# 09 — References (v2.0)

> Papers, standards, tools, and datasets each v2.0 feature relies on, with
> canonical identifiers where known. This extends the Phase 1 reference list
> ([`../09-references.md`](../09-references.md)) — items already cited there
> (Yjs, CRDTs, `y-websocket`, `y-indexeddb`, Workbox, Playwright, Automerge,
> the PN-Counter) are not repeated except where v2.0 uses them differently.
> **Verify every identifier before publishing** — where an exact arXiv id / repo /
> spec revision is uncertain it is flagged, per the Phase 1 "do not fabricate ids"
> rule.

---

## F1 — Epoch compaction / garbage collection

- **A Comprehensive Study of Convergent and Commutative Replicated Data Types** —
  Shapiro, Preguiça, Baquero, Zawirski. INRIA RR-7506, 2011. *(The foundational
  CRDT taxonomy; the theory behind why compaction must preserve convergence.)*
- **Delta State Replicated Data Types** — Almeida, Shoker, Baquero.
  arXiv:1603.01529 (JPDC 2018). *(Delta/anti-entropy CRDTs — the model for
  collapsing a delta history into a compacted base without losing convergence.)*
- **Yjs internals — document updates, state vectors, and `snapshot` / garbage
  collection** — the Yjs docs + `yjs` source (`encodeStateAsUpdate`,
  `encodeStateVector`, `Snapshot`, `gc`). *(docs.yjs.dev; the epoch checkpoint is
  built on Yjs state vectors + update encoding — verify the current API.)*
- **`Y.UndoManager` / deleteSet & tombstone handling in Yjs** — background for why
  deletes are retained and how an epoch horizon can safely drop aged tombstones.
- **Anti-entropy / Merkle-tree reconciliation** (Dynamo-style) — context for the
  rebase-past-horizon protocol where a stale client must catch up from a checkpoint
  rather than replay its whole local history. *(Amazon Dynamo, SOSP 2007.)*

## F2 — Adversarial / lossy-network testing

- **Jepsen** — Kyle Kingsbury's distributed-systems fault-injection methodology
  (network partitions, socket kills, clock skew) — the inspiration for the
  mid-handshake socket-drop scenarios. *(jepsen.io; methodology, not a library
  dependency.)*
- **Playwright network control** — `BrowserContext.setOffline`, `page.route` /
  `context.routeWebSocket` (WebSocket interception + mocking), and CDP
  `Network.emulateNetworkConditions` for throttling. *(playwright.dev API docs;
  `routeWebSocket` is the key new API for killing a socket during `SyncStep2` —
  verify it is in the pinned Playwright version.)*
- **Chrome DevTools Protocol — Network domain** (`emulateNetworkConditions`,
  `Network.enable`) — the throttling/offline primitives Playwright wraps.
  *(chromedevtools.github.io/devtools-protocol.)*
- **The Yjs sync protocol (`y-protocols/sync`)** — `SyncStep1` (state-vector
  exchange) / `SyncStep2` (missing-update delivery) / `Update` messages; the exact
  handshake F2 interrupts. *(github.com/yjs/y-protocols.)*

## F3 — Pluggable authoritative persistence

- **PostgreSQL** — the named authoritative store (v17); `BYTEA` column for the
  `encodeStateAsUpdate` blob, transactional upsert per room. *(postgresql.org.)*
- **`y-leveldb` / `y-redis` / database provider pattern** — existing Yjs
  server-persistence providers; the reference design for a `StorageAdapter` that
  writes the same binary update blob to a different backend.
  *(github.com/yjs/y-leveldb; verify current API.)*
- **`node-postgres` (`pg`)** — the Node Postgres driver for the Postgres adapter.
  *(node-postgres.com.)*
- **Write-ahead / debounced-snapshot persistence** — background for the atomic
  temp-file+rename the file adapter uses and the transactional equivalent the
  Postgres adapter must match.

## F4 — Real Background Sync

- **Web Background Synchronization** — W3C Community Group draft; the
  `SyncManager` / `sync` event that lets a Service Worker retry after the tab
  closes. *(wicg.github.io/background-sync; verify current status — one-shot Sync
  is Chromium-only, Periodic Background Sync is separate.)*
- **Workbox `BackgroundSyncPlugin` / `Queue`** — the library that queues failed
  requests in IndexedDB and replays them on the `sync` event.
  *(developer.chrome.com/docs/workbox/modules/workbox-background-sync.)*
- **Service Workers** — W3C spec; the lifecycle (install/activate/fetch/sync) the
  background-sync queue runs inside. *(w3.org/TR/service-workers.)*
- **MDN — Background Synchronization API** — the practical browser-support matrix
  that decides whether F4 ships or is honestly re-scoped.
  *(developer.mozilla.org.)*

## Tools (new or newly-used in v2.0)

- **Playwright** — `routeWebSocket`, `setOffline`, CDP throttling (F2); a second
  project in `playwright.config.ts` (`chromium-adversarial`).
- **PostgreSQL 17 + `pg`** — the F3 backend and driver; run locally or via Docker.
- **Workbox** (already in the PWA stack) — `BackgroundSyncPlugin` for F4.
- **GitHub Actions** — the CI runner (cross-cutting) executing `test:fuzz` +
  `test:e2e` headless on every push.
- **`fast-check`** (already used by the fuzzer) — extended with epoch/compaction
  commands for F1's property tests.

---

*Identifiers (arXiv ids, repos, spec revisions, browser-support facts) are
reproduced to the best available knowledge and **must be verified** before they
appear in the shipped README, blog post, or write-up. Where an exact id or the
current browser-support status is uncertain the item is named and flagged rather
than fabricated — same rule as [`../09-references.md`](../09-references.md).*

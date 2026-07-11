# 10 — Glossary

> Every domain term relevant to this project, one clear sentence each.

---

## Core conflict-resolution terms

- **CRDT (Conflict-free Replicated Data Type)** — a data type whose concurrent edits are
  mathematically guaranteed to converge to the same result on every replica without
  coordination.
- **OT (Operational Transform)** — a conflict-resolution technique (famously behind Google
  Docs / Wave) that transforms concurrent operations against each other so they can be
  applied in any order; powerful but complex to implement correctly.
- **LWW (Last-Write-Wins)** — the naive strategy where the most recent write overwrites the
  others; simple but causes silent data loss under concurrency.
- **Vector clock** — a per-replica set of logical counters used to determine the causal
  ordering of events across distributed clients (whether one edit happened-before another,
  or they are concurrent).
- **Logical clock** — a monotonically increasing counter that orders events by causality
  rather than by (unreliable) wall-clock time.
- **Clock skew** — the disagreement between different devices' wall-clock times, which
  makes timestamp-based ordering unreliable.
- **Convergence** — the property that, after any interleaving of edits and syncs, all
  replicas and the server reach identical state.
- **Field-level merge** — reconciling a record by merging per-field, so concurrent edits to
  *different* fields both survive.
- **Tombstone** — a marker recording that an item was deleted, kept so that a
  delete-vs-edit race resolves to a defined, deterministic outcome.
- **Idempotency** — the property that replaying the same operation more than once has the
  same effect as applying it once (no duplicates on retry/replay).
- **Op / operation** — a single captured change (create/update/delete) carrying a stable
  client-generated ID, queued locally and replayed on reconnect.
- **Three-way merge** — reconciling divergence among three parties (Client A, Client B, and
  the server) into one converged state.

---

## Offline / local-first terms

- **Local-first software** — an architecture where the app reads/writes local storage first
  (instant, offline-capable) and syncs in the background, rather than depending on the
  network for every operation.
- **Offline mutation queue** — a durable local queue of pending operations captured while
  disconnected, drained to the server on reconnect.
- **IndexedDB** — the browser's structured, transactional, versioned client-side database
  used for durable local persistence.
- **Dexie.js** — an ergonomic wrapper library over IndexedDB (with its own optional sync
  addon).
- **idb** — a small, low-level promise-based wrapper over the raw IndexedDB API.
- **Storage eviction** — the browser reclaiming a site's storage under device pressure,
  which local-first apps must handle gracefully.

---

## PWA / service worker terms

- **PWA (Progressive Web App)** — an installable, offline-capable web app backed by a
  service worker and a Web App Manifest.
- **Service Worker** — a background script that intercepts network requests, precaches the
  app shell, and enables offline behavior and Background Sync.
- **Workbox** — a library/toolkit that simplifies building service workers, including
  precaching and Background Sync.
- **Background Sync API** — a browser API that lets a service worker retry queued/failed
  operations automatically when connectivity returns, even after the tab is closed.
- **Web App Manifest** — the JSON metadata file that makes a web app installable
  (name, icons, display mode, etc.).
- **App shell** — the minimal HTML/CSS/JS needed to render the UI frame, precached so the
  app loads offline. (Caching only the shell is *not* sync — see "fake offline.")
- **skipWaiting / clientsClaim** — service-worker lifecycle controls that make a new worker
  activate and take control immediately; used carefully to manage cache updates without
  disrupting an active session.
- **BroadcastChannel** — a browser API for messaging between tabs of the same origin, used
  to keep multiple tabs on one device consistent.

---

## Sync / transport terms

- **Sync engine** — the component that pushes local ops/CRDT updates to the server and
  pulls remote updates back down to converge state.
- **WebSocket** — a persistent bidirectional transport (e.g. `y-websocket`) used for
  real-time sync and merge relay.
- **HTTP sync endpoint** — a simpler, periodic (batchy) alternative transport to
  WebSockets for pushing/pulling changes.
- **Authoritative store** — the server-side database (MySQL/Postgres) that persists the
  converged, canonical state.
- **y-indexeddb / y-websocket / y-webrtc** — Yjs companion packages for local persistence,
  WebSocket transport, and peer-to-peer WebRTC transport respectively.
- **automerge-repo** — Automerge's repository/sync-protocol layer for managing and syncing
  documents.

---

## Project-specific terms

- **Fake offline** — the shallow, common pattern of caching only the app shell so the page
  loads offline but cannot reconcile concurrent writes; explicitly *not* the bar for this
  project.
- **Concurrent-edit scenario** — a defined test case (two+ clients editing offline) with a
  documented expected outcome; the "dataset" of this project.
- **Money table** — the SPEC's core proof table mapping each concurrent-edit scenario to
  its expected outcome and its Playwright verification.
- **Queue-drain time** — the time taken to replay/flush the offline mutation queue after a
  long disconnected period (an optional secondary metric).
- **Sync latency** — the time from reconnect to full convergence across replicas (an
  optional secondary metric).
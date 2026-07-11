# 03 — Requirements

> Functional and non-functional requirements, explicit in-scope / out-of-scope boundaries, assumptions, dependencies, and the concrete deliverables checklist.

---

## 1. Functional requirements

The system must:

| # | Requirement |
|---|---|
| **FR-1** | **Local-first CRUD.** The UI reads and writes a local IndexedDB store first, so every operation is instant and works with the network off. |
| **FR-2** | **Installable PWA.** Provide a Web App Manifest + service worker (Workbox) so the app is installable and its shell loads offline. |
| **FR-3** | **Offline mutation queue.** When offline (or on a failed request), capture each change as an operation and persist it durably in a queue. |
| **FR-4** | **Idempotent op IDs.** Every operation carries a stable, client-generated ID so replay on reconnect produces **no duplicates**. |
| **FR-5** | **Background sync.** On reconnect, automatically retry/drain the queue via the Background Sync API — even if the tab was closed. |
| **FR-6** | **Convergent merge.** Concurrent offline edits reconcile on reconnect: CRDT convergence (Yjs/Automerge) or a documented app-level conflict rule. |
| **FR-7** | **No lost writes.** Concurrent edits to **different fields** of the same record both survive. |
| **FR-8** | **Defined same-field conflict behavior.** Concurrent edits to the **same field** resolve to a defined result (automatic) or are **surfaced to the user** via a conflict UI. |
| **FR-9** | **Defined delete-vs-edit behavior.** A delete racing an edit resolves via a documented **tombstone** outcome. |
| **FR-10** | **Ordered long-offline replay.** A long queue of offline ops replays correctly and in order. |
| **FR-11** | **Three-way merge.** A, B, and the server can all diverge and still converge to one identical state. |
| **FR-12** | **Cross-tab concurrency.** Multiple tabs on one device are treated as a concurrency source and stay consistent (BroadcastChannel / shared persistence). |
| **FR-13** | **Conflict UX (non-CRDT).** For app-level records, show a conflict banner / field-level merge view where the outcome is genuinely ambiguous. |
| **FR-14** | **Visible convergence demo.** Provide UI that lets a viewer *watch* two offline edits merge on reconnect. |

---

## 2. Non-functional requirements

Correctness is the headline; the rest support it.

| Category | Target / constraint |
|---|---|
| **Correctness (primary)** | Convergence after any offline-edit interleaving; zero lost writes; zero duplicates; defined conflict behavior. This is what the project is judged on. |
| **User-perceived write latency** | Local-storage speed — writes never block on the network (local-first). |
| **Sync latency (background)** | Reasonable convergence time after reconnect; measured, not hand-waved (optional metric). |
| **Queue-drain time (background)** | Bounded drain time after long offline periods (optional metric). |
| **Offline availability** | App remains **fully usable** with the network completely off. |
| **Reproducibility** | Every correctness claim is backed by an automated Playwright multi-context test any reviewer can run. |
| **Durability** | Local data (queue + CRDT/state) survives reloads, tab close, and offline periods via IndexedDB. |
| **Storage robustness** | Handle IndexedDB versioning/migrations and storage eviction under pressure gracefully. |
| **Cache freshness** | Version service-worker caches; have a safe update strategy (skipWaiting/clientsClaim used carefully). |
| **Hardware** | **No GPU.** Runs on ordinary dev hardware + a small Node backend + a DB. |
| **Cost** | Deployable on Vercel/Netlify free/low tiers + a small server (or a local-first provider's sync service). |
| **CRDT growth** | For long-lived docs, plan snapshotting/compaction so history does not grow unbounded. |

---

## 3. In scope

- A single, concrete **demo domain** (e.g. inspection forms, notes/kanban, POS/inventory,
  or survey collection).
- Local-first CRUD over **IndexedDB (Dexie.js)**.
- An **installable PWA** (manifest + Workbox service worker) that loads offline.
- An **offline mutation queue** with idempotent op IDs and **Background Sync** retry.
- A **conflict-resolution layer**: CRDT (Yjs/Automerge) **or** app-level field-level merge
  + vector clocks — chosen deliberately and documented.
- A **conflict UI** (banner / field-level merge view) for non-CRDT ambiguous cases.
- A **Playwright multi-context correctness suite** covering every scenario in
  [04-data-and-datasets.md](04-data-and-datasets.md).
- A **demo video** and a **README/blog** write-up.

---

## 4. Out of scope

- **Fake offline as the deliverable** — merely caching the shell is explicitly *not* the
  bar; correct reconciliation of concurrent writes is.
- **ML / model inference** — there is none; "datasets" here are **test scenarios**, not ML
  data.
- **Full production auth / multi-tenant infrastructure / RBAC** — unless trivially part of
  the chosen demo domain.
- **Rich real-time text editor via hand-rolled OT** — OT is noted as the complex
  alternative; not required (CRDT is the recommended path for text).
- **High-throughput / scalability benchmarking** — correctness, not throughput, is the
  headline.
- **Cross-platform native apps** — the artifact is a PWA.

---

## 5. Assumptions

- The target users genuinely operate in **low- or intermittent-connectivity** conditions,
  so offline-first is a real requirement, not a gimmick.
- Concurrent edits to the same record are **expected**, not exceptional — that is exactly
  the case the design must handle.
- **Wall-clock time cannot be trusted** for ordering across devices; logical/vector clocks
  or CRDT metadata are used instead.
- Modern browsers with **IndexedDB, Service Worker, and Background Sync** support are the
  deployment target.
- A single **authoritative server store** (MySQL/Postgres) is acceptable as the durable
  source of truth.

---

## 6. Dependencies

| Layer | Dependency |
|---|---|
| App / PWA | Next.js / React (or Vue) |
| Local store | IndexedDB via **Dexie.js** (or idb) |
| CRDT / sync | **Yjs** (+ `y-indexeddb`, `y-websocket`/`y-webrtc`) or **Automerge** (+ automerge-repo); optionally **ElectricSQL / PowerSync / RxDB / TinyBase / Dexie Cloud** |
| Service worker | **Workbox** + **Background Sync API** |
| Transport | WebSocket (`y-websocket`) or an HTTP sync endpoint |
| Backend | Node (or a sync provider) |
| Server DB | **MySQL** / Postgres |
| Testing | **Playwright** (multi-context, network throttling/offline) |
| Hosting | Vercel / Netlify + a small server |

Full install commands are in [06-environment-setup.md](06-environment-setup.md).

---

## 7. Deliverables checklist

From the SPEC's "Shareable deliverables":

- [ ] **Live PWA demo** (installable) — open in two windows, go offline, make conflicting
      edits, reconnect, watch the correct merge.
- [ ] **Demo video** of the concurrent-edit merge (the "whoa" moment).
- [ ] **Repo** with the **Playwright correctness suite** anyone can run (the proof).
- [ ] **README / blog**: the conflict model chosen, why, the architecture diagram, and the
      guarantees — plus the failure mode of naive LWW that was avoided.
- [ ] *Optional:* a write-up comparing **Yjs vs Automerge** (or CRDT vs OT) for the use
      case.

---

## 8. Acceptance criteria

The project is **done** when:

1. The PWA installs and is **fully usable with the network off**.
2. Every scenario in [04-data-and-datasets.md](04-data-and-datasets.md) has an automated
   Playwright test and **all are green**.
3. Convergence, no-lost-writes, no-duplicates, and defined conflict behavior are each
   asserted, not just demonstrated.
4. The README/blog documents the chosen conflict model, the architecture, the guarantees,
   and the naive-LWW failure mode avoided.
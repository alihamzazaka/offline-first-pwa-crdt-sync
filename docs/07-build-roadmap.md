# 07 — Build Roadmap

> The phased build plan (Phase 0–4) with objectives, key tasks, and a Definition of Done per phase, plus the week-by-week milestone table and the code skeleton from the SPEC.

---

## Phase 0 — Choose the model (day 1)

**Objective:** Commit to a conflict model before writing sync code.

**Key tasks:**
- Decide **CRDT (Yjs/Automerge)** vs **app-level merge**, based on the domain:
  - **collaborative text → CRDT**
  - **simple records → field-level LWW with vector clocks**
- Pick the **demo domain** (inspection forms / notes-kanban / POS-inventory / survey
  collection).
- **Write the decision down** (in the README), with the reasoning.

**Definition of Done:**
- The chosen conflict model and demo domain are documented with a defended rationale.

---

## Phase 1 — Local-first CRUD (week 1)

**Objective:** Instant, offline-capable local reads/writes and an installable PWA.

**Key tasks:**
- **IndexedDB via Dexie**; the UI **reads/writes local first** (instant, offline).
- Make the PWA **installable** — Web App Manifest + service worker via **Workbox**.

**Definition of Done:**
- App is installable and its shell loads offline.
- All core CRUD works against the local store with the network off.

---

## Phase 2 — Offline queue + background sync (week 1–2)

**Objective:** Durable offline mutation queue that drains correctly on reconnect.

**Key tasks:**
- **Queue mutations when offline**; retry via **Background Sync** on reconnect.
- **Idempotent op IDs** — every op has a stable, client-generated ID (no duplicates on
  replay).

**Yjs offline + sync skeleton (from the SPEC):**

```js
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'

const doc = new Y.Doc()
new IndexeddbPersistence('app-doc', doc)              // offline persistence
const provider = new WebsocketProvider('wss://sync.example', 'room', doc) // syncs + merges
const items = doc.getArray('items')                    // CRDT type; edits converge automatically
provider.on('status', e => console.log(e.status))      // 'connected' | 'disconnected'
```

**Definition of Done:**
- Offline mutations queue durably and replay on reconnect.
- Replaying the same op set produces **no duplicates**.

---

## Phase 3 — Conflict resolution (week 2)

**Objective:** Make convergence real and visible; handle non-CRDT ambiguity.

**Key tasks:**
- **CRDT:** convergence is automatic — build a small UI to **show** it (edit the same item
  in two tabs offline, reconnect, watch it merge).
- **Non-CRDT records:** implement **field-level merge** + a **conflict banner** where
  truly ambiguous.

**Definition of Done:**
- Two offline edits to the same item merge visibly on reconnect (CRDT), or
- Field-level merge + conflict banner resolve/surface non-CRDT conflicts per the
  documented rule.

---

## Phase 4 — Prove it + package (week 3)

**Objective:** Turn correctness claims into a reproducible, green test suite + demo.

**Key tasks:**
- **Playwright multi-context tests** for **every scenario** in
  [04-data-and-datasets.md](04-data-and-datasets.md).
- **Demo video:** two windows, both offline, conflicting edits, reconnect, correct merge.

**Definition of Done:**
- Every scenario has an automated test and the suite is **green**.
- Demo video recorded; README/blog written (chosen model, architecture, guarantees,
  naive-LWW failure mode avoided).

---

## Milestones & timeline

The week-by-week milestone table from the SPEC:

| Week | Milestone |
|---|---|
| **1** | Local-first CRUD + installable PWA offline |
| **2** | Offline queue + background sync + conflict handling working |
| **3** | Playwright correctness suite green; demo + blog shipped |

---

## Phase → deliverable trace

| Phase | Produces | Deliverable |
|---|---|---|
| 0 | Documented conflict-model decision | README section |
| 1 | Installable offline PWA + local CRUD | Live PWA demo (base) |
| 2 | Offline queue + Background Sync | Idempotent replay |
| 3 | Visible convergence + conflict UX | The "whoa" merge demo |
| 4 | Playwright suite + video + write-up | The proof (repo + video + blog) |

See [03-requirements.md](03-requirements.md#7-deliverables-checklist) for the full
deliverables checklist and [05-evaluation-metrics.md](05-evaluation-metrics.md) for how
each phase's output is measured.

---

## Definition of Done (whole project)

- Installable PWA, **fully usable offline**.
- Every scenario in the catalogue automated and **green** in CI.
- Convergence, no-lost-writes, no-duplicates, and defined conflict behavior each
  **asserted**, not just demonstrated.
- README/blog + demo video shipped.
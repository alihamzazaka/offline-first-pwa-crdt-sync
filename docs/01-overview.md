# 01 — Overview

> Problem → solution framing, honest positioning against the current state of the art, why this project is rare and defensible, and the single headline success criterion it is judged on.

---

## 1. Problem → Solution

| | |
|---|---|
| **Problem** | Field workers, warehouse staff, or users on flaky mobile networks lose connectivity constantly. The app must keep functioning offline and, critically, reconcile changes when the network returns — **without losing data when two people edited the same thing**. |
| **Solution** | Local-first architecture: an IndexedDB-backed local store, an offline mutation queue, a service worker with Background Sync, and a CRDT (or well-designed merge) layer that converges concurrent edits on reconnect. Prove correctness with a reproducible concurrent-edit test. |
| **Why it's rare** | Fake offline (cache the shell) is common. **Real bidirectional sync with correct conflict handling** is a serious engineering statement few portfolios make. |

The user-facing promise is simple: the app is **usable with the network completely off**,
every change is **queued locally**, and when connectivity returns the queued changes
**merge correctly** with everyone else's — no silent overwrites, no duplicates, no lost
work.

---

## 2. Honest positioning vs the current state of the art

This is the most important section, and it is deliberately unflashy.

**The rare signal here is _correct conflict resolution_, not "it works offline."**

Most "offline support" you see in portfolios is a **service worker caching the app
shell** so the page *loads* offline. That is a legitimate but shallow capability: it
cannot safely reconcile concurrent writes. The moment two clients (or even two tabs of
one browser) edit the same record while disconnected, **naive last-write-wins destroys
data** — the second sync silently clobbers the first.

Demonstrating **CRDT-based (or well-designed OT) merge with an offline queue and a
visible conflict-resolution story** is genuinely senior distributed-systems work wearing
a web-app costume. It is the difference between "the page opens on the subway" and "two
inspectors filled out the same form underground and both of their answers survived."

### What already exists (so we do not overclaim)

The underlying techniques are **mature and well-supported** — this project is about
*correctly composing and proving* them, not inventing them:

- **CRDTs** are a solved research area (Shapiro et al., "Conflict-free Replicated Data
  Types" — the foundational paper) with production-grade libraries: **Yjs** and
  **Automerge**.
- **Operational Transform (OT)** is battle-tested — it powers **Google Docs / Wave**.
- The philosophy is articulated in **"Local-First Software" (Ink & Switch)** — the
  manifesto behind this whole approach.
- **Turnkey local-first sync** stacks already exist: **ElectricSQL**, **PowerSync**,
  **RxDB**, **TinyBase**, and **Dexie** (+ Dexie Cloud).

So the credible headline is **not** "first offline PWA." It is a **measured, reproducible
correctness result on a named axis**: after arbitrary offline edit interleavings, all
replicas converge, no writes are lost, and no records are duplicated — and I can *prove*
it with a test suite anyone can run.

### The honest headline (verbatim framing from the SPEC)

> *"An offline-first PWA where two clients edit the same data while disconnected and both
> changes survive a correct automatic merge on reconnect — with an offline mutation
> queue, background sync, and a conflict-resolution strategy I can explain and prove with
> a reproducible test."*

---

## 3. Pick your conflict model deliberately

A core part of the honest positioning is that the conflict model is a **stated, defended
choice**, written down in the README. There is no single right answer — only the right
answer *for the chosen domain*.

- **CRDT (Conflict-free Replicated Data Types)** — automatic,
  mathematically-guaranteed convergence; best for collaborative text / structured data.
  Libraries: **Yjs**, **Automerge**. Easiest path to a *correct* result.
- **OT (Operational Transform)** — powers Google Docs; more complex to implement
  correctly.
- **App-level merge / LWW with vector clocks** — simplest, but you must handle conflicts
  explicitly (surface to user or field-level merge). Fine for forms / records; **not**
  for rich collaborative text.

See [02-architecture.md](02-architecture.md#5-key-design-decisions) for the tradeoff
analysis and [10-glossary.md](10-glossary.md) for definitions of each term.

---

## 4. Why it is rare and defensible

- **Fake offline is cheap; real sync is not.** Caching the shell is a checkbox. Correctly
  reconciling concurrent writes forces you to confront logical clocks, idempotency,
  tombstones, replay ordering, and convergence — the actual hard parts of distributed
  systems.
- **It is provable, not hand-wavy.** The artifact's credibility rests on a **reproducible
  correctness test** (Playwright, two browser contexts, offline toggling). Reviewers can
  run it and watch it pass. That is a much stronger signal than a screenshot.
- **The failure mode is memorable.** The demo — two windows, both offline, conflicting
  edits, reconnect, correct merge — is a genuine "whoa, they built that?" moment, and the
  write-up gets to explain the **naive-LWW data-loss bug it avoids**.
- **It ties to real, regionally-relevant work.** Good demo domains include field-worker
  inspection forms, a collaborative notes/kanban app, an offline-capable POS/inventory
  tool (ties to Candela POS / Shopify client work), or a survey-collection app for
  **low-connectivity areas** — a real problem, not a toy.

---

## 5. Good demo domains

Choose one concrete domain and build the whole story around it:

- **Field-worker inspection forms** — structured records, occasional same-field
  conflicts, strong offline requirement.
- **Collaborative notes / kanban app** — collaborative text/structure, the natural home
  for CRDTs.
- **Offline-capable POS / inventory tool** — ties directly to Candela POS / Shopify
  client work; inventory counts are a classic concurrent-edit hazard.
- **Survey-collection app for low-connectivity areas** — regionally relevant; long-offline
  queues that must replay correctly.

---

## 6. Success criteria (the single headline metric + constraint)

Correctness — **not** throughput — is the headline. The project is judged on one thing:

> **After any interleaving of offline edits and reconnects across two or more clients,
> every client and the server converge to identical state, with zero lost writes and zero
> duplicate records, and same-field conflicts resolve per a documented rule — all proven
> by an automated Playwright multi-context test suite that anyone can run.**

Concretely, the win is proven when every scenario in
[04-data-and-datasets.md](04-data-and-datasets.md) is automated and green:

| Success dimension | Definition |
|---|---|
| **Convergence** | After any interleaving of offline edits + reconnects, all clients + server reach identical state (asserted in Playwright). |
| **No lost writes** | Concurrent different-field edits both persist. |
| **No duplicates** | Offline creates replay idempotently. |
| **Defined conflict behavior** | Same-field conflicts resolve per the documented rule (or surface to the user). |
| **Offline UX** | The app remains fully usable with the network off (demonstrated). |
| **Optional** | Sync latency and queue-drain time after long offline periods. |

The full metric definitions, baselines, and the "money table" live in
[05-evaluation-metrics.md](05-evaluation-metrics.md).

---

## 7. Where to go next

- Architecture and design decisions → [02-architecture.md](02-architecture.md)
- What's in and out of scope → [03-requirements.md](03-requirements.md)
- The concurrent-edit test catalogue → [04-data-and-datasets.md](04-data-and-datasets.md)
- How the win is measured → [05-evaluation-metrics.md](05-evaluation-metrics.md)
- How to build it → [07-build-roadmap.md](07-build-roadmap.md)

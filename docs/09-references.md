# 09 — References

> All references from the SPEC — concepts/papers, libraries/tools, and specs — grouped. Canonical identifiers (project domains, package names) are preserved as given in the SPEC. Nothing here is fabricated beyond what the SPEC or common knowledge supports.

---

## 1. Concepts & foundational reading

- **Shapiro et al., "Conflict-free Replicated Data Types"** — the foundational CRDT paper.
- **"Local-First Software" (Ink & Switch)** — the manifesto behind this whole
  local-first approach.
- **Operational Transform background (Google Docs / Wave)** — for the OT alternative to
  CRDTs.

---

## 2. CRDT / sync libraries

- **Yjs** — `yjs.dev` — performant CRDT with a great ecosystem. Companion packages:
  - `y-indexeddb` — local (offline) persistence.
  - `y-websocket` — WebSocket transport (sync + merge relay).
  - `y-webrtc` — peer-to-peer WebRTC transport.
- **Automerge** — `automerge.org` — rich JSON CRDT, plus **automerge-repo** (repo / sync
  protocol).

---

## 3. Turnkey local-first sync

- **ElectricSQL**
- **PowerSync**
- **RxDB**
- **TinyBase**
- **Dexie** (+ **Dexie Cloud**)

These provide local-first sync as a service/library, as an alternative to hand-rolling the
sync layer.

---

## 4. Service worker, storage & PWA tooling

- **Workbox** — service worker toolkit; precaching + **Background Sync** module.
- **idb** / **Dexie.js** — IndexedDB access (low-level primitive vs ergonomic wrapper).

---

## 5. Testing

- **Playwright** — multi-context browser automation with network throttling / offline
  toggling; the designated tool for the reproducible concurrent-edit correctness tests.

---

## 6. Web platform specs (MDN)

- **Service Worker API**
- **Background Sync API**
- **IndexedDB**
- **Web App Manifest**

---

## 7. Grouped quick index

| Group | Entries |
|---|---|
| **Concepts** | CRDT paper (Shapiro et al.); Local-First Software (Ink & Switch); Operational Transform (Google Docs / Wave) |
| **CRDT libs** | Yjs (`y-indexeddb`, `y-websocket`, `y-webrtc`); Automerge (+ automerge-repo) |
| **Turnkey sync** | ElectricSQL; PowerSync; RxDB; TinyBase; Dexie (+ Dexie Cloud) |
| **SW / storage** | Workbox; idb; Dexie.js |
| **Testing** | Playwright |
| **Specs** | MDN: Service Worker API, Background Sync API, IndexedDB, Web App Manifest |

---

> Note: The SPEC cites the CRDT paper and the Local-First Software manifesto by name/author
> and lists library homepages (`yjs.dev`, `automerge.org`). No arXiv IDs, DOIs, or GitHub
> URLs were given in the SPEC, so none are invented here — consult the named sources
> directly for canonical links.
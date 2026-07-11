# 06 — Environment Setup

> Concrete setup: the full tech stack, prerequisites, real install commands, hardware fit, environment config, and a "verify your install" smoke check. **No GPU required.**

---

## 1. Full tech stack

From the SPEC's tech-stack table:

| Layer | Choice | Notes |
|---|---|---|
| **App** | **Next.js / React** or Vue as a **PWA** | Installable, offline-capable. |
| **Local store** | **IndexedDB** via **Dexie.js** (or idb) | Structured local persistence; Dexie has a nice API + its own sync addon option. |
| **CRDT / sync** | **Yjs** (+ `y-indexeddb`, `y-websocket`/`y-webrtc`) or **Automerge** (+ automerge-repo) | Yjs = performant, great ecosystem; Automerge = rich JSON CRDT + repo/sync protocol. Or **ElectricSQL / PowerSync / RxDB / TinyBase** for turnkey local-first sync. |
| **Service worker** | **Workbox** + **Background Sync API** | Precache shell, queue failed mutations, retry on reconnect. |
| **Transport** | WebSocket (`y-websocket`) or HTTP sync endpoint | Real-time or periodic. |
| **Backend** | Node (your stack) or a sync provider | Authoritative store + merge/relay. |
| **Server DB** | Postgres / **MySQL** | Persist converged state. |
| **Conflict UX** | Custom conflict banner / field-level merge view | For non-CRDT records. |
| **Testing** | **Playwright** (multi-context) + network throttling/offline | Reproducible concurrent-edit tests — your proof. |

---

## 2. Hardware fit

> **No GPU.** You need: the PWA + a small sync backend (Node) + a DB, and Playwright for
> the multi-client tests. Deploy on **Vercel/Netlify** + a small server (or use a
> local-first provider's sync service for the backend).

- **GPU:** none — there is no model inference in this project.
- **Dev machine:** any modern laptop/desktop. (A high-end GPU, if present, is
  irrelevant here — this is a pure web/distributed-systems project.)
- **Backend:** a small Node process.
- **DB:** MySQL or Postgres (local Docker container is fine for dev).

---

## 3. Prerequisites

- **Node.js** (LTS, v18+ recommended) and **npm** (or pnpm/yarn).
- **Git**.
- **MySQL** or **Postgres** (local install or Docker).
- A modern browser with **Service Worker**, **IndexedDB**, and **Background Sync** support
  (Chromium-based recommended for Background Sync).
- **Playwright** browsers (installed via its CLI, below).

Verify the basics:

```bash
node --version     # v18+ expected
npm --version
git --version
```

---

## 4. Install steps

> Package names below are the real, published names from the SPEC's stack. Adjust to your
> chosen framework (Next.js/React shown) and conflict model (Yjs shown).

### 4.1 Scaffold the PWA (Next.js + React)

```bash
# create the app
npx create-next-app@latest offline-first-pwa
cd offline-first-pwa
```

### 4.2 Local store (IndexedDB via Dexie)

```bash
npm install dexie
# or the lower-level primitive:
# npm install idb
```

### 4.3 CRDT / sync (Yjs path)

```bash
npm install yjs y-indexeddb y-websocket
# WebRTC transport (optional):
# npm install y-webrtc
```

Automerge path (alternative):

```bash
# npm install @automerge/automerge @automerge/automerge-repo
```

Turnkey local-first providers (alternative to hand-rolled sync):

```bash
# RxDB:        npm install rxdb
# TinyBase:    npm install tinybase
# ElectricSQL / PowerSync / Dexie Cloud: follow their own setup docs
```

### 4.4 Service worker (Workbox + Background Sync)

```bash
npm install workbox-window
npm install --save-dev workbox-cli
# (Background Sync is a browser API used via Workbox's background-sync module)
```

### 4.5 Sync backend (Node + y-websocket server)

```bash
# a minimal WebSocket sync server for Yjs:
npm install ws y-websocket
# y-websocket ships a runnable server entry (HOST/PORT via env)
```

### 4.6 Server DB driver

```bash
# MySQL:
npm install mysql2
# or Postgres:
# npm install pg
```

### 4.7 Testing (Playwright)

```bash
npm install --save-dev @playwright/test
npx playwright install       # download the browser binaries
```

---

## 5. Environment config

Create a `.env` (never commit secrets). Illustrative values:

```bash
# --- sync transport ---
SYNC_WS_URL=ws://localhost:1234        # y-websocket server
SYNC_ROOM=app-doc                      # CRDT room / doc name

# --- database (MySQL example) ---
DATABASE_URL=mysql://user:pass@localhost:3306/offline_pwa

# --- app ---
NEXT_PUBLIC_APP_NAME=offline-first-pwa
```

Run the y-websocket server (dev):

```bash
# typical invocation; HOST/PORT are read from env
HOST=localhost PORT=1234 npx y-websocket
```

Start the app (dev):

```bash
npm run dev
```

---

## 6. Verify your install (smoke check)

Confirm each layer is wired up before building features.

1. **App boots**

   ```bash
   npm run dev
   # open the printed localhost URL; the app renders
   ```

2. **PWA / service worker registers** — in the browser DevTools → *Application* tab:
   - a **service worker** is *activated*,
   - a **Web App Manifest** is detected (installable),
   - toggling **Offline** in DevTools still lets the shell load.

3. **IndexedDB persists** — DevTools → *Application* → *IndexedDB*: your local store /
   `y-indexeddb` database appears and holds data after a reload.

4. **Sync server reachable** — the Yjs provider logs a `connected` status:

   ```js
   provider.on('status', e => console.log(e.status)) // expect 'connected'
   ```

5. **DB reachable** — a trivial connection check with your driver succeeds
   (`mysql2` / `pg` connect).

6. **Playwright runs** — the harness executes:

   ```bash
   npx playwright test
   ```

   Even an empty/placeholder test that opens two contexts and toggles offline confirms the
   multi-context + offline machinery works.

If all six pass, the environment is ready for Phase 1 in
[07-build-roadmap.md](07-build-roadmap.md).

---

## 7. Deployment notes

- **Frontend:** deploy on **Vercel / Netlify** (SSG for the shell is the cleanest offline
  fit — see [02-architecture.md](02-architecture.md#54-ssg-vs-ssr-for-the-shell)).
- **Sync backend:** a small Node/`y-websocket` server on any small host — **or** delegate
  to a local-first provider's sync service.
- **DB:** managed MySQL/Postgres, or a small self-hosted instance.
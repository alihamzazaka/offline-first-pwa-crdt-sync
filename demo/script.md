# Demo — 60-second video shot list

The "whoa, they built that?" clip: two disconnected clients edit the same record,
reconnect, and **both edits survive a correct automatic merge** — the counter
adds up instead of overwriting. Correctness is the story, so the shot that lands
is **Qty = 18** after concurrent offline `+5` and `+3`.

**Setup before recording**
- `npm run dev` running (both servers up). Reset state: stop servers, delete
  `server/data/`, restart; clear site data for `127.0.0.1:5173`.
- Two browser windows side by side, ~equal size:
  - Left  → `http://127.0.0.1:5173/?room=demo&client=A`
  - Right → `http://127.0.0.1:5173/?room=demo&client=B`
- Both status bars show **connected · synced**. Zoom to ~125% so the Qty and the
  status bar are legible. Cursor visible.

**Target length:** 60s. Keep a light lower-third caption per beat.

| # | Time | Shot | On screen | Caption |
|---|------|------|-----------|---------|
| 1 | 0:00–0:06 | Both windows, titles visible | Two clients, same room, both **connected · synced** | "Two clients. One inventory. Same room." |
| 2 | 0:06–0:14 | In **A**, add item SKU `A-1`, Name `Widget`, **Qty 10** → Add | Row appears in **A**, then instantly in **B** | "Live sync — a write in A shows up in B." |
| 3 | 0:14–0:20 | Click **Go offline** in **both** windows | Both status bars flip to **offline (forced)**; dot changes | "Now pull the network on BOTH." |
| 4 | 0:20–0:30 | Select item in both. In **A** set delta `5`, click **+**. In **B** set delta `3`, click **+** | A shows **15**, B shows **13**; **queue: 1** badge on each | "Both count stock offline. +5 here, +3 there." |
| 5 | 0:30–0:36 | (Optional) also edit different fields | A Name → `Widget-A`; B Location → `Aisle-7` | "Different fields, too — no lost writes." |
| 6 | 0:36–0:44 | Click **Go online** in **both** | Status bars → **connected · synced**; **queue** drains to **0** | "Reconnect — watch them merge." |
| 7 | 0:44–0:52 | Hold on the Qty in both windows | **Both show Qty = 18** (10 + 5 + 3); Merge log lists the merges | "Qty = 18. Both adjustments survived." |
| 8 | 0:52–0:57 | Split-caption contrast | Freeze on 18; caption the counterfactual | "Naive last-write-wins would show 15 or 13 — one count lost." |
| 9 | 0:57–1:00 | Cut to terminal | `npm run test:e2e` → green summary "16 passed" | "Every scenario is an automated Playwright test. Reproducible." |

**Director's notes**
- The single most important frame is **#7: Qty = 18 in both windows**. Let it
  breathe for ~3s. That number is the entire proof that this is real sync, not a
  cached shell.
- Keep both windows in frame the whole time — the audience must see the two
  states diverge (15 vs 13) and then reconcile (18/18).
- Don't narrate the internals during the clip; the on-screen captions carry it.
  Save "delta-counter / CRDT / tombstones" for the README/blog.
- Optional B-roll tail (not counted in the 60s): a delete-vs-edit take — delete
  in A while editing in B, reconnect, item disappears everywhere but the edit is
  preserved under the tombstone (`curl .../rooms/demo/snapshot`).

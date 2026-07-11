# Image prompts — Project 06 — Offline-First PWA + CRDT Sync

> A provably-correct offline sync app using CRDTs. Images: the lost-write problem, CRDT merge, the delta-counter, the sync relay + tombstones, the concurrency test suite, and the converged result.

**How to use:** paste any prompt below into Claude (or Midjourney / DALL·E / Ideogram). Each already ends with the shared style suffix so all images across the six projects read as one series. Generate at 1792×1024 (or 1024×1024 for a square variant). If the tool adds text anyway, append *"absolutely no typography of any kind"*.

These illustrate **how the problem is solved** — problem → method stages → result — not just a hero shot.

---

## Image 1 — The problem: concurrent offline edits lost
*Suggested placement: hero / section 1*

> Two laptops back-to-back, each sealed inside its own dark 'offline' bubble, both editing their own glowing copy of the same inventory card. When the bubbles touch on reconnect, a naive collision occurs — one card violently overwrites the other and half its data dissolves away as faded coral particles. Convey silent data loss under last-write-wins. — clean modern technical illustration, flat vector style, isometric where it helps, white background, restrained palette of deep teal (#1D9E75), coral (#D85A30) and slate gray (#5F5E5A) with a single blue accent, subtle depth, no gradients-as-decoration, crisp thin outlines, no text, no words, no letters, no numbers, no logos, no UI chrome, highly detailed, professional documentation / research-paper figure aesthetic, 1792x1024

## Image 2 — The idea: conflict-free merge
*Suggested placement: section 3 / method / key*

> The same two offline card-copies, but now on reconnect the two versions rise and interlock in mid-air like a zipper of teal light, every field from both sides preserved and combined into one perfect merged card — no overwrite, nothing lost. Convey a mathematically guaranteed conflict-free merge. — clean modern technical illustration, flat vector style, isometric where it helps, white background, restrained palette of deep teal (#1D9E75), coral (#D85A30) and slate gray (#5F5E5A) with a single blue accent, subtle depth, no gradients-as-decoration, crisp thin outlines, no text, no words, no letters, no numbers, no logos, no UI chrome, highly detailed, professional documentation / research-paper figure aesthetic, 1792x1024

## Image 3 — The delta-counter: adjustments that add up
*Suggested placement: section 3 / method / key*

> Two separate offline hands each adjusting a stock quantity dial — one adding a cluster of five glowing dots, the other adding a cluster of three — and on merge the two adjustments COMBINE into a single cluster of eight dots rather than one replacing the other. Show the intents summing, not clobbering. (Depict quantities as dot-clusters, not numerals.) — clean modern technical illustration, flat vector style, isometric where it helps, white background, restrained palette of deep teal (#1D9E75), coral (#D85A30) and slate gray (#5F5E5A) with a single blue accent, subtle depth, no gradients-as-decoration, crisp thin outlines, no text, no words, no letters, no numbers, no logos, no UI chrome, highly detailed, professional documentation / research-paper figure aesthetic, 1792x1024

## Image 4 — Sync relay and tombstones
*Suggested placement: section 3 / method*

> A central lightweight relay server as a small glowing hub connecting several client devices, exchanging only the tiny missing update-fragments between them (thin light threads), and persisting a compact room-snapshot crystal. To the side, a 'delete-vs-edit' motif: a deleted item marked with a translucent tombstone that hides it from view while its edited content is preserved beneath, not destroyed. — clean modern technical illustration, flat vector style, isometric where it helps, white background, restrained palette of deep teal (#1D9E75), coral (#D85A30) and slate gray (#5F5E5A) with a single blue accent, subtle depth, no gradients-as-decoration, crisp thin outlines, no text, no words, no letters, no numbers, no logos, no UI chrome, highly detailed, professional documentation / research-paper figure aesthetic, 1792x1024

## Image 5 — Proving it: concurrent-edit test suite
*Suggested placement: section 3 / method / key*

> An isometric test-harness rig launching several independent browser windows simultaneously, each an isolated actor making conflicting edits in parallel, all feeding into a single verdict panel where every replica's final state is checked to be identical — a row of teal check-marks confirming convergence across all of them. Convey automated, reproducible concurrency correctness. — clean modern technical illustration, flat vector style, isometric where it helps, white background, restrained palette of deep teal (#1D9E75), coral (#D85A30) and slate gray (#5F5E5A) with a single blue accent, subtle depth, no gradients-as-decoration, crisp thin outlines, no text, no words, no letters, no numbers, no logos, no UI chrome, highly detailed, professional documentation / research-paper figure aesthetic, 1792x1024

## Image 6 — The result: every replica converges
*Suggested placement: section 5 / result*

> Two rivers of coloured dots flowing from opposite mountains into one valley lake where EVERY dot is preserved and arranged into a perfect ordered grid, all client devices around the lake showing the identical converged state, contrasted with a small faded side-pool (the naive approach) where half the dots vanished behind a broken-chain icon. Convey guaranteed, lossless convergence. — clean modern technical illustration, flat vector style, isometric where it helps, white background, restrained palette of deep teal (#1D9E75), coral (#D85A30) and slate gray (#5F5E5A) with a single blue accent, subtle depth, no gradients-as-decoration, crisp thin outlines, no text, no words, no letters, no numbers, no logos, no UI chrome, highly detailed, professional documentation / research-paper figure aesthetic, 1792x1024

---

### Consistency tips
- Keep the same tool, seed, and style across all 6 so they match.
- The palette (deep teal / coral / slate + one blue accent) is shared with the other five projects and with the generated flow figures (`figures/fig_*.png`).
- These are the *artistic* explainer images; the quantitative problem→solution flow figures are already generated programmatically in `figures/`.

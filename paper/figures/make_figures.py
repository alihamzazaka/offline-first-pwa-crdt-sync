#!/usr/bin/env python3
"""
Generate the four figures for the Project 06 paper from REAL repo numbers.
All numbers are sourced in the paper text; see comments per figure.
House style: figsize ~(6,3.3), blues palette, value labels, no top/right spines.
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import os

BLUE_D = "#0b5394"   # dark
BLUE_N = "#274257"   # navy
BLUE_M = "#5a8bbd"   # mid
BLUE_L = "#9db4c9"   # light
GREY = "#6b7280"

HERE = os.path.dirname(os.path.abspath(__file__))

def style(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.tick_params(length=0)

def save(fig, name):
    p = os.path.join(HERE, name)
    fig.savefig(p, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print("wrote", p)


# ---------------------------------------------------------------------------
# Figure 1 — System architecture (matplotlib boxes + arrows)
# ---------------------------------------------------------------------------
def fig_architecture():
    fig, ax = plt.subplots(figsize=(6.6, 4.2))
    ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis("off")

    def box(x, y, w, h, text, fc, tc="white", fs=8.2):
        b = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.6,rounding_size=2",
                           linewidth=0, facecolor=fc)
        ax.add_patch(b)
        ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
                color=tc, fontsize=fs, weight="bold", zorder=5)

    def arrow(x1, y1, x2, y2, color=BLUE_N, style="-|>", lw=1.4, ls="-"):
        ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle=style,
                     mutation_scale=11, color=color, lw=lw, linestyle=ls,
                     shrinkA=2, shrinkB=2))

    # Client A card
    ax.add_patch(FancyBboxPatch((1, 52), 40, 46, boxstyle="round,pad=0.6,rounding_size=2",
                 linewidth=1.1, edgecolor=BLUE_L, facecolor="#eef3f8"))
    ax.text(21, 95, "Client A  (PWA, local-first)", ha="center", fontsize=8.4,
            weight="bold", color=BLUE_N)
    box(4, 84, 34, 8, "UI  (reads/writes local first)", BLUE_D, fs=7.8)
    box(4, 73, 34, 8, "Y.Doc  —  items: Y.Map", BLUE_M, fs=7.8)
    box(4, 66.5, 16.5, 5.4, "qty: Y.Array\ndelta-counter", BLUE_N, fs=6.4)
    box(21.5, 66.5, 16.5, 5.4, "deleted:true\ntombstone", GREY, fs=6.4)
    box(4, 60, 34, 5, "epoch state machine + rebase", BLUE_L, tc=BLUE_N, fs=7.2)
    box(4, 53.5, 34, 5, "y-indexeddb  ·  bg-sync Queue", BLUE_N, fs=7.0)

    # Client B card (compact)
    ax.add_patch(FancyBboxPatch((1, 6), 40, 40, boxstyle="round,pad=0.6,rounding_size=2",
                 linewidth=1.1, edgecolor=BLUE_L, facecolor="#eef3f8"))
    ax.text(21, 43, "Client B  (PWA, local-first)", ha="center", fontsize=8.4,
            weight="bold", color=BLUE_N)
    box(4, 32, 34, 8, "UI  +  Y.Doc  +  journal", BLUE_D, fs=7.8)
    box(4, 22, 34, 7, "y-indexeddb  ·  bg-sync Queue", BLUE_N, fs=7.0)
    box(4, 12, 34, 7, "epoch state machine + rebase", BLUE_L, tc=BLUE_N, fs=7.2)

    # Relay
    ax.add_patch(FancyBboxPatch((58, 30), 40, 52, boxstyle="round,pad=0.6,rounding_size=2",
                 linewidth=1.1, edgecolor=BLUE_L, facecolor="#eef3f8"))
    ax.text(78, 79, "Sync relay  (Node, :4444)", ha="center", fontsize=8.4,
            weight="bold", color=BLUE_N)
    box(61, 68, 34, 8, "y-websocket  +  merge", BLUE_D, fs=7.8)
    box(61, 57.5, 34, 8, "stale-writer guard\n(epoch query param)", BLUE_M, fs=7.2)
    box(61, 47, 34, 8, "compaction.mjs\nsealEpoch()", BLUE_N, fs=7.4)
    box(61, 36.5, 34, 8, "StorageAdapter\nfile | postgres", BLUE_L, tc=BLUE_N, fs=7.4)

    # DB
    box(66, 12, 24, 10, "Snapshot\n<room>.yss / Postgres", GREY, fs=7.2)

    # arrows: ws sync both ways
    arrow(41, 74, 61, 72, color=BLUE_D, style="<|-|>", lw=1.8)
    ax.text(51, 78, "ws sync\n(SyncStep1/2)", ha="center", fontsize=6.6, color=BLUE_D)
    arrow(41, 26, 61, 60, color=BLUE_M, style="<|-|>", lw=1.6)
    ax.text(52, 40, "POST /ops\n(bg-sync HTTP)", ha="center", fontsize=6.4, color=BLUE_M)
    arrow(78, 36.5, 78, 22, color=BLUE_N, style="-|>", lw=1.5)
    ax.text(88, 29, "debounced\n750 ms", ha="center", fontsize=6.4, color=BLUE_N)

    ax.set_title("Offline-first sync architecture: CRDT clients, relay, epoch seal",
                 fontsize=9.6, weight="bold", color=BLUE_N, pad=6)
    save(fig, "fig1.png")


# ---------------------------------------------------------------------------
# Figure 2 — Epoch compaction bounds growth (500 deltas -> 1) + rebase flow
#   Source: fuzz/epoch-compaction.fuzz.mjs deterministic case:
#   500 adjustments -> qty 500 -> sealEpoch -> qtyLen == 1; 1 aged tombstone GC'd.
# ---------------------------------------------------------------------------
def fig_compaction():
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(6.8, 3.3),
                                   gridspec_kw={"width_ratios": [1, 1.15]})

    # left: bar, delta-array length before/after seal
    labels = ["before seal", "after seal"]
    vals = [500, 1]
    bars = ax1.bar(labels, vals, color=[BLUE_L, BLUE_D], width=0.6)
    ax1.set_ylabel("qty-delta entries per item  (↓ better)", fontsize=8)
    ax1.set_title("Epoch seal collapses the\ndelta history", fontsize=8.8,
                  weight="bold", color=BLUE_N)
    for b, v in zip(bars, vals):
        ax1.text(b.get_x() + b.get_width() / 2, v + 12, str(v), ha="center",
                 fontsize=9, weight="bold", color=BLUE_N)
    ax1.set_ylim(0, 560)
    style(ax1)
    ax1.tick_params(axis="x", labelsize=8)

    # right: rebase-not-resurrect flow
    ax2.axis("off")
    ax2.set_xlim(0, 100); ax2.set_ylim(0, 100)
    ax2.set_title("Rebase, not resurrect", fontsize=8.8, weight="bold", color=BLUE_N)

    def box2(x, y, w, h, t, fc, tc="white", fs=6.9):
        ax2.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.5,rounding_size=2",
                      linewidth=0, facecolor=fc))
        ax2.text(x + w / 2, y + h / 2, t, ha="center", va="center", color=tc,
                 fontsize=fs, weight="bold")

    def arr2(x1, y1, x2, y2, c=BLUE_N):
        ax2.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>",
                      mutation_scale=10, color=c, lw=1.3, shrinkA=1, shrinkB=1))

    box2(8, 80, 84, 13, "Server seals epoch 1\n(collapse + GC aged tombstones)", BLUE_D)
    arr2(50, 80, 50, 70)
    box2(8, 56, 84, 13, "Offline client detects epoch advance\n→ discards pre-seal doc", BLUE_M)
    arr2(50, 56, 50, 46)
    box2(8, 32, 84, 13, "Adopt server base +\nreplay ONLY pending journal ops", BLUE_N)
    arr2(50, 32, 50, 22)
    box2(4, 6, 44, 13, "op on collected\nitem → DROPPED", GREY, fs=6.6)
    box2(52, 6, 44, 13, "surviving op →\nbase + pending", BLUE_L, tc=BLUE_N, fs=6.6)

    fig.suptitle("F1  Bounded growth + drop-not-resurrect  (800-history fuzzer)",
                 fontsize=9.2, weight="bold", color=BLUE_N, y=1.03)
    save(fig, "fig2.png")


# ---------------------------------------------------------------------------
# Figure 3 — Verification coverage (real counts)
#   28 e2e runs (11 specs, README); 1500 convergence-fuzz; 800 seal/rebase-fuzz;
#   30 lossy-network runs (NET1-3 x repeat-each=5).
# ---------------------------------------------------------------------------
def fig_coverage():
    fig, ax = plt.subplots(figsize=(6.4, 3.3))
    labels = ["e2e Playwright\nruns (28/28)",
              "lossy-network\nruns (30/30)",
              "seal/rebase\nfuzz histories",
              "convergence\nfuzz histories"]
    vals = [28, 30, 800, 1500]
    colors = [BLUE_D, BLUE_N, BLUE_M, BLUE_L]
    bars = ax.barh(labels, vals, color=colors, height=0.62)
    ax.set_xscale("log")
    ax.set_xlabel("count  (log scale, ↑ more coverage)", fontsize=8)
    ax.set_xlim(1, 3000)
    for b, v in zip(bars, vals):
        ax.text(v * 1.12, b.get_y() + b.get_height() / 2, str(v), va="center",
                fontsize=9, weight="bold", color=BLUE_N)
    ax.set_title("Verification coverage: 100% green, 0 flakes",
                 fontsize=9.4, weight="bold", color=BLUE_N)
    style(ax)
    ax.tick_params(axis="y", labelsize=7.6)
    save(fig, "fig3.png")


# ---------------------------------------------------------------------------
# Figure 4 — the +5/+3 -> +8 delta-counter money shot vs naive LWW
#   Source: e2e/specs/qty-concurrent-adjust.spec.ts (start 10, +5, +3 -> 18).
# ---------------------------------------------------------------------------
def fig_moneyshot():
    fig, ax = plt.subplots(figsize=(6.2, 3.3))
    labels = ["Naive LWW\n(B wins)", "Naive LWW\n(A wins)", "CRDT delta-counter\n(this work)"]
    vals = [13, 15, 18]
    colors = [BLUE_L, BLUE_L, BLUE_D]
    bars = ax.bar(labels, vals, color=colors, width=0.6)
    for b, v in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, v + 0.3, str(v), ha="center",
                fontsize=10, weight="bold", color=BLUE_N)
    ax.axhline(18, color=BLUE_D, lw=1, ls="--", alpha=0.5)
    ax.text(2.02, 10.2, "both edits\nsurvive", ha="center", fontsize=7.4,
            color=BLUE_D, weight="bold")
    ax.text(0.5, 9.0, "one write\nsilently lost", ha="center", fontsize=7.4,
            color=GREY, weight="bold")
    ax.set_ylabel("final qty after heal  (↑ correct = 18)", fontsize=8)
    ax.set_ylim(0, 21)
    ax.set_title("Money shot: start 10, offline +5 and +3 → 18",
                 fontsize=9.6, weight="bold", color=BLUE_N)
    style(ax)
    ax.tick_params(axis="x", labelsize=7.8)
    save(fig, "fig4.png")


if __name__ == "__main__":
    fig_architecture()
    fig_compaction()
    fig_coverage()
    fig_moneyshot()
    print("done")

/**
 * Dexie-backed local mutation journal.
 *
 * Division of labor (documented design decision)
 * ----------------------------------------------
 * Yjs is the sync + merge authority: y-indexeddb already persists the CRDT
 * offline and y-websocket already exchanges exactly the missing updates on
 * reconnect. So this journal is deliberately NOT a second sync engine — it is:
 *
 *  1. **The visible offline-queue story.** Every operation the user performs
 *     is appended here as `{opId (ULID), ts, type, payload, synced}`. The
 *     SyncStatusBar's "pending ops" badge and the audit-trail UI read from it,
 *     which makes the invisible (CRDT deltas) inspectable by a human — and
 *     assertable by Playwright (S5: 50 queued ops, in order, then drained).
 *  2. **The idempotent-replay proof.** `opId` is a stable client-generated
 *     ULID and the table's primary key, so appending the same op twice is a
 *     no-op (`put` by the same key). Replaying journal ops through
 *     `replayJournal` re-invokes the same idempotent CRDT ops (create checks
 *     `items.has(id)`), demonstrating that replay cannot duplicate records.
 *
 * The journal is *derived evidence*, not the source of truth; if it were ever
 * lost, the CRDT state would still be complete and correct.
 */

import Dexie, { type Table, liveQuery } from 'dexie'
import { ROOM } from '../lib/room'

export type OpType =
  | 'createItem'
  | 'updateField'
  | 'adjustQty'
  | 'deleteItem'
  | 'editNotes'

export interface JournalEntry {
  /** Stable, client-generated ULID — primary key ⇒ idempotent append. */
  opId: string
  /** Wall-clock ms at op creation. Display/audit only — NEVER used for merge ordering. */
  ts: number
  type: OpType
  /** Op arguments, JSON-serializable. */
  payload: Record<string, unknown>
  /** 0 = pending (made while offline / not yet confirmed), 1 = synced. */
  synced: 0 | 1
}

class JournalDB extends Dexie {
  ops!: Table<JournalEntry, string>

  constructor(room: string) {
    // One journal DB per room so Playwright rooms are fully isolated.
    super(`inv-journal-${room}`)
    this.version(1).stores({
      // primary key opId (not auto), secondary indexes for audit/queries
      ops: 'opId, ts, synced, type'
    })
  }
}

export const journal = new JournalDB(ROOM)

/** Append an op. Idempotent: same opId twice = single row. */
export async function appendOp(
  entry: Omit<JournalEntry, 'ts'> & { ts?: number }
): Promise<void> {
  await journal.ops.put({
    opId: entry.opId,
    ts: entry.ts ?? Date.now(),
    type: entry.type,
    payload: entry.payload,
    synced: entry.synced
  })
}

/** Mark every pending op as synced (called when the provider reports `sync`). */
export async function markAllSynced(): Promise<void> {
  await journal.ops.where('synced').equals(0).modify({ synced: 1 })
}

/** Current number of pending (un-synced) ops. */
export function pendingCount(): Promise<number> {
  return journal.ops.where('synced').equals(0).count()
}

/** Most recent ops, newest first (audit-trail UI). */
export function recentOps(limit = 100): Promise<JournalEntry[]> {
  return journal.ops.orderBy('ts').reverse().limit(limit).toArray()
}

/** All ops in append (ts, then opId — ULIDs are monotonic) order. */
export function allOpsInOrder(): Promise<JournalEntry[]> {
  return journal.ops.orderBy('opId').toArray()
}

/**
 * Pending (un-synced) ops in append order — the epoch-rebase replay set.
 * After the server seals a new epoch, ONLY these are replayed onto the adopted
 * base (crdt/rebase.ts); already-synced ops are folded into the base itself.
 */
export function pendingOpsInOrder(): Promise<JournalEntry[]> {
  return journal.ops.where('synced').equals(0).sortBy('opId')
}

/** Live subscription to the pending-op count. Returns an unsubscribe fn. */
export function subscribePendingCount(cb: (n: number) => void): () => void {
  const sub = liveQuery(() => journal.ops.where('synced').equals(0).count()).subscribe({
    next: cb,
    error: () => cb(0)
  })
  return () => sub.unsubscribe()
}

/** Live subscription to the recent-ops audit trail. Returns an unsubscribe fn. */
export function subscribeRecentOps(
  cb: (ops: JournalEntry[]) => void,
  limit = 100
): () => void {
  const sub = liveQuery(() =>
    journal.ops.orderBy('ts').reverse().limit(limit).toArray()
  ).subscribe({ next: cb, error: () => cb([]) })
  return () => sub.unsubscribe()
}

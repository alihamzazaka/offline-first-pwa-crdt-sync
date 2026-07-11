import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { getConflicts, subscribeConflicts } from '../crdt/store'
import { subscribeRecentOps, type JournalEntry } from '../queue/mutationLog'

/**
 * ConflictLog — the demo "whoa" moment made visible.
 *
 * Yjs merges concurrent edits silently and correctly; this panel proves the
 * merge happened. The store logs an entry whenever a REMOTE update lands on a
 * field this client wrote recently (i.e. a true concurrent edit):
 *   - `lww`    → same scalar field; a deterministic winner was chosen
 *   - `merged` → qty deltas / notes text; BOTH writes survived
 * Below it, the mutation-journal audit trail shows every local op
 * ({opId, ts, type, synced}) — the visible offline queue.
 */
export default function ConflictLog(): React.ReactElement {
  const conflicts = useSyncExternalStore(subscribeConflicts, getConflicts)
  const [ops, setOps] = useState<JournalEntry[]>([])

  useEffect(() => subscribeRecentOps(setOps, 50), [])

  return (
    <div data-testid="conflict-log">
      <h2>Merge log</h2>
      {conflicts.length === 0 ? (
        <p className="muted" data-testid="conflict-empty">
          No concurrent-edit merges observed yet. Open a second window, go
          offline in both, edit the same item, reconnect — the merge will be
          logged here.
        </p>
      ) : (
        <ul className="conflict-list">
          {conflicts.map((c) => (
            <li key={c.id} data-testid="conflict-entry" data-kind={c.kind} data-field={c.field}>
              <span className={`badge badge-${c.kind}`}>
                {c.kind === 'merged' ? 'merged — both survived' : 'same-field — deterministic winner'}
              </span>
              <div className="conflict-body">
                <strong>{c.sku || c.itemId.slice(0, 8)}</strong> · field{' '}
                <code>{c.field}</code>
                <div className="conflict-values">
                  <span>
                    local: <code data-testid="conflict-local">{c.localValue || '∅'}</code>
                  </span>
                  <span>
                    after merge:{' '}
                    <code data-testid="conflict-merged">{c.mergedValue || '∅'}</code>
                  </span>
                </div>
                <time className="muted">{new Date(c.ts).toLocaleTimeString()}</time>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Mutation journal (audit trail)</h3>
      {ops.length === 0 ? (
        <p className="muted">No local ops yet.</p>
      ) : (
        <ul className="journal-list" data-testid="journal-list">
          {ops.map((op) => (
            <li key={op.opId} data-testid="journal-entry" data-synced={op.synced}>
              <code className="op-type">{op.type}</code>
              <span className="muted">{new Date(op.ts).toLocaleTimeString()}</span>
              <span className={op.synced ? 'tag-synced' : 'tag-pending'}>
                {op.synced ? 'synced' : 'pending'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

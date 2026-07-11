import React, { useEffect, useState } from 'react'
import type { ItemSnapshot } from '../crdt/store'
import {
  adjustQty,
  deleteItem,
  editNotes,
  restoreItem,
  updateField,
  type ScalarField
} from '../crdt/ops'

interface Props {
  item: ItemSnapshot
}

/**
 * Field-level editor. Scalar fields commit on blur / Enter via `updateField`
 * (one journal op per commit, per-key Y.Map merge). Notes is bound to the
 * Y.Text with character-level diffs on every change. Quantity is adjusted
 * exclusively through deltas (adjustQty) — there is deliberately NO
 * "set qty" input, because register writes to qty would reintroduce the
 * lost-increment bug the delta counter exists to prevent.
 */
export default function ItemEditor({ item }: Props): React.ReactElement {
  const [delta, setDelta] = useState('1')

  function applyDelta(sign: 1 | -1): void {
    const n = Number.parseInt(delta, 10)
    if (!Number.isFinite(n) || n === 0) return
    adjustQty(item.id, sign * Math.abs(n))
  }

  if (item.deleted) {
    return (
      <div data-testid="item-editor" className="editor">
        <p className="tombstone" data-testid="tombstone-note">
          This item was deleted (tombstoned). Its edits are preserved under the
          tombstone and it is hidden from every replica&apos;s list.
        </p>
        <button
          data-testid="editor-restore"
          type="button"
          onClick={() => restoreItem(item.id)}
        >
          Restore item
        </button>
      </div>
    )
  }

  return (
    <div data-testid="item-editor" className="editor">
      <ScalarInput
        label="SKU"
        testId="editor-sku"
        value={item.sku}
        onCommit={(v) => updateField(item.id, 'sku' satisfies ScalarField, v)}
      />
      <ScalarInput
        label="Name"
        testId="editor-name"
        value={item.name}
        onCommit={(v) => updateField(item.id, 'name', v)}
      />
      <ScalarInput
        label="Location"
        testId="editor-location"
        value={item.location}
        onCommit={(v) => updateField(item.id, 'location', v)}
      />

      <div className="field">
        <label>
          Quantity <strong data-testid="editor-qty">{item.qty}</strong>
        </label>
        <div className="qty-controls">
          <button data-testid="qty-dec" type="button" onClick={() => applyDelta(-1)}>
            −
          </button>
          <input
            data-testid="qty-delta-input"
            type="number"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            aria-label="Quantity delta"
          />
          <button data-testid="qty-inc" type="button" onClick={() => applyDelta(1)}>
            +
          </button>
          <button
            data-testid="qty-apply"
            type="button"
            onClick={() => applyDelta(1)}
            title="Apply the delta as a CRDT-safe adjustment"
          >
            Apply delta
          </button>
        </div>
        <p className="hint">
          Adjustments are stored as CRDT delta entries — concurrent offline
          counts add up instead of overwriting each other.
        </p>
      </div>

      <div className="field">
        <label htmlFor={`notes-${item.id}`}>Notes (character-level merge)</label>
        <textarea
          id={`notes-${item.id}`}
          data-testid="editor-notes"
          value={item.notes}
          rows={4}
          onChange={(e) => editNotes(item.id, e.target.value)}
        />
      </div>

      <button
        data-testid="editor-delete"
        className="danger"
        type="button"
        onClick={() => deleteItem(item.id)}
      >
        Delete item (tombstone)
      </button>
    </div>
  )
}

interface ScalarInputProps {
  label: string
  testId: string
  value: string
  onCommit: (v: string) => void
}

function ScalarInput({ label, testId, value, onCommit }: ScalarInputProps): React.ReactElement {
  const [draft, setDraft] = useState(value)

  // Track remote/merged updates while the field is not being edited.
  useEffect(() => {
    setDraft(value)
  }, [value])

  function commit(): void {
    if (draft !== value) onCommit(draft)
  }

  return (
    <div className="field">
      <label>{label}</label>
      <input
        data-testid={testId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
    </div>
  )
}

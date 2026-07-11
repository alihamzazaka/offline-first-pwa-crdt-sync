import React from 'react'
import type { ItemSnapshot } from '../crdt/store'

interface Props {
  items: ItemSnapshot[]
  selectedId: string | null
  onSelect: (id: string) => void
}

function fmtLastCounted(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString()
}

export default function ItemList({ items, selectedId, onSelect }: Props): React.ReactElement {
  if (items.length === 0) {
    return (
      <p className="muted" data-testid="list-empty">
        No items yet — add one above. Everything works offline.
      </p>
    )
  }
  return (
    <div className="table-wrap">
      <table className="item-table" data-testid="item-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Name</th>
            <th className="num">Qty</th>
            <th>Location</th>
            <th>Last counted</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              data-testid="item-row"
              data-id={item.id}
              data-sku={item.sku}
              className={item.id === selectedId ? 'selected' : ''}
              onClick={() => onSelect(item.id)}
            >
              <td data-testid="item-sku">{item.sku}</td>
              <td data-testid="item-name">{item.name}</td>
              <td className="num" data-testid="item-qty">{item.qty}</td>
              <td data-testid="item-location">{item.location}</td>
              <td data-testid="item-last-counted">{fmtLastCounted(item.lastCounted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

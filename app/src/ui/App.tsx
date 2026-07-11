import React, { useState, useSyncExternalStore } from 'react'
import {
  getItems,
  subscribeItems,
  type ItemSnapshot
} from '../crdt/store'
import { createItem } from '../crdt/ops'
import { CLIENT_LABEL, ROOM } from '../lib/room'
import ItemList from './ItemList'
import ItemEditor from './ItemEditor'
import SyncStatusBar from './SyncStatusBar'
import ConflictLog from './ConflictLog'
import OfflineToggle from './OfflineToggle'

export default function App(): React.ReactElement {
  const items = useSyncExternalStore(subscribeItems, getItems)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const visible = items.filter((i) => !i.deleted)
  const selected: ItemSnapshot | null =
    items.find((i) => i.id === selectedId) ?? null

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>▣</span>
          <div>
            <h1>Offline Stock Count</h1>
            <p className="brand-sub">
              room <code data-testid="room-name">{ROOM}</code> · client{' '}
              <code data-testid="client-label">{CLIENT_LABEL}</code>
            </p>
          </div>
        </div>
        <div className="topbar-right">
          <SyncStatusBar />
          <OfflineToggle />
        </div>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>Inventory</h2>
          <CreateItemForm />
          <ItemList
            items={visible}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </section>

        <section className="panel">
          <h2>Item editor</h2>
          {selected ? (
            <ItemEditor key={selected.id} item={selected} />
          ) : (
            <p className="muted" data-testid="editor-empty">
              Select an item to edit its fields, notes, and quantity.
            </p>
          )}
        </section>

        <section className="panel">
          <ConflictLog />
        </section>
      </main>
    </div>
  )
}

function CreateItemForm(): React.ReactElement {
  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [qty, setQty] = useState('0')
  const [location, setLocation] = useState('')

  function submit(e: React.FormEvent): void {
    e.preventDefault()
    if (!sku.trim() || !name.trim()) return
    createItem({
      sku: sku.trim(),
      name: name.trim(),
      qty: Number.parseInt(qty, 10) || 0,
      location: location.trim()
    })
    setSku('')
    setName('')
    setQty('0')
    setLocation('')
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <input
        data-testid="input-sku"
        placeholder="SKU"
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        aria-label="SKU"
      />
      <input
        data-testid="input-name"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Name"
      />
      <input
        data-testid="input-qty"
        placeholder="Qty"
        type="number"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        aria-label="Quantity"
      />
      <input
        data-testid="input-location"
        placeholder="Location"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        aria-label="Location"
      />
      <button data-testid="btn-create" type="submit">
        Add item
      </button>
    </form>
  )
}

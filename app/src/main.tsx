import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import { setupSW } from './sw/register'
import './styles.css'
// Importing the store wires up the Y.Doc, IndexedDB persistence, the
// websocket provider, the cross-tab bridge, and the window.__inv test API.
import './crdt/store'

setupSW()

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

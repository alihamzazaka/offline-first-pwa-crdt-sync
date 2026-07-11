import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { getStatus, subscribeStatus } from '../crdt/store'
import { subscribePendingCount } from '../queue/mutationLog'

/**
 * Online/offline + provider status + pending-op count (from the Dexie
 * mutation journal). `data-ws` / `data-synced` attributes are the
 * deterministic hooks the Playwright helpers wait on.
 */
export default function SyncStatusBar(): React.ReactElement {
  const status = useSyncExternalStore(subscribeStatus, getStatus)
  const [pending, setPending] = useState(0)

  useEffect(() => subscribePendingCount(setPending), [])

  const label = status.offlineForced
    ? 'offline (forced)'
    : status.wsStatus === 'connected'
      ? status.synced
        ? 'connected · synced'
        : 'connected · syncing…'
      : status.wsStatus

  return (
    <div
      className={`sync-status ws-${status.wsStatus}`}
      data-testid="sync-status"
      data-ws={status.wsStatus}
      data-synced={String(status.synced)}
      data-offline-forced={String(status.offlineForced)}
    >
      <span className="dot" aria-hidden />
      <span data-testid="sync-status-label">{label}</span>
      <span className="pending" title="Pending (un-synced) ops in the local journal">
        queue: <strong data-testid="pending-count">{pending}</strong>
      </span>
    </div>
  )
}

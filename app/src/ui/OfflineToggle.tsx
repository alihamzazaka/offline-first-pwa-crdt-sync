import React, { useSyncExternalStore } from 'react'
import { getStatus, setOffline, subscribeStatus } from '../crdt/store'

/**
 * Dev/test control that simulates going offline DETERMINISTICALLY by
 * disconnecting the y-websocket provider (see store.setOffline). This is
 * intentionally an in-app control rather than DevTools network throttling:
 * it is instant, can't race a half-open socket, and gives Playwright a
 * stable, observable switch (`data-offline`).
 */
export default function OfflineToggle(): React.ReactElement {
  const status = useSyncExternalStore(subscribeStatus, getStatus)
  const off = status.offlineForced

  return (
    <button
      type="button"
      className={`offline-toggle ${off ? 'is-off' : ''}`}
      data-testid="offline-toggle"
      data-offline={String(off)}
      onClick={() => setOffline(!off)}
      title="Simulate connectivity loss by disconnecting the sync provider"
    >
      {off ? 'Go online' : 'Go offline'}
    </button>
  )
}

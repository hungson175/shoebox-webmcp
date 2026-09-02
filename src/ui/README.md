# Shoebox UI integration contract

`ShoeboxApp` is a controlled view over the page-owned library/state-machine data. The integrator passes a
`ShoeboxViewModel` plus explicit human event handlers. It never imports the store, calls WebMCP, deletes a
file, or commits from an agent path.

- `photos` may contain 5,000 records; the grid mounts only a small overscanned window.
- `selectedIds`, tray membership, staged album membership, counters, and the live tool count come from the
  canonical state machine rather than parallel UI state.
- `onDropLibrary` receives the browser `DataTransfer` unchanged so the library-store adapter can prefer
  `getAsFileSystemHandle()` and preserve its fallback rules while an agent run stays visible.
- Commit, Discard, and Export are ordinary human buttons. None is represented as a tool.
- Pulling a card from a tray emits `onUnstagePhoto(id, trayName)` immediately, so the engine's next call can
  read the changed live plan.

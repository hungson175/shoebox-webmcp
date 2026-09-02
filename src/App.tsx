import { type MouseEvent, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createSampleLibrary } from './demo/sample-library'
import { type EnginePhoto, ShoeboxEngine } from './engine/shoebox-engine'
import { ShoeboxApp, type PhotoCard, type ShoeboxViewModel } from './ui/ShoeboxApp'
import { DynamicWebMcpRegistry, type ModelContextLike } from './webmcp/dynamic-registry'

type DocumentWithModelContext = Document & { modelContext?: ModelContextLike }

function trustedGesture(event: MouseEvent): boolean {
  return event.nativeEvent.isTrusted || import.meta.env.MODE === 'test'
}

function toPhotoCard(photo: EnginePhoto, snapshot: ReturnType<ShoeboxEngine['snapshot']>): PhotoCard {
  const group = snapshot.groups.find((candidate) => candidate.id === photo.groupId)
  const stagedTo = snapshot.trays.find((tray) => tray.photoIds.includes(photo.id))?.name
  return {
    id: photo.id,
    thumbnailUrl: photo.thumbnailUrl,
    alt: photo.alt,
    dayLabel: photo.dayLabel,
    moment: photo.moment,
    groupLabel: group?.id,
    isKeeper: group?.keeperId === photo.id,
    stagedTo,
  }
}

function viewModel(engine: ShoeboxEngine, webMcpStatus: string): ShoeboxViewModel {
  const snapshot = engine.snapshot()
  const album = snapshot.albums.find((candidate) => candidate.photoIds.length > 0)
  return {
    libraryName: snapshot.libraryName,
    indexedCount: snapshot.totalCount,
    totalCount: snapshot.totalCount,
    photos: snapshot.photos.map((photo) => toPhotoCard(photo, snapshot)),
    selectedIds: [...snapshot.selectedIds],
    trays: snapshot.trays.map((tray) => ({
      name: tray.name,
      photoIds: [...tray.photoIds],
      tone: tray.name === 'Duplicates' || tray.name === 'Trash' ? 'amber' : 'neutral',
    })),
    ...(album ? { album: { name: album.name, photoIds: [...album.photoIds], targetCount: 60 } } : {}),
    plan: snapshot.plan,
    agent: {
      active: snapshot.phase !== 'NO_LIBRARY',
      label: snapshot.activity,
      progress: snapshot.phase === 'NO_LIBRARY' ? 0 : 100,
    },
    counters: snapshot.counters,
    toolCount: engine.activeToolNames().length,
    meaningLabel: snapshot.meaning.mode === 'metadata_text'
      ? `Metadata text · ${Math.round(snapshot.meaning.coverage * 100)}% coverage`
      : snapshot.meaning.mode === 'clip'
        ? `CLIP · ${Math.round(snapshot.meaning.coverage * 100)}% coverage`
        : 'Meaning search unavailable',
    webMcpStatus,
  }
}

export default function App() {
  const engine = useMemo(() => new ShoeboxEngine({
    loadSample: createSampleLibrary,
    // The bundled demo has no source file handles. Real-folder custody replaces
    // this adapter later, so this path truthfully reports zero file writes.
    commitMoves: async () => undefined,
  }), [])
  const [, setWebMcpTick] = useState(0)
  const [webMcpStatus, setWebMcpStatus] = useState('WebMCP waiting for browser support')
  useSyncExternalStore((listener) => engine.subscribe(listener), engine.snapshot, engine.snapshot)

  useEffect(() => {
    const context = (document as DocumentWithModelContext).modelContext ?? null
    if (!context) {
      setWebMcpStatus('WebMCP unavailable in this browser')
      return undefined
    }
    const registry = new DynamicWebMcpRegistry(engine, context)
    const target = window as unknown as Record<string, unknown>
    registry.exposeBenchmarkSeam(target)
    let active = true
    registry.start()
      .then(() => {
        if (active) {
          setWebMcpStatus('Native WebMCP registered')
          setWebMcpTick((tick) => tick + 1)
        }
      })
      .catch((error: unknown) => {
        if (active) setWebMcpStatus(`WebMCP registration failed: ${error instanceof Error ? error.name : 'Error'}`)
      })
    return () => {
      active = false
      registry.stop()
      registry.removeBenchmarkSeam(target)
    }
  }, [engine])

  function openSample() {
    engine.openSampleAlbum()
  }

  function togglePhoto(id: string) {
    engine.humanTogglePhoto(id)
  }

  function unstagePhoto(id: string, trayName: string) {
    engine.humanUnstagePhoto(id, trayName)
  }

  function commit(event: MouseEvent<HTMLButtonElement>) {
    void engine.humanCommit(trustedGesture(event))
  }

  function discard(event: MouseEvent<HTMLButtonElement>) {
    engine.humanDiscard(trustedGesture(event))
  }

  function exportAlbum(event: MouseEvent<HTMLButtonElement>) {
    const payload = engine.humanExport(trustedGesture(event))
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    link.download = 'shoebox-album.json'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  function addDroppedPhotos(transfer: DataTransfer) {
    const files = Array.from(transfer.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    const photos: EnginePhoto[] = files.map((file, index) => ({
      id: `drop-${file.name}-${file.lastModified}-${index}`,
      thumbnailUrl: URL.createObjectURL(file),
      peekDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+X8Kb5QAAAABJRU5ErkJggg==',
      peekWidth: 1,
      peekHeight: 1,
      alt: file.name,
      dayLabel: 'Just added',
      moment: file.name,
      sharpness: 0,
      blurry: false,
    }))
    engine.humanAddPhotos(photos)
  }

  return (
    <ShoeboxApp
      model={viewModel(engine, webMcpStatus)}
      onOpenSample={openSample}
      onTogglePhoto={togglePhoto}
      onUnstagePhoto={unstagePhoto}
      onCommit={commit}
      onExport={exportAlbum}
      onDiscard={discard}
      onDropLibrary={addDroppedPhotos}
    />
  )
}

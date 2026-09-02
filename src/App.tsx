import { useMemo, useState } from 'react'
import { ShoeboxApp, type PhotoCard, type ShoeboxViewModel } from './ui/ShoeboxApp'

const moments = ['Pagoda', 'Flower market', 'Family meal', 'Lucky money', 'Garden portraits', 'Train ride', 'Grandkids together']
const palette = [
  ['#a75b3d', '#e5bd78', '#64745a'],
  ['#5c776d', '#d8c39f', '#be7949'],
  ['#374e58', '#ddb66b', '#8a5239'],
  ['#805446', '#d9a66f', '#697f76'],
  ['#4e6250', '#edd59c', '#bd6e51']
]

function demoThumbnail(index: number) {
  const [sky, sun, ground] = palette[index % palette.length]
  const x = 28 + ((index * 23) % 190)
  const y = 22 + ((index * 17) % 70)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 210"><rect width="300" height="210" fill="${sky}"/><circle cx="${x}" cy="${y}" r="31" fill="${sun}" opacity=".88"/><path d="M0 157L72 93l49 43 49-63 130 94v43H0z" fill="${ground}"/><path d="M0 181q78-44 151 0t149-4v33H0z" fill="#26352f" opacity=".5"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function buildSamplePhotos(): PhotoCard[] {
  return Array.from({ length: 500 }, (_, index) => {
    const moment = moments[index % moments.length]
    const staged = index >= 188
    return {
      id: `tet-${String(index + 1).padStart(3, '0')}`,
      thumbnailUrl: demoThumbnail(index),
      alt: `${moment}, photo ${index + 1}`,
      dayLabel: `Tết day ${(index % 5) + 1}`,
      moment,
      groupLabel: index < 252 ? `Burst ${Math.floor(index / 3) + 1}` : undefined,
      isKeeper: index < 252 && index % 3 === 0,
      stagedTo: staged ? 'Duplicates' : undefined
    }
  })
}

const emptyModel: ShoeboxViewModel = {
  indexedCount: 0,
  totalCount: 0,
  photos: [],
  selectedIds: [],
  trays: [],
  plan: { moves: 0, albums: 0, deletes: 0 },
  agent: { active: false, label: 'Waiting for a library', progress: 0 },
  counters: { pixelsRequestedGroups: 0, pixelsRequestedPhotos: 0, libraryPhotos: 0 },
  toolCount: 2
}

export default function App() {
  const samplePhotos = useMemo(buildSamplePhotos, [])
  const [model, setModel] = useState<ShoeboxViewModel>(emptyModel)

  function openSample() {
    setModel({
      libraryName: 'Family Tết 2026',
      indexedCount: 500,
      totalCount: 500,
      photos: samplePhotos,
      selectedIds: [],
      trays: [{ name: 'Duplicates', photoIds: samplePhotos.slice(188).map((photo) => photo.id), tone: 'amber' }],
      album: { name: 'Bà Nội’s Tết album', photoIds: samplePhotos.slice(0, 60).map((photo) => photo.id), targetCount: 60 },
      plan: { moves: 312, albums: 1, deletes: 0 },
      agent: { active: true, label: 'Finding doubles · 84 groups', progress: 62 },
      counters: { pixelsRequestedGroups: 1, pixelsRequestedPhotos: 6, libraryPhotos: 500 },
      toolCount: 6
    })
  }

  function togglePhoto(id: string) {
    setModel((current) => ({
      ...current,
      selectedIds: current.selectedIds.includes(id)
        ? current.selectedIds.filter((selectedId) => selectedId !== id)
        : [...current.selectedIds, id]
    }))
  }

  function unstagePhoto(id: string, trayName: string) {
    setModel((current) => ({
      ...current,
      photos: current.photos.map((photo) => photo.id === id ? { ...photo, stagedTo: undefined } : photo),
      trays: current.trays.map((tray) => tray.name === trayName ? { ...tray, photoIds: tray.photoIds.filter((photoId) => photoId !== id) } : tray),
      plan: { ...current.plan, moves: Math.max(0, current.plan.moves - 1) },
      agent: { active: true, label: 'Plan updated with your change', progress: current.agent.progress }
    }))
  }

  function commit() {
    setModel((current) => ({
      ...current,
      trays: current.trays.map((tray) => ({ ...tray, photoIds: [] })),
      plan: { moves: 0, albums: 0, deletes: 0 },
      agent: { active: false, label: 'Changes committed by you', progress: 100 }
    }))
  }

  function discard() {
    setModel((current) => ({
      ...current,
      photos: current.photos.map((photo) => ({ ...photo, stagedTo: undefined })),
      trays: current.trays.map((tray) => ({ ...tray, photoIds: [] })),
      album: undefined,
      plan: { moves: 0, albums: 0, deletes: 0 },
      agent: { active: false, label: 'Plan discarded', progress: 0 }
    }))
  }

  function exportAlbum() {
    if (!model.album) return
    const payload = JSON.stringify({ name: model.album.name, photos: model.album.photoIds }, null, 2)
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    link.download = 'shoebox-album.json'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  function addDroppedPhotos(transfer: DataTransfer) {
    const files = Array.from(transfer.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    const added: PhotoCard[] = files.map((file, index) => ({
      id: `drop-${file.name}-${file.lastModified}-${index}`,
      thumbnailUrl: URL.createObjectURL(file),
      alt: file.name,
      dayLabel: 'Just added',
      moment: file.name
    }))
    setModel((current) => ({
      ...current,
      libraryName: current.libraryName ?? 'Dropped photo folder',
      photos: [...current.photos, ...added],
      totalCount: current.totalCount + added.length,
      indexedCount: current.indexedCount + added.length,
      counters: { ...current.counters, libraryPhotos: current.counters.libraryPhotos + added.length },
      agent: { active: true, label: `Adding ${added.length} new ${added.length === 1 ? 'photo' : 'photos'} without stopping`, progress: current.agent.progress },
      toolCount: 6
    }))
  }

  return (
    <ShoeboxApp
      model={model}
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

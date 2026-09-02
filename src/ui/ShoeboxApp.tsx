import { type DragEvent, type UIEvent, useEffect, useMemo, useState } from 'react'
import './shoebox.css'

export type TrayTone = 'amber' | 'neutral'

export interface PhotoCard {
  id: string
  thumbnailUrl: string
  alt: string
  dayLabel: string
  moment: string
  groupLabel?: string
  isKeeper?: boolean
  stagedTo?: string
}

export interface ShoeboxTray {
  name: string
  photoIds: string[]
  tone: TrayTone
}

export interface ShoeboxAlbum {
  name: string
  photoIds: string[]
  targetCount: number
}

export interface ShoeboxViewModel {
  libraryName?: string
  indexedCount: number
  totalCount: number
  photos: PhotoCard[]
  selectedIds: string[]
  trays: ShoeboxTray[]
  album?: ShoeboxAlbum
  plan: { moves: number; albums: number; deletes: number }
  agent: { active: boolean; label: string; progress: number }
  counters: { pixelsRequestedGroups: number; pixelsRequestedPhotos: number; libraryPhotos: number }
  toolCount: number
  meaningLabel?: string
  webMcpStatus?: string
}

export interface ShoeboxAppProps {
  model: ShoeboxViewModel
  onOpenSample?: () => void
  onTogglePhoto: (id: string) => void
  onUnstagePhoto: (id: string, trayName: string) => void
  onCommit: (event: import('react').MouseEvent<HTMLButtonElement>) => void
  onExport: (event: import('react').MouseEvent<HTMLButtonElement>) => void
  onDiscard: (event: import('react').MouseEvent<HTMLButtonElement>) => void
  onDropLibrary: (transfer: DataTransfer) => void | Promise<void>
}

const CARD_HEIGHT = 238
const OVERSCAN_ROWS = 2

export function getGridColumns(viewportWidth: number) {
  if (viewportWidth <= 760) return 2
  if (viewportWidth <= 1100) return 4
  return 5
}

function useGridColumns() {
  const [columns, setColumns] = useState(() => typeof window === 'undefined' ? 5 : getGridColumns(window.innerWidth))
  useEffect(() => {
    const sync = () => setColumns(getGridColumns(window.innerWidth))
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])
  return columns
}

function plural(value: number, singular: string, pluralForm = `${singular}s`) {
  return value === 1 ? singular : pluralForm
}

function PhotoTile({ photo, selected, onToggle }: { photo: PhotoCard; selected: boolean; onToggle: () => void }) {
  return (
    <div className="photo-grid__cell" role="gridcell">
      <button
        className={`photo-card${selected ? ' photo-card--selected' : ''}${photo.stagedTo ? ' photo-card--staged' : ''}`}
        type="button"
        aria-label={`${selected ? 'Unselect' : 'Select'} ${photo.alt}`}
        aria-pressed={selected}
        data-staged-to={photo.stagedTo}
        onClick={onToggle}
      >
        <span className="photo-card__image-wrap">
          <img className="photo-card__image" src={photo.thumbnailUrl} alt={photo.alt} draggable={false} />
          <span className="photo-card__check" aria-hidden="true">✓</span>
          {photo.isKeeper && <span className="photo-card__keeper">Keeper</span>}
          {photo.stagedTo && <span className="photo-card__staged-label">→ {photo.stagedTo}</span>}
        </span>
        <span className="photo-card__meta">
          <span className="photo-card__moment">{photo.moment}</span>
          <span className="photo-card__detail">
            <span>{photo.dayLabel}</span>
            {photo.groupLabel && <span className="photo-card__group">{photo.groupLabel}</span>}
          </span>
        </span>
      </button>
    </div>
  )
}

function VirtualPhotoGrid({ photos, selectedIds, onTogglePhoto }: Pick<ShoeboxAppProps, 'onTogglePhoto'> & Pick<ShoeboxViewModel, 'photos' | 'selectedIds'>) {
  const [scrollTop, setScrollTop] = useState(0)
  const columns = useGridColumns()
  const visibleRows = 3
  const totalRows = Math.ceil(photos.length / columns)
  const startRow = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - OVERSCAN_ROWS)
  const endRow = Math.min(totalRows, startRow + visibleRows + OVERSCAN_ROWS * 2)
  const startIndex = startRow * columns
  const visible = photos.slice(startIndex, endRow * columns)
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setScrollTop(event.currentTarget.scrollTop)
  }

  return (
    <div
      className="photo-grid"
      role="grid"
      aria-label="Photo library"
      aria-rowcount={photos.length}
      onScroll={handleScroll}
    >
      <div className="photo-grid__spacer" style={{ height: totalRows * CARD_HEIGHT }}>
        <div className="photo-grid__window" style={{ transform: `translateY(${startRow * CARD_HEIGHT}px)` }}>
          {visible.map((photo) => (
            <PhotoTile key={photo.id} photo={photo} selected={selected.has(photo.id)} onToggle={() => onTogglePhoto(photo.id)} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Tray({ tray, photosById, onUnstagePhoto }: { tray: ShoeboxTray; photosById: Map<string, PhotoCard>; onUnstagePhoto: ShoeboxAppProps['onUnstagePhoto'] }) {
  return (
    <section className="tray" role="region" aria-label={`${tray.name} tray`} data-tone={tray.tone}>
      <header className="tray__header">
        <div>
          <p className="eyebrow">Staged, not deleted</p>
          <h2>{tray.name}</h2>
        </div>
        <span className="count-chip">{tray.photoIds.length}</span>
      </header>
      <div className="tray__rail">
        {tray.photoIds.length === 0 && <p className="tray__empty">Nothing staged here.</p>}
        {tray.photoIds.slice(0, 12).map((id) => {
          const photo = photosById.get(id)
          if (!photo) return null
          return (
            <article className="tray-card" key={id}>
              <img src={photo.thumbnailUrl} alt={photo.alt} />
              <button type="button" onClick={() => onUnstagePhoto(id, tray.name)} aria-label={`Pull ${photo.alt} back into the library`}>
                Pull back
              </button>
            </article>
          )
        })}
        {tray.photoIds.length > 12 && <div className="tray__more">+{tray.photoIds.length - 12} more staged</div>}
      </div>
    </section>
  )
}

function AlbumStrip({ album, photosById }: { album: ShoeboxAlbum; photosById: Map<string, PhotoCard> }) {
  return (
    <section className="album" role="region" aria-label={album.name}>
      <header className="album__header">
        <div>
          <p className="eyebrow">Album being staged</p>
          <h2>{album.name}</h2>
        </div>
        <strong>{album.photoIds.length} of about {album.targetCount} moments</strong>
      </header>
      <div className="album__rail">
        {album.photoIds.map((id, index) => {
          const photo = photosById.get(id)
          if (!photo) return null
          return (
            <figure className="album-card" key={id}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <img src={photo.thumbnailUrl} alt={photo.alt} />
            </figure>
          )
        })}
        <div className="album__more" aria-hidden="true">+ more moments</div>
      </div>
    </section>
  )
}

export function ShoeboxApp({ model, onOpenSample, onTogglePhoto, onUnstagePhoto, onCommit, onExport, onDiscard, onDropLibrary }: ShoeboxAppProps) {
  const [dragging, setDragging] = useState(false)
  const photosById = useMemo(() => new Map(model.photos.map((photo) => [photo.id, photo])), [model.photos])
  const boundedProgress = Math.max(0, Math.min(100, model.agent.progress))

  function enterDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  function leaveDrop(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragging(false)
  }

  function dropLibrary(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setDragging(false)
    void onDropLibrary(event.dataTransfer)
  }

  return (
    <main
      className={`shoebox${dragging ? ' shoebox--dragging' : ''}`}
      data-testid="library-drop-zone"
      onDragEnter={enterDrop}
      onDragOver={enterDrop}
      onDragLeave={leaveDrop}
      onDrop={dropLibrary}
    >
      <header className="hero">
        <div className="brand" aria-label="Shoebox home">
          <span className="brand__mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Shoebox</span>
        </div>
        <div className="hero__copy">
          <p className="eyebrow">One request. A family album.</p>
          <h1>Tell it what grandma wants from the family’s holiday folder.</h1>
          <p className="hero__dek">It finds the moments, drops the doubles, keeps the sharp shot and stages her album. Nothing is uploaded. Nothing changes until you press Commit.</p>
        </div>
        <div className="authority-badge" aria-label={`${model.toolCount} tools live, none can delete or commit`}>
          <span className="authority-badge__pulse" />
          <strong>{model.toolCount} tools live</strong>
          <span className="authority-badge__boundary">none can delete or commit</span>
          {model.webMcpStatus && <span className="authority-badge__status">{model.webMcpStatus}</span>}
        </div>
      </header>

      <section className="workspace-shell">
        {!model.libraryName ? (
          <div className="empty-library">
            <p className="eyebrow">See it in one click</p>
            <h2>Start with the ready-made family album</h2>
            <p>Five Tết days, doubles, bursts and blurry shots—already indexed on this device.</p>
            <button className="button button--primary" type="button" onClick={onOpenSample}>Open sample album</button>
          </div>
        ) : (
          <>
            <div className="library-toolbar">
              <div>
                <p className="eyebrow">Open library</p>
                <h2>{model.libraryName}</h2>
              </div>
              <div className="library-toolbar__stats">
                <strong>{model.indexedCount.toLocaleString()} photos indexed</strong>
                <span>{model.selectedIds.length} selected</span>
              </div>
            </div>

            <div className="agent-ribbon" data-active={model.agent.active}>
              <span className="agent-ribbon__orb" aria-hidden="true" />
              <div className="agent-ribbon__text">
                <strong>{model.agent.label}</strong>
                <span>{model.agent.active ? 'Keep dragging photos here while your assistant works.' : 'Your plan is ready for you to check.'}</span>
              </div>
              <div className="agent-ribbon__progress" role="progressbar" aria-label="Assistant progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={boundedProgress}>
                <i style={{ width: `${boundedProgress}%` }} />
              </div>
              <span className="agent-ribbon__percent">{boundedProgress}%</span>
            </div>

            <VirtualPhotoGrid photos={model.photos} selectedIds={model.selectedIds} onTogglePhoto={onTogglePhoto} />
          </>
        )}
      </section>

      {model.libraryName && (
        <section className="staging-area" aria-label="Staged changes">
          <div className="staging-area__column">
            {model.trays.map((tray) => <Tray key={tray.name} tray={tray} photosById={photosById} onUnstagePhoto={onUnstagePhoto} />)}
          </div>
          {model.album && <AlbumStrip album={model.album} photosById={photosById} />}
        </section>
      )}

      <aside className={`drop-curtain${dragging ? ' drop-curtain--visible' : ''}`} aria-hidden={!dragging}>
        <div>
          <span aria-hidden="true">↘</span>
          <strong>Add these photos</strong>
          <p>Your assistant will keep working on the current plan.</p>
        </div>
      </aside>

      {model.libraryName && (
        <footer className="action-dock">
          <div className="custody-counter">
            <span>Pixels requested: {model.counters.pixelsRequestedGroups} {plural(model.counters.pixelsRequestedGroups, 'group')} · {model.counters.pixelsRequestedPhotos} of {model.counters.libraryPhotos} photos</span>
            {model.meaningLabel && <span>{model.meaningLabel}</span>}
            <strong>{model.plan.deletes} deletes</strong>
          </div>
          <div className="action-dock__buttons">
            <button className="button button--quiet" type="button" onClick={onDiscard}>Discard plan</button>
            <button className="button button--quiet" type="button" onClick={onExport}>Export album</button>
            <button className="button button--commit" type="button" onClick={onCommit}>
              Commit {model.plan.moves} moves plus {model.plan.albums} {plural(model.plan.albums, 'album')}, {model.plan.deletes} deletes
            </button>
          </div>
        </footer>
      )}
    </main>
  )
}

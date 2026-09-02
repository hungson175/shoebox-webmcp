import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { getGridColumns, ShoeboxApp, type PhotoCard, type ShoeboxViewModel } from './ShoeboxApp'

const photos: PhotoCard[] = [
  { id: 'p1', thumbnailUrl: '/one.jpg', alt: 'Ba Noi at the pagoda', dayLabel: 'Tet day 1', moment: 'Pagoda', groupLabel: 'Burst 12', isKeeper: true },
  { id: 'p2', thumbnailUrl: '/two.jpg', alt: 'Grandkids at the flower market', dayLabel: 'Tet day 2', moment: 'Flower market', stagedTo: 'Duplicates' },
  { id: 'p3', thumbnailUrl: '/three.jpg', alt: 'Family meal', dayLabel: 'Tet day 3', moment: 'Family meal' }
]

function model(overrides: Partial<ShoeboxViewModel> = {}): ShoeboxViewModel {
  return {
    libraryName: 'Family Tet 2026',
    indexedCount: 500,
    totalCount: 500,
    photos,
    selectedIds: [],
    trays: [{ name: 'Duplicates', photoIds: ['p2'], tone: 'amber' }],
    album: { name: 'Ba Noi’s Tet album', photoIds: ['p1', 'p3'], targetCount: 60 },
    plan: { moves: 312, albums: 1, deletes: 0 },
    agent: { active: false, label: 'Album ready', progress: 100 },
    counters: { pixelsRequestedGroups: 1, pixelsRequestedPhotos: 6, libraryPhotos: 500 },
    toolCount: 6,
    ...overrides
  }
}

function ControlledApp(props: { onCommit?: () => void; onExport?: () => void; onDiscard?: () => void; onDropLibrary?: (transfer: DataTransfer) => void } = {}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [vm, setVm] = useState(model())
  return (
    <ShoeboxApp
      model={{ ...vm, selectedIds }}
      onTogglePhoto={(id) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
      onUnstagePhoto={(id) => setVm((current) => ({ ...current, trays: current.trays.map((tray) => ({ ...tray, photoIds: tray.photoIds.filter((photoId) => photoId !== id) })) }))}
      onCommit={props.onCommit ?? vi.fn()}
      onExport={props.onExport ?? vi.fn()}
      onDiscard={props.onDiscard ?? vi.fn()}
      onDropLibrary={props.onDropLibrary ?? vi.fn()}
    />
  )
}

describe('Shoebox product UI', () => {
  it('matches grid virtualization columns to responsive CSS breakpoints', () => {
    expect(getGridColumns(1440)).toBe(5)
    expect(getGridColumns(900)).toBe(4)
    expect(getGridColumns(390)).toBe(2)
  })

  it('makes the family outcome and bounded agent authority clear on the first screen', () => {
    render(<ControlledApp />)
    expect(screen.getByRole('heading', { name: /tell it what grandma wants/i })).toBeVisible()
    expect(screen.getByText(/nothing is uploaded/i)).toBeVisible()
    expect(screen.getByText('6 tools live')).toBeVisible()
    expect(screen.getByText(/none can delete or commit/i)).toBeVisible()
    expect(screen.getByText('500 photos indexed')).toBeVisible()
  })

  it('shows a selectable photo grid with keeper, group and staged semantics', async () => {
    const user = userEvent.setup()
    render(<ControlledApp />)
    const first = screen.getByRole('button', { name: /select ba noi at the pagoda/i })
    expect(within(first).getByText('Burst 12')).toBeVisible()
    expect(within(first).getByText('Keeper')).toBeVisible()
    expect(screen.getByRole('button', { name: /select grandkids at the flower market/i })).toHaveAttribute('data-staged-to', 'Duplicates')
    await user.click(first)
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('1 selected')).toBeVisible()
  })

  it('keeps the amber tray editable while the agent is working', async () => {
    const user = userEvent.setup()
    render(<ControlledApp />)
    const tray = screen.getByRole('region', { name: 'Duplicates tray' })
    expect(tray).toHaveAttribute('data-tone', 'amber')
    await user.click(within(tray).getByRole('button', { name: /pull grandkids at the flower market back/i }))
    expect(within(tray).queryByAltText('Grandkids at the flower market')).not.toBeInTheDocument()
  })

  it('renders the staged album and exposes human-only Commit, Discard and Export controls', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    const onExport = vi.fn()
    const onDiscard = vi.fn()
    render(<ControlledApp onCommit={onCommit} onExport={onExport} onDiscard={onDiscard} />)
    const album = screen.getByRole('region', { name: /ba noi’s tet album/i })
    expect(within(album).getByText('2 of about 60 moments')).toBeVisible()
    expect(screen.getByText('Commit 312 moves plus 1 album, 0 deletes')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^commit/i }))
    await user.click(screen.getByRole('button', { name: /^export/i }))
    await user.click(screen.getByRole('button', { name: /^discard/i }))
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onExport).toHaveBeenCalledOnce()
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('accepts another drop without blocking the visible agent run', () => {
    const onDropLibrary = vi.fn()
    render(<ShoeboxApp model={model({ agent: { active: true, label: 'Finding doubles · 84 groups', progress: 62 } })} onTogglePhoto={vi.fn()} onUnstagePhoto={vi.fn()} onCommit={vi.fn()} onExport={vi.fn()} onDiscard={vi.fn()} onDropLibrary={onDropLibrary} />)
    expect(screen.getByText('Finding doubles · 84 groups')).toBeVisible()
    expect(screen.getByText(/keep dragging photos here while your assistant works/i)).toBeVisible()
    const transfer = { files: [{ name: 'new.jpg' }] } as unknown as DataTransfer
    fireEvent.drop(screen.getByTestId('library-drop-zone'), { dataTransfer: transfer })
    expect(onDropLibrary).toHaveBeenCalledWith(transfer)
  })

  it('logs bounded pixel requests against the whole library', () => {
    render(<ControlledApp />)
    expect(screen.getByText('Pixels requested: 1 group · 6 of 500 photos')).toBeVisible()
  })

  it('virtualizes very large libraries instead of mounting 5,000 cards', () => {
    const many = Array.from({ length: 5_000 }, (_, index): PhotoCard => ({
      id: `p-${index}`,
      thumbnailUrl: `/thumbs/${index}.jpg`,
      alt: `Photo ${index}`,
      dayLabel: `Tet day ${(index % 5) + 1}`,
      moment: `Moment ${index}`
    }))
    render(<ShoeboxApp model={model({ photos: many, totalCount: 5_000, indexedCount: 5_000, trays: [], album: undefined, plan: { moves: 0, albums: 0, deletes: 0 } })} onTogglePhoto={vi.fn()} onUnstagePhoto={vi.fn()} onCommit={vi.fn()} onExport={vi.fn()} onDiscard={vi.fn()} onDropLibrary={vi.fn()} />)
    const grid = screen.getByRole('grid', { name: 'Photo library' })
    expect(grid).toHaveAttribute('aria-rowcount', '5000')
    expect(within(grid).getAllByRole('gridcell').length).toBeLessThan(150)
  })
})

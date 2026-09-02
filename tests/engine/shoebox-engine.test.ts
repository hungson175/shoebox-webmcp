// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ShoeboxEngine, type SampleLibrary } from '../../src/engine/shoebox-engine'

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+X8Kb5QAAAABJRU5ErkJggg=='

function sample(mode: 'clip' | 'metadata_text' = 'metadata_text', coverage = 1): SampleLibrary {
  const photos = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index + 1}`,
    thumbnailUrl: PIXEL,
    peekDataUrl: PIXEL,
    peekWidth: 1,
    peekHeight: 1,
    alt: index < 4 ? `Pagoda family ${index + 1}` : `Flower market ${index + 1}`,
    dayLabel: `Day ${(index % 2) + 1}`,
    moment: index < 4 ? 'Pagoda' : 'Flower market',
    groupId: index < 4 ? 'group-1' : 'group-2',
    sharpness: index % 4,
    blurry: index % 4 === 0,
  }))
  return {
    id: 'sample-v1',
    name: 'Family Tết sample',
    photos,
    groups: [
      { id: 'group-1', kind: 'near-duplicate', memberIds: ['p1', 'p2', 'p3', 'p4'], keeperId: 'p4' },
      { id: 'group-2', kind: 'burst', memberIds: ['p5', 'p6', 'p7', 'p8'], keeperId: 'p8' },
    ],
    trays: ['Duplicates', 'Trash'],
    albums: ['Bà Nội’s Tết album'],
    meaning: { mode, coverage, manifestPresent: mode === 'clip' },
  }
}

function engine(options: { mode?: 'clip' | 'metadata_text'; coverage?: number; commit?: (moves: readonly unknown[]) => Promise<void> } = {}) {
  return new ShoeboxEngine({
    loadSample: () => sample(options.mode, options.coverage),
    commitMoves: options.commit ?? (async () => undefined),
  })
}

describe('ShoeboxEngine canonical state', () => {
  it('opens the local sample idempotently and publishes one immutable snapshot', () => {
    const subject = engine()
    expect(subject.snapshot().phase).toBe('NO_LIBRARY')
    const first = subject.openSampleAlbum()
    const second = subject.openSampleAlbum()
    expect(first.phase).toBe('BROWSE')
    expect(first.totalCount).toBe(8)
    expect(second.libraryGeneration).toBe(first.libraryGeneration)
    expect(Object.isFrozen(subject.snapshot())).toBe(true)
    expect(Object.isFrozen(subject.snapshot().photos)).toBe(true)
  })

  it('creates bounded opaque result handles rather than returning photo rows', () => {
    const subject = engine()
    subject.openSampleAlbum()
    const receipt = subject.findDuplicates('normal')
    expect(receipt).toMatchObject({ groupCount: 2, memberCount: 8, mode: 'normal' })
    expect(receipt.resultId).toMatch(/^result-[a-z0-9-]+$/)
    expect(JSON.stringify(receipt)).not.toContain('thumbnailUrl')
    expect(JSON.stringify(receipt)).not.toContain('memberIds')
  })

  it('selects only current non-empty handles and rejects stale handles without mutation', () => {
    const subject = engine()
    subject.openSampleAlbum()
    const result = subject.findDuplicates('normal')
    expect(subject.select(result.resultId).phase).toBe('SELECTED')
    const before = subject.snapshot()
    expect(() => subject.select('result-missing')).toThrow(/unknown_result/)
    expect(subject.snapshot()).toBe(before)
    subject.replaceLibrary(sample())
    expect(() => subject.select(result.resultId)).toThrow(/stale_result/)
  })

  it('stages selected photos to a live destination then clears selection back to BROWSE', () => {
    const subject = engine()
    subject.openSampleAlbum()
    const result = subject.findDuplicates('normal')
    subject.select(result.resultId)
    const receipt = subject.stageMove('Trash', ['Duplicates', 'Trash', 'Bà Nội’s Tết album'])
    expect(receipt).toMatchObject({ phase: 'BROWSE', destination: 'Trash', moves: 8, deletes: 0 })
    expect(subject.snapshot().selectedIds).toEqual([])
    expect(subject.snapshot().plan.deletes).toBe(0)
  })

  it('refuses a destination absent from that descriptor generation without mutation', () => {
    const subject = engine()
    subject.openSampleAlbum()
    subject.select(subject.findDuplicates('normal').resultId)
    const before = subject.snapshot()
    expect(() => subject.stageMove('Invented album', ['Duplicates', 'Trash'])).toThrow(/invalid_destination/)
    expect(subject.snapshot()).toBe(before)
  })

  it('peek returns page-local thumbnails and increments only the peek counter', () => {
    const subject = engine()
    subject.openSampleAlbum()
    const beforeGrid = subject.snapshot().counters.pixelsRequestedGroups
    subject.snapshot()
    expect(subject.snapshot().counters.pixelsRequestedGroups).toBe(beforeGrid)
    subject.select(subject.findDuplicates('normal').resultId)
    const receipt = subject.peek('group-1')
    expect(receipt.thumbnails).toHaveLength(4)
    expect(receipt.thumbnails.every((item) => item.dataUrl.startsWith('data:image/') && item.width <= 96 && item.height <= 96)).toBe(true)
    expect(subject.snapshot().counters.pixelsRequestedGroups).toBe(beforeGrid + 1)
  })

  it('labels meaning results with the honest active mode and coverage', () => {
    const metadata = engine({ mode: 'metadata_text', coverage: 0.95 })
    metadata.openSampleAlbum()
    expect(metadata.findByMeaning('pagoda')).toMatchObject({ mode: 'metadata_text', coverage: 0.95, memberCount: 4 })
    const clip = engine({ mode: 'clip', coverage: 1 })
    clip.openSampleAlbum()
    expect(clip.findByMeaning('pagoda')).toMatchObject({ mode: 'clip', coverage: 1 })
  })

  it('requires a trusted human gesture for commit and calls custody once', async () => {
    const commit = vi.fn(async () => undefined)
    const subject = engine({ commit })
    subject.openSampleAlbum()
    subject.select(subject.findDuplicates('normal').resultId)
    subject.stageMove('Duplicates', ['Duplicates', 'Trash', 'Bà Nội’s Tết album'])
    await expect(subject.humanCommit(false)).rejects.toThrow(/trusted_human_required/)
    expect(commit).not.toHaveBeenCalled()
    const receipt = await subject.humanCommit(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(receipt).toMatchObject({ written: 0, deletes: 0, demo: true })
  })

  it('human Discard performs zero custody I/O and clears the plan', () => {
    const commit = vi.fn(async () => undefined)
    const subject = engine({ commit })
    subject.openSampleAlbum()
    subject.select(subject.findDuplicates('normal').resultId)
    subject.stageMove('Duplicates', ['Duplicates', 'Trash', 'Bà Nội’s Tết album'])
    subject.humanDiscard(true)
    expect(subject.snapshot().plan.moves).toBe(0)
    expect(commit).not.toHaveBeenCalled()
  })
})

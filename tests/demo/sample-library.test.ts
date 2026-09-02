// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createSampleLibrary } from '../../src/demo/sample-library'

describe('bundled M1 sample library', () => {
  it('derives the visible 500/84/312/60 facts from one deterministic fixture', () => {
    const sample = createSampleLibrary()
    expect(sample.photos).toHaveLength(500)
    expect(sample.groups).toHaveLength(84)
    expect(new Set(sample.groups.flatMap((group) => group.memberIds)).size).toBe(396)
    expect(sample.groups.reduce((count, group) => count + group.memberIds.length - 1, 0)).toBe(312)
    expect(sample.initialPlan?.moves).toHaveLength(312)
    expect(sample.initialPlan?.albums[0].photoIds).toHaveLength(60)
    expect(sample.meaning).toEqual({ mode: 'metadata_text', coverage: 1, manifestPresent: false })
  })

  it('uses local data URLs and bounded page-local peek thumbnails only', () => {
    const sample = createSampleLibrary()
    expect(sample.photos.every((photo) => photo.thumbnailUrl.startsWith('data:image/svg+xml,'))).toBe(true)
    expect(sample.photos.every((photo) => photo.peekDataUrl.startsWith('data:image/svg+xml;base64,'))).toBe(true)
    expect(sample.photos.every((photo) => photo.peekWidth <= 96 && photo.peekHeight <= 96)).toBe(true)
    expect(JSON.stringify(sample)).not.toMatch(/https?:\/\//)
  })
})

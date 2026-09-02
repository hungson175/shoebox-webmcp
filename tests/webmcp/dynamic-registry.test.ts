// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ShoeboxEngine, type SampleLibrary } from '../../src/engine/shoebox-engine'
import { DynamicWebMcpRegistry, type ModelContextLike, type WebMcpTool } from '../../src/webmcp/dynamic-registry'

const PIXEL = 'data:image/png;base64,AA=='
function sample(mode: 'clip' | 'metadata_text' = 'metadata_text', coverage = 1): SampleLibrary {
  const photos = Array.from({ length: 4 }, (_, index) => ({
    id: `p${index + 1}`, thumbnailUrl: PIXEL, peekDataUrl: PIXEL, peekWidth: 1, peekHeight: 1,
    alt: `Pagoda ${index + 1}`, dayLabel: 'Day 1', moment: 'Pagoda', groupId: 'g1', sharpness: index, blurry: index === 0,
  }))
  return { id: 'sample-v1', name: 'Sample', photos, groups: [{ id: 'g1', kind: 'burst', memberIds: photos.map((p) => p.id), keeperId: 'p4' }], trays: ['Duplicates', 'Trash'], albums: ['Album A'], meaning: { mode, coverage, manifestPresent: mode === 'clip' } }
}
function setup(mode: 'clip' | 'metadata_text' = 'metadata_text', coverage = 1) {
  const generations: WebMcpTool[][] = []
  const signals: AbortSignal[] = []
  const context: ModelContextLike = {
    async registerTool(tool, options) {
      const current = generations.at(-1)
      if (!current || signals.at(-1) !== options.signal) {
        generations.push([]); signals.push(options.signal)
      }
      generations.at(-1)!.push(tool)
    },
  }
  const engine = new ShoeboxEngine({ loadSample: () => sample(mode, coverage), commitMoves: async () => undefined })
  const registry = new DynamicWebMcpRegistry(engine, context)
  return { engine, registry, generations, signals }
}
const names = (generation: WebMcpTool[]) => generation.map((tool) => tool.name)

describe('DynamicWebMcpRegistry', () => {
  it('registers exact S0 2, S1 6 and S2 6 surfaces and never forbidden authority', async () => {
    const { registry, generations } = setup()
    await registry.start()
    expect(names(generations.at(-1)!)).toEqual(['status', 'open_sample_album'])
    await registry.invokeForTest('open_sample_album', {})
    await registry.settled()
    expect(names(generations.at(-1)!)).toEqual(['status', 'find_duplicates', 'find_bursts', 'find_blurry', 'find_by_meaning', 'select'])
    const found = await registry.invokeForTest('find_duplicates', { sensitivity: 'normal' }) as { resultId: string }
    await registry.invokeForTest('select', { result_id: found.resultId })
    await registry.settled()
    expect(names(generations.at(-1)!)).toEqual(['select', 'status', 'peek', 'keep_sharpest', 'stage_move', 'build_album'])
    for (const generation of generations) {
      expect(generation.length).toBeLessThanOrEqual(6)
      expect(names(generation).some((name) => /delete|commit|discard|read_pixels|export/i.test(name))).toBe(false)
    }
  })

  it('aborts prior generations and stale descriptors refuse', async () => {
    const { registry, generations, signals } = setup()
    await registry.start()
    const stale = generations[0][0]
    await registry.invokeForTest('open_sample_album', {})
    await registry.settled()
    expect(signals[0].aborted).toBe(true)
    await expect(stale.execute({}, { signal: signals[0] })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('serializes transition registration so no mixed generation appears', async () => {
    const { registry, generations } = setup()
    await registry.start()
    await Promise.all([registry.invokeForTest('open_sample_album', {}), registry.settled()])
    expect(generations.every((generation) => generation.length <= 6)).toBe(true)
    expect(new Set(names(generations.at(-1)!)).size).toBe(generations.at(-1)!.length)
  })

  it('mints stage_move destinations per generation and old enums stay frozen', async () => {
    const { engine, registry, generations } = setup()
    await registry.start(); await registry.invokeForTest('open_sample_album', {})
    const found = await registry.invokeForTest('find_duplicates', { sensitivity: 'normal' }) as { resultId: string }
    await registry.invokeForTest('select', { result_id: found.resultId }); await registry.settled()
    const oldStage = generations.at(-1)!.find((tool) => tool.name === 'stage_move')!
    expect((oldStage.inputSchema.properties as Record<string, { enum: string[] }>).to.enum).toEqual(['Duplicates', 'Trash', 'Album A'])
    engine.humanAddAlbum('Album B')
    await registry.refresh(); await registry.settled()
    const newStage = generations.at(-1)!.find((tool) => tool.name === 'stage_move')!
    expect((newStage.inputSchema.properties as Record<string, { enum: string[] }>).to.enum).toContain('Album B')
    expect((oldStage.inputSchema.properties as Record<string, { enum: string[] }>).to.enum).not.toContain('Album B')
  })

  it('stage_move returns to S1 and select is not present in a seventh position', async () => {
    const { registry, generations } = setup()
    await registry.start(); await registry.invokeForTest('open_sample_album', {})
    const found = await registry.invokeForTest('find_duplicates', { sensitivity: 'normal' }) as { resultId: string }
    await registry.invokeForTest('select', { result_id: found.resultId }); await registry.settled()
    await registry.invokeForTest('stage_move', { to: 'Trash' }); await registry.settled()
    expect(names(generations.at(-1)!)).toEqual(['status', 'find_duplicates', 'find_bursts', 'find_blurry', 'find_by_meaning', 'select'])
    expect(generations.at(-1)!).toHaveLength(6)
  })

  it('gates find_by_meaning at 95 percent in both honest modes', async () => {
    for (const mode of ['clip', 'metadata_text'] as const) {
      const low = setup(mode, 0.949)
      await low.registry.start(); await low.registry.invokeForTest('open_sample_album', {}); await low.registry.settled()
      expect(names(low.generations.at(-1)!)).not.toContain('find_by_meaning')
      const pass = setup(mode, 0.95)
      await pass.registry.start(); await pass.registry.invokeForTest('open_sample_album', {}); await pass.registry.settled()
      expect(names(pass.generations.at(-1)!)).toContain('find_by_meaning')
    }
  })

  it('uses closed schemas, exact annotations, and one canonical execute seam', async () => {
    const { registry, generations } = setup()
    await registry.start()
    for (const tool of generations.at(-1)!) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean')
    }
    await expect(registry.invokeForTest('open_sample_album', { extra: true })).rejects.toThrow(/invalid_input/)
  })

  it('exposes no commit/discard/export capability on a public window seam', async () => {
    const { registry, generations } = setup()
    await registry.start()
    const publicWindow: Record<string, unknown> = {}
    registry.exposeBenchmarkSeam(publicWindow)
    expect(Object.keys(publicWindow)).toEqual(['shoeboxBenchmark'])
    expect(Object.keys(publicWindow.shoeboxBenchmark as object)).toEqual(['executeTool', 'getMetrics'])
    expect(JSON.stringify(publicWindow)).not.toMatch(/commit|discard|export/i)
    expect(generations.flatMap(names).some((name) => /commit|discard|export/i.test(name))).toBe(false)
  })

  it('keeps every non-peek tool result bounded and pixel-free across S0, S1 and S2', async () => {
    const checked = new Set<string>()
    function expectBounded(name: string, result: unknown) {
      const json = JSON.stringify(result)
      const object = result as Record<string, unknown>
      checked.add(name)
      expect(Buffer.byteLength(json, 'utf8'), `${name} result bytes`).toBeLessThanOrEqual(2_000)
      expect(Array.isArray(object.photos), `${name} must not expose photo rows`).toBe(false)
      expect(json, `${name} must not expose private row fields`).not.toMatch(/"(?:groups|selectedIds|thumbnailUrl|peekDataUrl|memberIds|photoIds)"/)
      expect(json, `${name} must not expose pixels`).not.toContain('data:image')
      expect(Object.isFrozen(result)).toBe(true)
    }

    const browse = setup()
    await browse.registry.start()
    expectBounded('status', await browse.registry.invokeForTest('status', {}))
    expectBounded('open_sample_album', await browse.registry.invokeForTest('open_sample_album', {}))
    const duplicates = await browse.registry.invokeForTest('find_duplicates', { sensitivity: 'normal' }) as { resultId: string }
    expectBounded('find_duplicates', duplicates)
    expectBounded('find_bursts', await browse.registry.invokeForTest('find_bursts', {}))
    expectBounded('find_blurry', await browse.registry.invokeForTest('find_blurry', {}))
    expectBounded('find_by_meaning', await browse.registry.invokeForTest('find_by_meaning', { query: 'pagoda' }))
    expectBounded('select', await browse.registry.invokeForTest('select', { result_id: duplicates.resultId }))
    expectBounded('status', await browse.registry.invokeForTest('status', {}))
    const peek = await browse.registry.invokeForTest('peek', { group_id: 'g1' }) as { thumbnails: { dataUrl: string; width: number; height: number }[] }
    expect(peek.thumbnails.every((item) => item.dataUrl.startsWith('data:image/') && item.width <= 96 && item.height <= 96)).toBe(true)

    for (const [name, input] of [
      ['keep_sharpest', {}],
      ['stage_move', { to: 'Trash' }],
      ['build_album', { name: 'Album A', target_count: 2 }],
    ] as const) {
      const selected = setup()
      await selected.registry.start()
      await selected.registry.invokeForTest('open_sample_album', {})
      const found = await selected.registry.invokeForTest('find_duplicates', { sensitivity: 'normal' }) as { resultId: string }
      await selected.registry.invokeForTest('select', { result_id: found.resultId })
      expectBounded(name, await selected.registry.invokeForTest(name, input))
    }

    expect([...checked].sort()).toEqual([
      'build_album', 'find_blurry', 'find_bursts', 'find_by_meaning', 'find_duplicates',
      'keep_sharpest', 'open_sample_album', 'select', 'stage_move', 'status',
    ])
  })
})

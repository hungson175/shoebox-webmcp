import { ShoeboxEngine } from '../engine/shoebox-engine'

export interface WebMcpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean }
  execute(input?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
}

export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options: { signal: AbortSignal }): Promise<void>
}

type ToolDefinition = Omit<WebMcpTool, 'execute'> & {
  run(input: Record<string, unknown>): unknown | Promise<unknown>
  allowedKeys: readonly string[]
}

function abortError(): DOMException {
  return new DOMException('WebMCP generation is no longer active', 'AbortError')
}

function assertActive(...signals: (AbortSignal | undefined)[]): void {
  if (signals.some((signal) => signal?.aborted)) throw abortError()
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input')
}

function assertExactKeys(input: Record<string, unknown>, allowedKeys: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) throw new Error('invalid_input')
}

function emptySchema(): Record<string, unknown> {
  return { type: 'object', properties: {}, additionalProperties: false }
}

function oneString(name: string, options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    properties: { [name]: { type: 'string', minLength: 1, ...options } },
    required: [name],
    additionalProperties: false,
  }
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  return value
}

export class DynamicWebMcpRegistry {
  private controller: AbortController | null = null
  private queue: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private active = new Map<string, WebMcpTool>()
  private metrics = { calls: 0, liveTools: 0, generation: 0 }

  constructor(private readonly engine: ShoeboxEngine, private readonly context: ModelContextLike | null) {}

  async start(): Promise<void> {
    if (!this.context) throw new Error('document.modelContext is unavailable')
    this.unsubscribe = this.engine.subscribe(() => this.scheduleSync())
    this.scheduleSync()
    await this.settled()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.controller?.abort()
    this.controller = null
    this.active.clear()
    this.metrics = { ...this.metrics, liveTools: 0 }
  }

  refresh(): Promise<void> {
    this.scheduleSync()
    return this.settled()
  }

  settled(): Promise<void> {
    return this.queue
  }

  async invokeForTest(name: string, input: Record<string, unknown>): Promise<unknown> {
    await this.settled()
    const tool = this.active.get(name)
    if (!tool) throw new Error(`unknown_tool:${name}`)
    const result = await tool.execute(input)
    await this.settled()
    return result
  }

  exposeBenchmarkSeam(target: Record<string, unknown>): void {
    const seam = Object.freeze({
      executeTool: async ({ name, input = {} }: { name: string; input?: Record<string, unknown> }) => this.invokeForTest(name, input),
      getMetrics: () => freezeDeep({ ...this.metrics }),
    })
    Object.defineProperty(target, 'shoeboxBenchmark', { value: seam, enumerable: true, configurable: true, writable: false })
  }

  removeBenchmarkSeam(target: Record<string, unknown>): void {
    delete target.shoeboxBenchmark
  }

  private scheduleSync(): void {
    this.queue = this.queue.then(() => this.sync())
  }

  private async sync(): Promise<void> {
    if (!this.context) return
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const toolNames = this.engine.activeToolNames()
    if (toolNames.length > 6) throw new Error('WebMCP live-tool cap exceeded')
    const next = new Map<string, WebMcpTool>()
    for (const name of toolNames) {
      const tool = freezeDeep(this.makeTool(name, controller.signal))
      next.set(name, tool)
      await this.context.registerTool(tool, { signal: controller.signal })
    }
    this.active = next
    this.metrics = { ...this.metrics, liveTools: toolNames.length, generation: this.metrics.generation + 1 }
  }

  private makeTool(name: string, generationSignal: AbortSignal): WebMcpTool {
    const definition = this.definition(name)
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: freezeDeep(structuredClone(definition.inputSchema)),
      annotations: freezeDeep({ ...definition.annotations }),
      execute: async (rawInput = {}, options = {}) => {
        assertActive(generationSignal, options.signal)
        assertRecord(rawInput)
        assertExactKeys(rawInput, definition.allowedKeys)
        const result = await definition.run(rawInput)
        // A successful state-changing call intentionally causes its own registry
        // generation to abort. Only a caller cancellation may invalidate the
        // already-computed receipt at this point.
        assertActive(options.signal)
        this.metrics = { ...this.metrics, calls: this.metrics.calls + 1 }
        return freezeDeep(structuredClone(result))
      },
    }
  }

  private definition(name: string): ToolDefinition {
    const empty = (description: string, readOnlyHint: boolean, run: () => unknown | Promise<unknown>): ToolDefinition => ({
      name, description, inputSchema: emptySchema(), annotations: { readOnlyHint }, allowedKeys: [], run,
    })
    switch (name) {
      case 'status':
        return empty('Return the current local library, staged-plan, custody and capability summary.', true, () => this.engine.status())
      case 'open_sample_album':
        return empty('Open the bundled 500-photo local sample album; no folder picker or network request.', false, () => {
          this.engine.openSampleAlbum()
          return this.engine.status()
        })
      case 'find_duplicates':
        return {
          name, description: 'Find exact or normal duplicate groups and return one opaque result handle, never photo rows.',
          inputSchema: oneString('sensitivity', { enum: ['exact', 'normal'] }), annotations: { readOnlyHint: true }, allowedKeys: ['sensitivity'],
          run: (input) => {
            if (input.sensitivity !== 'exact' && input.sensitivity !== 'normal') throw new Error('invalid_input')
            return this.engine.findDuplicates(input.sensitivity)
          },
        }
      case 'find_bursts':
        return empty('Find camera-timed burst groups and return one opaque result handle.', true, () => this.engine.findBursts())
      case 'find_blurry':
        return {
          name, description: 'Find locally measured blurry photos and return one opaque result handle.',
          inputSchema: { type: 'object', properties: { max_sharpness: { type: 'number', minimum: 0 } }, additionalProperties: false },
          annotations: { readOnlyHint: true }, allowedKeys: ['max_sharpness'],
          run: (input) => {
            if (input.max_sharpness !== undefined && (typeof input.max_sharpness !== 'number' || input.max_sharpness < 0)) throw new Error('invalid_input')
            return this.engine.findBlurry(input.max_sharpness as number | undefined)
          },
        }
      case 'find_by_meaning':
        return {
          name, description: `Find photos by plain-language ${this.engine.snapshot().meaning.mode === 'clip' ? 'CLIP' : 'filename, caption and EXIF metadata'} similarity and return one opaque result handle.`,
          inputSchema: oneString('query'), annotations: { readOnlyHint: true }, allowedKeys: ['query'],
          run: (input) => {
            if (typeof input.query !== 'string') throw new Error('invalid_input')
            return this.engine.findByMeaning(input.query)
          },
        }
      case 'select':
        return {
          name, description: 'Select the photos behind a current opaque result handle for the next bounded operation.',
          inputSchema: oneString('result_id'), annotations: { readOnlyHint: false }, allowedKeys: ['result_id'],
          run: (input) => {
            if (typeof input.result_id !== 'string') throw new Error('invalid_input')
            this.engine.select(input.result_id)
            return this.engine.selectionReceipt()
          },
        }
      case 'peek':
        return {
          name, description: 'Return only 96-pixel page-local thumbnails for one currently selected group and count the request.',
          inputSchema: oneString('group_id'), annotations: { readOnlyHint: true }, allowedKeys: ['group_id'],
          run: (input) => {
            if (typeof input.group_id !== 'string') throw new Error('invalid_input')
            return this.engine.peek(input.group_id)
          },
        }
      case 'keep_sharpest':
        return empty('Stage non-keepers from selected groups into Duplicates; delete nothing and clear selection.', false, () => this.engine.keepSharpest())
      case 'stage_move': {
        const destinations = [...this.engine.destinations()]
        return {
          name, description: 'Stage selected photos to one currently visible tray or album; Trash is a staged destination, never deletion.',
          inputSchema: oneString('to', { enum: destinations }), annotations: { readOnlyHint: false }, allowedKeys: ['to'],
          run: (input) => {
            if (typeof input.to !== 'string' || !destinations.includes(input.to)) throw new Error('invalid_destination')
            return this.engine.stageMove(input.to, destinations)
          },
        }
      }
      case 'build_album':
        return {
          name, description: 'Stage selected moments into one visible album with a bounded target count; write nothing.',
          inputSchema: {
            type: 'object', properties: { name: { type: 'string', enum: [...this.engine.snapshot().albums.map((album) => album.name)] }, target_count: { type: 'integer', minimum: 1, maximum: 500 } },
            required: ['name', 'target_count'], additionalProperties: false,
          }, annotations: { readOnlyHint: false }, allowedKeys: ['name', 'target_count'],
          run: (input) => {
            if (typeof input.name !== 'string' || typeof input.target_count !== 'number' || !Number.isInteger(input.target_count)) throw new Error('invalid_input')
            return this.engine.buildAlbum(input.name, input.target_count)
          },
        }
      default:
        throw new Error(`unknown_tool:${name}`)
    }
  }
}

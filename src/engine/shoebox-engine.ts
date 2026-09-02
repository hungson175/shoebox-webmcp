export type ShoeboxPhase = 'NO_LIBRARY' | 'BROWSE' | 'SELECTED'
export type MeaningMode = 'clip' | 'metadata_text'

export interface EnginePhoto {
  id: string
  thumbnailUrl: string
  peekDataUrl: string
  peekWidth: number
  peekHeight: number
  alt: string
  dayLabel: string
  moment: string
  groupId?: string
  sharpness: number
  blurry: boolean
}

export interface PhotoGroup {
  id: string
  kind: 'exact-duplicate' | 'near-duplicate' | 'burst'
  memberIds: string[]
  keeperId: string
}

export interface SampleLibrary {
  id: string
  name: string
  photos: EnginePhoto[]
  groups: PhotoGroup[]
  trays: string[]
  albums: string[]
  meaning: { mode: MeaningMode; coverage: number; manifestPresent: boolean }
  initialPlan?: {
    moves: { photoId: string; to: string }[]
    albums: { name: string; photoIds: string[] }[]
  }
}

export interface ResultReceipt {
  resultId: string
  kind: string
  groupCount: number
  memberCount: number
  mode?: string
  coverage?: number
}

export interface ShoeboxSnapshot {
  version: number
  phase: ShoeboxPhase
  libraryGeneration: number
  libraryId?: string
  libraryName?: string
  totalCount: number
  photos: readonly EnginePhoto[]
  groups: readonly PhotoGroup[]
  selectedIds: readonly string[]
  trays: readonly { name: string; photoIds: readonly string[] }[]
  albums: readonly { name: string; photoIds: readonly string[] }[]
  plan: { moves: number; albums: number; deletes: 0 }
  counters: { pixelsRequestedGroups: number; pixelsRequestedPhotos: number; libraryPhotos: number }
  meaning: { mode: MeaningMode | 'unavailable'; coverage: number; manifestPresent: boolean }
  activity: string
}

interface ResultHandle {
  generation: number
  kind: string
  groupIds: string[]
  photoIds: string[]
}

interface PlannedMove {
  photoId: string
  to: string
}

export interface ShoeboxEngineOptions {
  loadSample: () => SampleLibrary
  commitMoves: (moves: readonly PlannedMove[]) => Promise<void>
}

type Listener = () => void

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function boundedCoverage(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

export class ShoeboxEngine {
  private readonly listeners = new Set<Listener>()
  private readonly handles = new Map<string, ResultHandle>()
  private readonly plannedMoves = new Map<string, PlannedMove>()
  private readonly trayMembers = new Map<string, Set<string>>()
  private readonly albumMembers = new Map<string, Set<string>>()
  private library: SampleLibrary | null = null
  private selectedIds: string[] = []
  private version = 0
  private libraryGeneration = 0
  private resultSequence = 0
  private pixelsRequestedGroups = 0
  private pixelsRequestedPhotos = 0
  private activity = 'Waiting for a library'
  private currentSnapshot: ShoeboxSnapshot

  constructor(private readonly options: ShoeboxEngineOptions) {
    this.currentSnapshot = this.buildSnapshot()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): ShoeboxSnapshot => this.currentSnapshot

  openSampleAlbum(): ShoeboxSnapshot {
    const sample = this.options.loadSample()
    if (this.library?.id === sample.id) return this.currentSnapshot
    return this.replaceLibrary(sample)
  }

  replaceLibrary(library: SampleLibrary): ShoeboxSnapshot {
    this.validateLibrary(library)
    this.library = deepFreeze(structuredClone(library))
    this.libraryGeneration += 1
    this.selectedIds = []
    this.plannedMoves.clear()
    this.trayMembers.clear()
    this.albumMembers.clear()
    for (const tray of library.trays) this.trayMembers.set(tray, new Set())
    for (const album of library.albums) this.albumMembers.set(album, new Set())
    for (const move of library.initialPlan?.moves ?? []) {
      const destination = this.trayMembers.get(move.to) ?? this.albumMembers.get(move.to)
      if (!destination) throw new Error('invalid_initial_destination')
      destination.add(move.photoId)
      this.plannedMoves.set(move.photoId, { ...move })
    }
    for (const album of library.initialPlan?.albums ?? []) {
      const target = this.albumMembers.get(album.name)
      if (!target) throw new Error('invalid_initial_album')
      for (const id of album.photoIds) target.add(id)
    }
    this.pixelsRequestedGroups = 0
    this.pixelsRequestedPhotos = 0
    this.activity = `${library.photos.length} local sample photos ready`
    return this.publish()
  }

  activeToolNames(): string[] {
    if (!this.library) return ['status', 'open_sample_album']
    if (this.selectedIds.length > 0) {
      return ['select', 'status', 'peek', 'keep_sharpest', 'stage_move', 'build_album']
    }
    const names = ['status', 'find_duplicates', 'find_bursts', 'find_blurry']
    if (this.meaningAvailable()) names.push('find_by_meaning')
    names.push('select')
    return names
  }

  status(): ShoeboxSnapshot {
    return this.currentSnapshot
  }

  findDuplicates(mode: 'exact' | 'normal'): ResultReceipt {
    this.requireLibrary()
    const groups = this.library!.groups.filter((group) => mode === 'exact'
      ? group.kind === 'exact-duplicate'
      : group.kind !== 'burst' || this.library!.groups.length <= 2)
    return this.createResult('duplicates', groups, mode)
  }

  findBursts(): ResultReceipt {
    this.requireLibrary()
    return this.createResult('bursts', this.library!.groups.filter((group) => group.kind === 'burst'))
  }

  findBlurry(maxSharpness = Number.POSITIVE_INFINITY): ResultReceipt {
    this.requireLibrary()
    const photoIds = this.library!.photos
      .filter((photo) => photo.blurry && photo.sharpness <= maxSharpness)
      .map((photo) => photo.id)
    return this.createPhotoResult('blurry', photoIds)
  }

  findByMeaning(query: string): ResultReceipt {
    this.requireLibrary()
    if (!this.meaningAvailable()) throw new Error('meaning_unavailable')
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) throw new Error('invalid_query')
    const photoIds = this.library!.photos
      .filter((photo) => `${photo.alt} ${photo.moment} ${photo.dayLabel}`.toLocaleLowerCase().includes(needle))
      .map((photo) => photo.id)
    const receipt = this.createPhotoResult('meaning', photoIds)
    return deepFreeze({
      ...receipt,
      mode: this.library!.meaning.mode,
      coverage: boundedCoverage(this.library!.meaning.coverage),
    })
  }

  select(resultId: string): ShoeboxSnapshot {
    this.requireLibrary()
    const handle = this.handles.get(resultId)
    if (!handle) throw new Error('unknown_result')
    if (handle.generation !== this.libraryGeneration) throw new Error('stale_result')
    if (handle.photoIds.length === 0) throw new Error('empty_result')
    this.selectedIds = [...handle.photoIds]
    this.activity = `${this.selectedIds.length} photos selected from ${handle.kind}`
    return this.publish()
  }

  peek(groupId: string): Readonly<{ groupId: string; thumbnails: readonly { id: string; dataUrl: string; width: number; height: number }[] }> {
    this.requireSelection()
    const group = this.library!.groups.find((candidate) => candidate.id === groupId)
    if (!group || !group.memberIds.some((id) => this.selectedIds.includes(id))) throw new Error('group_not_selected')
    const byId = new Map(this.library!.photos.map((photo) => [photo.id, photo]))
    const thumbnails = group.memberIds.map((id) => {
      const photo = byId.get(id)
      if (!photo || !photo.peekDataUrl.startsWith('data:image/')) throw new Error('invalid_peek_thumbnail')
      if (photo.peekWidth > 96 || photo.peekHeight > 96) throw new Error('peek_thumbnail_too_large')
      return { id, dataUrl: photo.peekDataUrl, width: photo.peekWidth, height: photo.peekHeight }
    })
    this.pixelsRequestedGroups += 1
    this.pixelsRequestedPhotos += thumbnails.length
    this.activity = `Peeked at ${group.id}; thumbnails only`
    this.publish()
    return deepFreeze({ groupId, thumbnails })
  }

  keepSharpest(): Readonly<{ phase: 'BROWSE'; destination: 'Duplicates'; moves: number; deletes: 0 }> {
    this.requireSelection()
    const selected = new Set(this.selectedIds)
    const groups = this.library!.groups.filter((group) => group.memberIds.some((id) => selected.has(id)))
    const nonKeepers = groups.flatMap((group) => group.memberIds.filter((id) => id !== group.keeperId))
    return this.stageIds(nonKeepers, 'Duplicates')
  }

  stageMove(destination: string, allowedDestinations: readonly string[]): Readonly<{ phase: 'BROWSE'; destination: string; moves: number; deletes: 0 }> {
    this.requireSelection()
    if (!allowedDestinations.includes(destination)) throw new Error('invalid_destination')
    return this.stageIds(this.selectedIds, destination)
  }

  buildAlbum(name: string, targetCount: number): Readonly<{ phase: 'BROWSE'; album: string; photos: number; moves: number; deletes: 0 }> {
    this.requireSelection()
    const safeName = name.trim()
    if (!safeName || !this.albumMembers.has(safeName)) throw new Error('invalid_album')
    const count = Math.max(1, Math.min(Math.floor(targetCount), this.selectedIds.length))
    const target = this.albumMembers.get(safeName)!
    for (const id of this.selectedIds.slice(0, count)) target.add(id)
    this.selectedIds = []
    this.activity = `${count} photos staged for ${safeName}`
    this.publish()
    return deepFreeze({ phase: 'BROWSE', album: safeName, photos: count, moves: this.plannedMoves.size, deletes: 0 })
  }

  destinations(): readonly string[] {
    this.requireLibrary()
    return deepFreeze([...this.trayMembers.keys(), ...this.albumMembers.keys()])
  }

  humanAddAlbum(name: string): ShoeboxSnapshot {
    this.requireLibrary()
    const safeName = name.trim()
    if (!safeName) throw new Error('invalid_album')
    if (!this.albumMembers.has(safeName)) this.albumMembers.set(safeName, new Set())
    return this.publish()
  }

  humanTogglePhoto(id: string): ShoeboxSnapshot {
    this.requireLibrary()
    if (!this.library!.photos.some((photo) => photo.id === id)) throw new Error('unknown_photo')
    this.selectedIds = this.selectedIds.includes(id)
      ? this.selectedIds.filter((selected) => selected !== id)
      : [...this.selectedIds, id]
    return this.publish()
  }

  humanUnstagePhoto(id: string, destination: string): ShoeboxSnapshot {
    this.requireLibrary()
    this.trayMembers.get(destination)?.delete(id)
    this.albumMembers.get(destination)?.delete(id)
    this.plannedMoves.delete(id)
    this.activity = 'Plan updated with your change'
    return this.publish()
  }

  humanAddPhotos(photos: EnginePhoto[], libraryName = 'Dropped photo folder'): ShoeboxSnapshot {
    if (photos.length === 0) return this.currentSnapshot
    if (!this.library) {
      const next: SampleLibrary = {
        id: `local-${this.libraryGeneration + 1}`,
        name: libraryName,
        photos,
        groups: [],
        trays: ['Duplicates', 'Trash'],
        albums: ['Family album'],
        meaning: { mode: 'metadata_text', coverage: 1, manifestPresent: false },
      }
      const snapshot = this.replaceLibrary(next)
      this.activity = `Adding ${photos.length} new ${photos.length === 1 ? 'photo' : 'photos'} without stopping`
      return this.publish()
    }
    const next = structuredClone(this.library)
    next.photos.push(...photos)
    this.replaceLibrary(next)
    this.activity = `Adding ${photos.length} new ${photos.length === 1 ? 'photo' : 'photos'} without stopping`
    return this.publish()
  }

  async humanCommit(isTrusted: boolean): Promise<Readonly<{ written: 0; deletes: 0; demo: true }>> {
    if (!isTrusted) throw new Error('trusted_human_required')
    const moves = deepFreeze([...this.plannedMoves.values()].map((move) => ({ ...move })))
    await this.options.commitMoves(moves)
    this.clearPlan('Sample plan committed in page memory; 0 files written')
    return deepFreeze({ written: 0, deletes: 0, demo: true })
  }

  humanDiscard(isTrusted: boolean): ShoeboxSnapshot {
    if (!isTrusted) throw new Error('trusted_human_required')
    return this.clearPlan('Plan discarded; 0 file-system writes')
  }

  humanExport(isTrusted: boolean): Readonly<{ library: string; albums: readonly { name: string; photoIds: readonly string[] }[] }> {
    if (!isTrusted) throw new Error('trusted_human_required')
    this.requireLibrary()
    return deepFreeze({
      library: this.library!.name,
      albums: [...this.albumMembers].map(([name, ids]) => ({ name, photoIds: [...ids] })),
    })
  }

  private createResult(kind: string, groups: PhotoGroup[], mode?: string): ResultReceipt {
    return this.storeResult(kind, groups.map((group) => group.id), unique(groups.flatMap((group) => group.memberIds)), mode)
  }

  private createPhotoResult(kind: string, photoIds: string[]): ResultReceipt {
    const groupIds = unique(this.library!.groups.filter((group) => group.memberIds.some((id) => photoIds.includes(id))).map((group) => group.id))
    return this.storeResult(kind, groupIds, unique(photoIds))
  }

  private storeResult(kind: string, groupIds: string[], photoIds: string[], mode?: string): ResultReceipt {
    const resultId = `result-${this.libraryGeneration.toString(36)}-${(++this.resultSequence).toString(36)}-${kind}`
    this.handles.set(resultId, deepFreeze({ generation: this.libraryGeneration, kind, groupIds: [...groupIds], photoIds: [...photoIds] }))
    this.activity = `${photoIds.length} photos matched ${kind}`
    this.publish()
    return deepFreeze({ resultId, kind, groupCount: groupIds.length, memberCount: photoIds.length, ...(mode ? { mode } : {}) })
  }

  private stageIds<T extends string>(ids: readonly string[], destination: T): Readonly<{ phase: 'BROWSE'; destination: T; moves: number; deletes: 0 }> {
    const destinationSet = this.trayMembers.get(destination) ?? this.albumMembers.get(destination)
    if (!destinationSet) throw new Error('invalid_destination')
    for (const id of unique(ids)) {
      destinationSet.add(id)
      this.plannedMoves.set(id, { photoId: id, to: destination })
    }
    this.selectedIds = []
    this.activity = `${ids.length} photos staged to ${destination}`
    this.publish()
    return deepFreeze({ phase: 'BROWSE', destination, moves: this.plannedMoves.size, deletes: 0 })
  }

  private clearPlan(activity: string): ShoeboxSnapshot {
    this.plannedMoves.clear()
    for (const ids of this.trayMembers.values()) ids.clear()
    for (const ids of this.albumMembers.values()) ids.clear()
    this.selectedIds = []
    this.activity = activity
    return this.publish()
  }

  private meaningAvailable(): boolean {
    if (!this.library) return false
    const { mode, coverage, manifestPresent } = this.library.meaning
    if (boundedCoverage(coverage) < 0.95) return false
    return mode === 'metadata_text' || (mode === 'clip' && manifestPresent)
  }

  private requireLibrary(): void {
    if (!this.library) throw new Error('library_required')
  }

  private requireSelection(): void {
    this.requireLibrary()
    if (this.selectedIds.length === 0) throw new Error('selection_required')
  }

  private validateLibrary(library: SampleLibrary): void {
    if (!library.id || !library.name || library.photos.length === 0) throw new Error('invalid_library')
    if (new Set(library.photos.map((photo) => photo.id)).size !== library.photos.length) throw new Error('duplicate_photo_id')
    const photoIds = new Set(library.photos.map((photo) => photo.id))
    for (const move of library.initialPlan?.moves ?? []) {
      if (!photoIds.has(move.photoId)) throw new Error('invalid_initial_photo')
    }
    for (const album of library.initialPlan?.albums ?? []) {
      if (album.photoIds.some((id) => !photoIds.has(id))) throw new Error('invalid_initial_photo')
    }
  }

  private publish(): ShoeboxSnapshot {
    this.version += 1
    this.currentSnapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
    return this.currentSnapshot
  }

  private buildSnapshot(): ShoeboxSnapshot {
    const phase: ShoeboxPhase = !this.library ? 'NO_LIBRARY' : this.selectedIds.length ? 'SELECTED' : 'BROWSE'
    return deepFreeze({
      version: this.version,
      phase,
      libraryGeneration: this.libraryGeneration,
      ...(this.library ? { libraryId: this.library.id, libraryName: this.library.name } : {}),
      totalCount: this.library?.photos.length ?? 0,
      photos: this.library ? structuredClone(this.library.photos) : [],
      groups: this.library ? structuredClone(this.library.groups) : [],
      selectedIds: [...this.selectedIds],
      trays: [...this.trayMembers].map(([name, ids]) => ({ name, photoIds: [...ids] })),
      albums: [...this.albumMembers].map(([name, ids]) => ({ name, photoIds: [...ids] })),
      plan: { moves: this.plannedMoves.size, albums: [...this.albumMembers.values()].filter((ids) => ids.size > 0).length, deletes: 0 as const },
      counters: { pixelsRequestedGroups: this.pixelsRequestedGroups, pixelsRequestedPhotos: this.pixelsRequestedPhotos, libraryPhotos: this.library?.photos.length ?? 0 },
      meaning: this.library
        ? { mode: this.library.meaning.mode, coverage: boundedCoverage(this.library.meaning.coverage), manifestPresent: this.library.meaning.manifestPresent }
        : { mode: 'unavailable' as const, coverage: 0, manifestPresent: false },
      activity: this.activity,
    })
  }
}

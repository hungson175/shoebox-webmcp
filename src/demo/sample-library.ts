import type { EnginePhoto, PhotoGroup, SampleLibrary } from '../engine/shoebox-engine'

const MOMENTS = ['Pagoda', 'Flower market', 'Family meal', 'Lucky money', 'Garden portraits', 'Train ride', 'Grandkids together']
const PALETTE = [
  ['#a75b3d', '#e5bd78', '#64745a'],
  ['#5c776d', '#d8c39f', '#be7949'],
  ['#374e58', '#ddb66b', '#8a5239'],
  ['#805446', '#d9a66f', '#697f76'],
  ['#4e6250', '#edd59c', '#bd6e51'],
]

function svgScene(index: number, edge: number): string {
  const [sky, sun, ground] = PALETTE[index % PALETTE.length]
  const x = 28 + ((index * 23) % 190)
  const y = 22 + ((index * 17) % 70)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${Math.round(edge * 0.7)}" viewBox="0 0 300 210"><rect width="300" height="210" fill="${sky}"/><circle cx="${x}" cy="${y}" r="31" fill="${sun}" opacity=".88"/><path d="M0 157L72 93l49 43 49-63 130 94v43H0z" fill="${ground}"/><path d="M0 181q78-44 151 0t149-4v33H0z" fill="#26352f" opacity=".5"/></svg>`
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function groupSizes(): number[] {
  return [...Array.from({ length: 60 }, () => 5), ...Array.from({ length: 24 }, () => 4)]
}

export function createSampleLibrary(): SampleLibrary {
  const sizes = groupSizes()
  const groupForPhoto = new Map<number, { id: string; memberIndex: number }>()
  const groups: PhotoGroup[] = []
  let cursor = 0
  sizes.forEach((size, index) => {
    const memberIndexes = Array.from({ length: size }, (_, offset) => cursor + offset)
    const id = `group-${String(index + 1).padStart(3, '0')}`
    for (const [memberIndex, photoIndex] of memberIndexes.entries()) groupForPhoto.set(photoIndex, { id, memberIndex })
    groups.push({
      id,
      kind: index % 3 === 0 ? 'exact-duplicate' : index % 3 === 1 ? 'near-duplicate' : 'burst',
      memberIds: memberIndexes.map((photoIndex) => `tet-${String(photoIndex + 1).padStart(3, '0')}`),
      keeperId: `tet-${String(memberIndexes.at(-1)! + 1).padStart(3, '0')}`,
    })
    cursor += size
  })

  const photos: EnginePhoto[] = Array.from({ length: 500 }, (_, index) => {
    const moment = MOMENTS[index % MOMENTS.length]
    const group = groupForPhoto.get(index)
    const fullSvg = svgScene(index, 300)
    const peekSvg = svgScene(index, 96)
    return {
      id: `tet-${String(index + 1).padStart(3, '0')}`,
      thumbnailUrl: `data:image/svg+xml,${encodeURIComponent(fullSvg)}`,
      peekDataUrl: `data:image/svg+xml;base64,${base64(peekSvg)}`,
      peekWidth: 96,
      peekHeight: 67,
      alt: `${moment}, photo ${index + 1}`,
      dayLabel: `Tết day ${(index % 5) + 1}`,
      moment,
      ...(group ? { groupId: group.id } : {}),
      sharpness: group ? group.memberIndex + 1 : 10,
      blurry: Boolean(group && group.memberIndex === 0),
    }
  })

  const nonKeepers = groups.flatMap((group) => group.memberIds.filter((id) => id !== group.keeperId))
  const albumIds = groups.map((group) => group.keeperId).slice(0, 60)
  return {
    id: 'shoebox-tet-demo-v1',
    name: 'Family Tết 2026',
    photos,
    groups,
    trays: ['Duplicates', 'Trash'],
    albums: ['Bà Nội’s Tết album'],
    meaning: { mode: 'metadata_text', coverage: 1, manifestPresent: false },
    initialPlan: {
      moves: nonKeepers.map((photoId) => ({ photoId, to: 'Duplicates' })),
      albums: [{ name: 'Bà Nội’s Tết album', photoIds: albumIds }],
    },
  }
}

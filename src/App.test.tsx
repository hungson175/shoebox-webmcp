import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { WebMcpTool } from './webmcp/dynamic-registry'

afterEach(() => {
  vi.restoreAllMocks()
  delete (document as Document & { modelContext?: unknown }).modelContext
  delete (window as Window & { shoeboxBenchmark?: unknown }).shoeboxBenchmark
})

async function openSample() {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Open sample album' }))
  return user
}

describe('sample experience', () => {
  it('loads the 500-photo sample in one click and presents the staged plan', async () => {
    await openSample()
    expect(screen.getByText('500 photos indexed')).toBeVisible()
    expect(screen.getByRole('region', { name: 'Duplicates tray' })).toBeVisible()
    expect(screen.getByText('Commit 312 moves plus 1 album, 0 deletes')).toBeVisible()
  })

  it('keeps selection and pull-back actions in the live plan before human Commit', async () => {
    const user = await openSample()
    await user.click(screen.getByRole('button', { name: 'Select Pagoda, photo 1' }))
    expect(screen.getByText('1 selected')).toBeVisible()

    const tray = screen.getByRole('region', { name: 'Duplicates tray' })
    await user.click(within(tray).getAllByRole('button', { name: /back into the library$/ })[0])
    expect(screen.getByText('Commit 311 moves plus 1 album, 0 deletes')).toBeVisible()
    expect(screen.getByText('Plan updated with your change')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Commit 311 moves plus 1 album, 0 deletes' }))
    expect(screen.getByText('Sample plan committed in page memory; 0 files written')).toBeVisible()
    expect(within(tray).getByText('Nothing staged here.')).toBeVisible()
  })

  it('lets the human discard the entire staged plan', async () => {
    const user = await openSample()
    await user.click(screen.getByRole('button', { name: 'Discard plan' }))
    expect(screen.getByText('Plan discarded; 0 file-system writes')).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Bà Nội’s Tết album' })).not.toBeInTheDocument()
    expect(screen.getByText('Commit 0 moves plus 0 albums, 0 deletes')).toBeVisible()
  })

  it('exports only the staged album manifest from the human button', async () => {
    const user = await openSample()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:album')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await user.click(screen.getByRole('button', { name: 'Export album' }))
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:album')
  })

  it('accepts an image drop from the empty screen without inventing non-images', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:dropped-photo')
    render(<App />)
    const image = new File(['photo'], 'family.jpg', { type: 'image/jpeg', lastModified: 10 })
    const note = new File(['note'], 'note.txt', { type: 'text/plain', lastModified: 11 })
    fireEvent.drop(screen.getByTestId('library-drop-zone'), { dataTransfer: { files: [image, note] } })
    expect(screen.getByText('Dropped photo folder')).toBeVisible()
    expect(screen.getByText('1 photos indexed')).toBeVisible()
    expect(screen.getByText('Adding 1 new photo without stopping')).toBeVisible()
    expect(screen.queryByAltText('note.txt')).not.toBeInTheDocument()
  })

  it('uses one engine for visible state and the exact native 2 to 6 registry', async () => {
    const generations: WebMcpTool[][] = []
    const signals: AbortSignal[] = []
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        async registerTool(tool: WebMcpTool, options: { signal: AbortSignal }) {
          if (signals.at(-1) !== options.signal) {
            signals.push(options.signal)
            generations.push([])
          }
          generations.at(-1)!.push(tool)
        },
      },
    })
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(generations.at(-1)?.map((tool) => tool.name)).toEqual(['status', 'open_sample_album']))
    await user.click(screen.getByRole('button', { name: 'Open sample album' }))
    await waitFor(() => expect(generations.at(-1)?.map((tool) => tool.name)).toEqual(['status', 'find_duplicates', 'find_bursts', 'find_blurry', 'find_by_meaning', 'select']))
    expect(screen.getByText('6 tools live')).toBeVisible()
    expect(screen.getByText(/Metadata text · 100% coverage/)).toBeVisible()
    const benchmark = (window as unknown as { shoeboxBenchmark: object }).shoeboxBenchmark
    expect(Object.keys(benchmark)).toEqual(['executeTool', 'getMetrics'])
    expect(JSON.stringify(benchmark)).not.toMatch(/commit|discard|export/i)
  })
})

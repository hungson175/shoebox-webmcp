// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('public origin-trial boot order', () => {
  it('ships the current Shoebox token before any application script', async () => {
    const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8')
    const tokenMatch = html.match(/<meta\s+http-equiv="origin-trial"\s+content="([^"]+)"\s*\/?>/i)
    expect(tokenMatch).not.toBeNull()
    expect(html.indexOf(tokenMatch![0])).toBeLessThan(html.indexOf('<script'))

    const decoded = Buffer.from(tokenMatch![1], 'base64').toString('utf8')
    const payload = JSON.parse(decoded.slice(decoded.lastIndexOf('{'))) as Record<string, unknown>
    expect(payload).toEqual({
      origin: 'https://hungson175.github.io:443',
      feature: 'WebMCP',
      expiry: 1794873600,
    })
  })
})

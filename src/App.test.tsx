import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('sample experience', () => {
  it('loads the 500-photo sample in one click and presents the staged plan', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Open sample album' }))
    expect(screen.getByText('500 photos indexed')).toBeVisible()
    expect(screen.getByRole('region', { name: 'Duplicates tray' })).toBeVisible()
    expect(screen.getByText('Commit 312 moves plus 1 album, 0 deletes')).toBeVisible()
  })
})

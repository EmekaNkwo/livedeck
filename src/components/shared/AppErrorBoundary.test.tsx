import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storageKey } from '@/services/persistence/local-store'
import { AppErrorBoundary } from './AppErrorBoundary'

function Bomb({ message }: { message: string }): never {
  throw new Error(message)
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('AppErrorBoundary', () => {
  it('renders a recovery screen instead of a blank page', () => {
    render(
      <AppErrorBoundary>
        <Bomb message="canvas exploded" />
      </AppErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('canvas exploded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reset studio state/i })).toBeInTheDocument()
  })

  it('reset clears only this app’s localStorage namespace', async () => {
    localStorage.setItem(storageKey('doc:x'), '{}')
    localStorage.setItem('other-app', 'keep')
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: vi.fn(), set href(v: string) { assign(v) } },
    })
    render(
      <AppErrorBoundary>
        <Bomb message="x" />
      </AppErrorBoundary>,
    )
    await userEvent.click(screen.getByRole('button', { name: /reset studio state/i }))
    expect(localStorage.getItem(storageKey('doc:x'))).toBeNull()
    expect(localStorage.getItem('other-app')).toBe('keep')
    expect(assign).toHaveBeenCalledWith('/')
  })

  it('reloads once automatically for a stale chunk', () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
    render(
      <AppErrorBoundary>
        <Bomb message="Failed to fetch dynamically imported module: /assets/DirectorPage-abc.js" />
      </AppErrorBoundary>,
    )
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('livedeck:chunk-retry')).toBe('1')
    // A second failure does not loop.
    render(
      <AppErrorBoundary>
        <Bomb message="Failed to fetch dynamically imported module: /assets/DirectorPage-abc.js" />
      </AppErrorBoundary>,
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

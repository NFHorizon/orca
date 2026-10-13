// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPageSourceActions } from './browser-toolbar-menu-dropdown'

vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }): ReactNode => children
  const block = ({ children }: { children?: ReactNode }): ReactNode => <div>{children}</div>
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: block,
    DropdownMenuItem: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    ),
    DropdownMenuPortal: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: block,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: block,
    DropdownMenuSubTrigger: block,
    DropdownMenuTrigger: passthrough
  }
})
vi.mock('@/components/BrowserCookieImportDisclosure', () => ({
  BrowserCookieImportDisclosure: () => null
}))
vi.mock('@/components/BrowserCookieImportMachineNotice', () => ({
  BrowserCookieImportMachineNotice: () => null
}))
vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

import { BrowserToolbarMenuDropdown } from './browser-toolbar-menu-dropdown'

function renderMenu(sourceActions?: BrowserPageSourceActions | null): void {
  render(
    <BrowserToolbarMenuDropdown
      menuOpen
      onMenuOpenChange={vi.fn()}
      allProfiles={[]}
      effectiveProfileId="default"
      onSwitchProfile={vi.fn()}
      onNewProfile={vi.fn()}
      detectedBrowsers={[]}
      onFetchDetectedBrowsers={vi.fn()}
      browserSessionImportState={null}
      onImportFromBrowser={vi.fn()}
      onImportFromFile={vi.fn()}
      viewportPresetId={null}
      onApplyViewportPreset={vi.fn()}
      sourceActions={sourceActions}
      overflow={{
        triggerRef: createRef(),
        tools: [],
        deferUntilClose: vi.fn(),
        onMenuCloseAutoFocus: vi.fn()
      }}
    />
  )
}

afterEach(cleanup)

describe('browser menu source actions', () => {
  it('offers the source file and devtools for a local file page', () => {
    const sourceActions = { onOpenSource: vi.fn(), onOpenDevTools: vi.fn() }
    renderMenu(sourceActions)

    fireEvent.click(screen.getByRole('button', { name: 'Open source file' }))
    expect(sourceActions.onOpenSource).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Open browser devtools' }))
    expect(sourceActions.onOpenDevTools).toHaveBeenCalledTimes(1)
  })

  it('adds neither row for other pages, whose toolbar button already opens devtools', () => {
    renderMenu(null)

    expect(screen.queryByRole('button', { name: 'Open source file' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open browser devtools' })).toBeNull()
  })
})

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

function renderMenu(onOpenSourceFile?: (() => void) | null): void {
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
      onOpenSourceFile={onOpenSourceFile}
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

describe('browser menu source file row', () => {
  it('offers the source file for a local HTML page', () => {
    const onOpenSourceFile = vi.fn()
    renderMenu(onOpenSourceFile)

    fireEvent.click(screen.getByRole('button', { name: 'Open source file' }))
    expect(onOpenSourceFile).toHaveBeenCalledTimes(1)
  })

  it('adds no row for other pages', () => {
    renderMenu(null)

    expect(screen.queryByRole('button', { name: 'Open source file' })).toBeNull()
  })
})

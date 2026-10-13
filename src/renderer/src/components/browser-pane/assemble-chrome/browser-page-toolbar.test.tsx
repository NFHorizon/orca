// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserChromeToolAction } from './browser-chrome-toolbar'
import type { BrowserPageSourceActions } from './browser-toolbar-menu-dropdown'
import type { GrabModeHook } from '../annotate/useGrabMode'

const mocks = vi.hoisted(() => {
  const captured: {
    viewSource: BrowserChromeToolAction | null
    sourceActions: BrowserPageSourceActions | null | undefined
  } = { viewSource: null, sourceActions: undefined }
  return {
    workspaceOwnedHere: true,
    openBrowserFileSource: vi.fn(),
    openDevTools: vi.fn(),
    captured
  }
})

vi.mock('./browser-chrome-toolbar', () => ({
  BrowserChromeToolbar: (props: {
    viewSource: BrowserChromeToolAction | null
    overflowMenu: (overflow: unknown) => React.ReactNode
  }) => {
    mocks.captured.viewSource = props.viewSource
    return <>{props.overflowMenu({ tools: [] })}</>
  }
}))
vi.mock('./BrowserToolbarMenu', () => ({
  BrowserToolbarMenu: (props: { sourceActions?: BrowserPageSourceActions | null }) => {
    mocks.captured.sourceActions = props.sourceActions
    return null
  }
}))
vi.mock('../navigate/browser-file-editor-open', () => ({
  canOpenBrowserFileInWorkspaceEditor: () => mocks.workspaceOwnedHere,
  openBrowserFileSource: mocks.openBrowserFileSource
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ activeContextualTourId: null })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '' }))
vi.mock('@/components/artifacts/ArtifactPublishButton', () => ({
  ArtifactPublishButton: () => null
}))
vi.mock('./BrowserAddressBar', () => ({ default: () => null }))
vi.mock('./BrowserImportHintButton', () => ({ BrowserImportHintButton: () => null }))
vi.mock('./browser-reload-control', () => ({ BrowserReloadControl: () => null }))
vi.mock('./browser-egress-indicator', () => ({ SshEgressIndicator: () => null }))
vi.mock('../host-guest/webview-registry', () => ({ destroyPersistentWebview: vi.fn() }))
vi.mock('@/lib/browser-page-conversion-history', () => ({
  advanceAcrossBrowserPageConversion: vi.fn(),
  returnAcrossBrowserPageConversion: vi.fn()
}))
vi.mock('@/lib/file-preview', () => ({ convertBrowserPageToWorkspaceDoc: vi.fn() }))

import { BrowserPageToolbar } from './browser-page-toolbar'

const IDLE_GRAB: GrabModeHook = {
  state: 'idle',
  payload: null,
  error: null,
  contextMenu: false,
  toggle: vi.fn(),
  cancel: vi.fn(),
  rearm: vi.fn(),
  exit: vi.fn()
}

function renderToolbar(currentBrowserUrl: string): void {
  render(
    <BrowserPageToolbar
      browserPageId="page-1"
      workspaceId="browser-ws-1"
      worktreeId="wt-1"
      sessionProfileId={null}
      viewportPresetId={null}
      isActive
      canGoBack={false}
      canGoForward={false}
      loading={false}
      webviewRef={createRef()}
      reloadMenuOpen={false}
      setReloadMenuOpen={vi.fn()}
      reloadButtonLabel="Reload"
      reloadButtonLabelKind="reload"
      reloadShortcut=""
      hardReloadShortcut=""
      runReloadTrigger={vi.fn()}
      addressBarValue={currentBrowserUrl}
      setAddressBarValue={vi.fn()}
      submitAddressBar={vi.fn()}
      navigateToUrl={vi.fn()}
      addressBarInputRef={createRef()}
      dismissAddressBarSuggestionsRef={createRef()}
      grab={IDLE_GRAB}
      grabIntent="copy"
      startGrabIntent={vi.fn()}
      isBlankTab={false}
      markupIsActive={false}
      markupStart={vi.fn()}
      markupCancel={vi.fn()}
      grabElementShortcut=""
      browserAnnotationsLength={0}
      shareableArtifactFile={null}
      currentBrowserUrl={currentBrowserUrl}
      externalUrl={null}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.workspaceOwnedHere = true
  mocks.captured.viewSource = null
  mocks.captured.sourceActions = undefined
  // Why defineProperty: the test supplies only the one preload method the toolbar calls.
  Object.defineProperty(window, 'api', {
    value: { browser: { openDevTools: mocks.openDevTools } },
    configurable: true
  })
})

afterEach(cleanup)

describe('BrowserPageToolbar source action', () => {
  it('opens a local HTML page’s file from the source button and keeps devtools in the menu', () => {
    renderToolbar('file:///Users/ana/Design%20Review.html')

    expect(mocks.captured.viewSource).toMatchObject({
      label: 'Open source file',
      alreadyInOverflowMenu: true
    })
    mocks.captured.viewSource?.onSelect()
    expect(mocks.openBrowserFileSource).toHaveBeenCalledWith(
      'wt-1',
      '/Users/ana/Design Review.html'
    )

    mocks.captured.sourceActions?.onOpenSource()
    expect(mocks.openBrowserFileSource).toHaveBeenCalledTimes(2)
    mocks.captured.sourceActions?.onOpenDevTools()
    expect(mocks.openDevTools).toHaveBeenCalledWith({ browserPageId: 'page-1' })
  })

  it('opens a Windows drive page by its Windows path', () => {
    renderToolbar('file:///C:/site/index.htm')

    mocks.captured.viewSource?.onSelect()
    expect(mocks.openBrowserFileSource).toHaveBeenCalledWith('wt-1', 'C:\\site\\index.htm')
  })

  it.each([
    ['a web page', 'https://example.com/index.html'],
    ['a local file that is not HTML', 'file:///Users/ana/notes.txt'],
    ['a blank tab', 'about:blank']
  ])('keeps devtools as the source button for %s', (_case, url) => {
    renderToolbar(url)

    expect(mocks.captured.viewSource?.label).toBe('Open browser devtools')
    expect(mocks.captured.sourceActions).toBeNull()
    mocks.captured.viewSource?.onSelect()
    expect(mocks.openDevTools).toHaveBeenCalledWith({ browserPageId: 'page-1' })
    expect(mocks.openBrowserFileSource).not.toHaveBeenCalled()
  })

  it('offers no file action in a workspace this computer does not own', () => {
    mocks.workspaceOwnedHere = false
    renderToolbar('file:///Users/ana/report.html')

    expect(mocks.captured.viewSource?.label).toBe('Open browser devtools')
    expect(mocks.captured.sourceActions).toBeNull()
  })
})

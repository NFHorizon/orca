// @vitest-environment happy-dom
//
// A paired document outside its workspace has no grant until its host says it serves the path, so
// the preview waits on that answer before minting, and an older host keeps today's unavailable page.
import { act } from 'react'
import type * as WebviewRegistryModule from '../host-guest/webview-registry'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DocPreviewFailure } from '../../../../../shared/doc-preview-scheme'

const GRANT_ID = 'b'.repeat(32)
const PAGE = '/home/me/state/ab12/chart.html'

const grants = vi.hoisted(() => {
  const hostPathLocation = {
    owner: { kind: 'host-path' as const, environmentId: 'env-1', worktreeSelector: 'id:wt-1' },
    requestBase: '/home/me/state/ab12',
    root: '/home/me/state/ab12',
    entryRelativePath: 'chart.html'
  }
  const state: { resolved: typeof hostPathLocation | null; minted: unknown[] } = {
    resolved: hostPathLocation,
    minted: []
  }
  return { hostPathLocation, ...state }
})

vi.mock('@/lib/doc-preview-grants', () => ({
  resolveDocPreviewGrantRequest: () => Promise.resolve(grants.resolved),
  ensureDocPreviewGrant: (_previewId: string, location: unknown) => {
    grants.minted.push(location)
    return Promise.resolve({
      grantId: GRANT_ID,
      url: `orca-preview://${GRANT_ID}/chart.html`,
      location
    })
  },
  releaseDocPreviewGrant: () => undefined
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof WebviewRegistryModule>()),
  moveFocusToRendererBeforeWebviewDetach: () => undefined
}))

const browserAnnotationsByPageId: Record<string, unknown[]> = {}
const activeGroupIdByWorktree: Record<string, string> = {}
const storeState = {
  getKnownWorktreeById: () => ({ path: '/srv/repo' }),
  persistedUIReady: true,
  settings: {},
  keybindings: {},
  browserAnnotationsByPageId,
  activeGroupIdByWorktree,
  agentSendPopoverTargetMode: null,
  openAgentSendPopoverTargetMode: () => undefined,
  closeAgentSendPopoverTargetMode: () => undefined,
  addBrowserPageAnnotation: () => undefined,
  deleteBrowserPageAnnotation: () => undefined,
  clearBrowserPageAnnotations: () => undefined,
  recordFeatureInteraction: () => undefined,
  recordWorkspaceDocVisit: () => undefined,
  workspaceDocHistory: [],
  openFile: () => 'file-1'
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    { getState: () => storeState }
  )
}))

vi.mock('@/lib/execution-host-display-label', () => ({
  selectWorktreeHostDisplayLabel: () => 'Studio Mac mini'
}))

const failureListeners: ((payload: DocPreviewFailure) => void)[] = []

async function renderPreview(root: Root): Promise<void> {
  const { HtmlDocPreview } = await import('./HtmlDocPreview')
  await act(async () => {
    root.render(
      <TooltipProvider>
        <HtmlDocPreview
          previewId="preview-1"
          filePath={PAGE}
          relativePath={PAGE}
          worktreeId="wt-1"
          runtimeEnvironmentId="env-1"
        />
      </TooltipProvider>
    )
  })
}

describe('HtmlDocPreview for a document its host serves by path', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    failureListeners.length = 0
    grants.resolved = grants.hostPathLocation
    grants.minted = []
    Object.assign(window, {
      api: {
        docPreview: {
          authorizeDirectory: () => Promise.resolve(true),
          onLoadFailure: (callback: (payload: DocPreviewFailure) => void) => {
            failureListeners.push(callback)
            return () => failureListeners.splice(failureListeners.indexOf(callback), 1)
          }
        },
        ui: { writeClipboardText: () => Promise.resolve() },
        browser: { setAnnotationViewportBridge: () => Promise.resolve(true) }
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('mints the host-path grant and renders the page', async () => {
    await renderPreview(root)

    expect(grants.minted).toEqual([grants.hostPathLocation])
    expect(container.querySelector('webview')).not.toBeNull()
    expect(container.textContent).not.toContain('Preview unavailable')
  })

  it('reports the entry page failing once the grant is bound', async () => {
    await renderPreview(root)

    await act(async () => {
      for (const listener of failureListeners.slice()) {
        listener({ grantId: GRANT_ID, relativePath: 'chart.html', reason: 'unreadable' })
      }
    })

    expect(container.textContent).toContain('Preview unavailable')
  })

  it('shows today’s unavailable page on a host that does not serve the path', async () => {
    grants.resolved = null

    await renderPreview(root)

    expect(grants.minted).toEqual([])
    expect(container.querySelector('webview')).toBeNull()
    expect(container.textContent).toContain('Preview unavailable')
  })
})

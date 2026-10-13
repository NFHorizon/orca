import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { basename } from '@/lib/path'
import type { AppState } from '@/store/types'
import { browserPageDocLocationsEqual } from '../../../shared/browser-page-doc-location'
import type { BrowserPageDocLocation } from '../../../shared/browser-workspace-types'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'

export function openDocPreviewTab(
  state: AppState,
  params: { filePath: string; worktreeId: string; targetGroupId?: string; activate: boolean }
): void {
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: params.worktreeId,
    filePath: params.filePath
  }
  // Why reuse and not a second tab: previewing a document already on screen is a request to look at
  // it, and two tabs of one document would each hold their own grant on the same file.
  const existing = (state.browserTabsByWorktree[params.worktreeId] ?? []).find((tab) =>
    browserPageDocLocationsEqual(tab.docLocation ?? null, docLocation)
  )
  if (existing) {
    if (
      !params.activate ||
      !activateBrowserWorkspaceTab({ worktreeId: params.worktreeId, workspaceId: existing.id })
    ) {
      state.setActiveBrowserTab(existing.id)
    }
    return
  }
  state.createBrowserTab(params.worktreeId, ORCA_BROWSER_BLANK_URL, {
    docLocation,
    title: basename(params.filePath) || params.filePath,
    targetGroupId: params.targetGroupId,
    // Why explicitly client-local: the document is read through a grant this desktop mints, so the
    // page never belongs to a remote runtime even when the worktree does.
    browserRuntimeEnvironmentId: null,
    // Why the caller decides: opening a file is a request to look at it, while a preview opened to
    // the side belongs beside the source the reader is still working in.
    activate: params.activate
  })
}

/** The tab a document is already open in, found by every PAGE's docLocation and not just the
 *  workspace mirror — a mixed workspace whose doc page is inactive mirrors null. */
export function findWorkspaceShowingDoc(
  state: AppState,
  docLocation: BrowserPageDocLocation
): { workspaceId: string; pageId: string } | null {
  for (const tab of state.browserTabsByWorktree[docLocation.worktreeId] ?? []) {
    const page = (state.browserPagesByWorkspace[tab.id] ?? []).find((candidate) =>
      browserPageDocLocationsEqual(candidate.docLocation ?? null, docLocation)
    )
    if (page) {
      return { workspaceId: tab.id, pageId: page.id }
    }
  }
  return null
}

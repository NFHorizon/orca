import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import {
  getRuntimeTargetForWorktreeOwner,
  requireRuntimeTargetForFileOwner
} from '@/lib/file-owner-runtime-target'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-metadata-client'
import {
  showFileLinkNotFoundToast,
  showFileLinkUnverifiableToast
} from '@/components/native-chat/native-chat-file-link-toasts'

export type BrowserFileEditorPath = {
  isDirectory: boolean
  /** Project-relative inside the workspace; the absolute path otherwise, so the tab reads as user-named. */
  relativePath: string
}

/** Resolves a path a browser page named (its file:// URL) to the editor's tab path in `worktreeId`. */
export async function resolveBrowserFileEditorPath(
  worktreeId: string,
  filePath: string
): Promise<BrowserFileEditorPath> {
  const store = useAppStore.getState()
  // Why getKnownWorktreeById: folder and floating workspaces are absent from allWorktrees().
  const worktree = store.getKnownWorktreeById(worktreeId)
  const fileContext: RuntimeFileOperationArgs = {
    target: requireRuntimeTargetForFileOwner(store, worktreeId, undefined),
    worktreeId,
    worktreePath: worktree?.path,
    connectionId: undefined
  }
  const stat = await statUserOpenedPath(fileContext, filePath)
  // Why: a project link out of the project keeps its absolute path, so it reads as user-named.
  const relativePath =
    worktree?.path && !stat.escapesWorktree && isPathInsideWorktree(filePath, worktree.path)
      ? (toWorktreeRelativePath(filePath, worktree.path) ?? filePath)
      : filePath
  return { isDirectory: stat.isDirectory, relativePath }
}

/**
 * A local browser page's file:// URL names a file on this computer, so its source can open in the
 * editor only where this computer owns the workspace; elsewhere the editor would read the
 * workspace host's file at that path.
 */
export function canOpenBrowserFileInWorkspaceEditor(state: AppState, worktreeId: string): boolean {
  return (
    getConnectionIdFromState(state, worktreeId) === null &&
    getRuntimeTargetForWorktreeOwner(state, worktreeId)?.kind === 'local'
  )
}

/** Opens the file behind a local browser page as an editable source tab beside the page. */
export async function openBrowserFileSource(worktreeId: string, filePath: string): Promise<void> {
  let resolved: BrowserFileEditorPath
  try {
    resolved = await resolveBrowserFileEditorPath(worktreeId, filePath)
  } catch (error) {
    if (isMissingRuntimePathError(error)) {
      showFileLinkNotFoundToast(filePath)
    } else {
      showFileLinkUnverifiableToast(filePath, error)
    }
    return
  }
  if (resolved.isDirectory) {
    return
  }
  useAppStore.getState().openFile({
    filePath,
    relativePath: resolved.relativePath,
    worktreeId,
    language: detectLanguage(filePath),
    mode: 'edit'
  })
}

import type { DocPreviewGrantRequest } from '../../../preload/api/doc-preview-api'
import { basename, dirname, getRelativePathInsideRoot } from '@/lib/path'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { runtimeEnvironmentServesFilesByPath } from '@/runtime/runtime-file-address'
import type { AppState } from '@/store/types'

/** `location` is what the grant was minted for, so its readers and its share key stay on that host. */
export type DocPreviewGrantHandle = {
  grantId: string
  url: string
  location: DocPreviewGrantLocation
}

/**
 * Grants are keyed by preview tab id, never by effect mount: React StrictMode
 * double-invokes mount effects in dev, and a mount-scoped grant would be revoked
 * out from under the surviving webview. Release is driven by tab close instead.
 */
const grantsByPreviewId = new Map<string, Promise<DocPreviewGrantHandle>>()

/** The page is filled in by `ensureDocPreviewGrant`, so the grant and its key name one surface. */
export type DocPreviewGrantLocation = Omit<DocPreviewGrantRequest, 'browserPageId'>

/**
 * A paired document outside its worktree is `host-path`: only its host can say whether it serves
 * the path, so its location is held until that host answers.
 */
type DocPreviewGrantDraft =
  | { kind: 'workspace'; location: DocPreviewGrantLocation }
  | { kind: 'host-path'; environmentId: string; location: DocPreviewGrantLocation }

function draftDocPreviewGrantRequest(
  state: AppState,
  worktreeId: string,
  filePath: string
): DocPreviewGrantDraft | null {
  const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path ?? null
  const worktreeRelativePath = getRelativePathInsideRoot(filePath, worktreeRoot)
  const root = dirname(filePath)
  const requestBase = worktreeRoot && worktreeRelativePath ? worktreeRoot : root
  const entryRelativePath = worktreeRelativePath ?? basename(filePath)
  if (!requestBase || !root || !entryRelativePath) {
    return null
  }
  const connectionId = getConnectionIdForFileFromState(state, worktreeId, filePath)
  if (connectionId) {
    // Outside a workspace there is no broader request base: the document directory bounds
    // resolution, and main starts such a grant at the entry file alone — an out-of-workspace
    // directory is often a home directory, which is where secrets live.
    return {
      kind: 'workspace',
      location: { owner: { kind: 'ssh', connectionId }, requestBase, root, entryRelativePath }
    }
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!environmentId || !worktreeRoot) {
    return null
  }
  const worktreeSelector = toRuntimeWorktreeSelector(worktreeId)
  if (!worktreeRelativePath) {
    if (connectionId === undefined) {
      return null
    }
    // Why the document's own folder: it bounds the grant, so an approval in one chat's page can
    // never reach another chat's folder beside it.
    return {
      kind: 'host-path',
      environmentId,
      location: {
        owner: { kind: 'host-path', environmentId, worktreeSelector },
        requestBase: root,
        root,
        entryRelativePath
      }
    }
  }
  return {
    kind: 'workspace',
    location: {
      owner: { kind: 'runtime', environmentId, worktreeSelector, worktreeRoot },
      requestBase,
      root,
      entryRelativePath
    }
  }
}

/** The grant request for a document its owner reads by workspace, or null without asking a host. */
export function buildDocPreviewGrantRequest(
  state: AppState,
  worktreeId: string,
  filePath: string
): DocPreviewGrantLocation | null {
  const draft = draftDocPreviewGrantRequest(state, worktreeId, filePath)
  return draft?.kind === 'workspace' ? draft.location : null
}

/**
 * {@link buildDocPreviewGrantRequest}, plus a paired or SSH host's document outside its workspaces
 * when that host serves files by path. The grant starts at the entry file alone, and the host
 * refuses any path it does not serve.
 */
export async function resolveDocPreviewGrantRequest(
  state: AppState,
  worktreeId: string,
  filePath: string
): Promise<DocPreviewGrantLocation | null> {
  const draft = draftDocPreviewGrantRequest(state, worktreeId, filePath)
  if (draft?.kind !== 'host-path') {
    return draft?.location ?? null
  }
  return (await runtimeEnvironmentServesFilesByPath(draft.environmentId)) ? draft.location : null
}

export function ensureDocPreviewGrant(
  previewId: string,
  location: DocPreviewGrantLocation
): Promise<DocPreviewGrantHandle> {
  const existing = grantsByPreviewId.get(previewId)
  if (existing) {
    return existing
  }
  const pending: Promise<DocPreviewGrantHandle> = window.api.docPreview
    .mintGrant({ ...location, browserPageId: previewId })
    .then((minted) => ({ ...minted, location }))
    .catch((error: unknown) => {
      // Why the identity check: a release and a fresh ensure can both land before this rejects, and
      // an unconditional delete would evict the newer entry, leaving its grant unrevokable.
      if (grantsByPreviewId.get(previewId) === pending) {
        grantsByPreviewId.delete(previewId)
      }
      throw error
    })
  grantsByPreviewId.set(previewId, pending)
  return pending
}

export function releaseDocPreviewGrant(previewId: string): void {
  const pending = grantsByPreviewId.get(previewId)
  if (!pending) {
    return
  }
  grantsByPreviewId.delete(previewId)
  void pending.then((handle) => window.api.docPreview.revokeGrant(handle.grantId)).catch(() => {})
}

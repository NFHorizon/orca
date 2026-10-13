import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileAddressModule from '@/runtime/runtime-file-address'
import type * as RuntimeFileReadClientModule from '@/runtime/runtime-file-read-client'

const mocks = vi.hoisted(() => ({
  servesFilesByPath: vi.fn(),
  readRuntimeFilePreview: vi.fn()
}))

vi.mock('@/runtime/runtime-file-address', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileAddressModule>()),
  runtimeEnvironmentServesFilesByPath: mocks.servesFilesByPath
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClientModule>()),
  readRuntimeFilePreview: mocks.readRuntimeFilePreview
}))

import { useAppStore } from '@/store'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { editorArtifactSourceKey } from '@/components/editor/editor-artifact-upload'
import {
  resolveDocPreviewGrantRequest,
  type DocPreviewGrantLocation
} from '@/lib/doc-preview-grants'
import { fileArtifactSourceKey } from '@/lib/file-artifact-source-key'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { makeRepo, makeWorktree } from '@/components/worktree-jump-palette-test-fixtures'
import {
  docPreviewGrantFileOwner,
  readDocPreviewArtifactRequest
} from './doc-preview-artifact-share'
import { openDocPreviewSource } from './doc-preview-document-actions'

const WORKTREE_ID = 'repo-1::/srv/repo'
// Neutral host path outside every workspace; which paths a host serves is its own rule.
const PAGE = '/home/me/state/ab12/chart.html'

function seed(repo: Partial<Repo> = {}, worktree: Partial<Worktree> = {}): void {
  useAppStore.setState({
    repos: [{ ...makeRepo(), path: '/srv/repo', executionHostId: 'runtime:hub-a', ...repo }],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'repo', {
          path: '/srv/repo',
          hostId: 'runtime:hub-a',
          ...worktree
        })
      ]
    },
    detectedWorktreesByRepo: {},
    openFiles: []
  })
}

async function resolvedLocation(filePath = PAGE): Promise<DocPreviewGrantLocation> {
  const location = await resolveDocPreviewGrantRequest(
    useAppStore.getState(),
    WORKTREE_ID,
    filePath
  )
  if (!location) {
    throw new Error('no grant location')
  }
  return location
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.servesFilesByPath.mockResolvedValue(true)
  seed()
})

describe('preview grant for a paired document outside its workspace', () => {
  it('reads by path on a host that serves paths, bounded by the document folder', async () => {
    expect(await resolvedLocation()).toEqual({
      owner: { kind: 'host-path', environmentId: 'hub-a', worktreeSelector: `id:${WORKTREE_ID}` },
      requestBase: '/home/me/state/ab12',
      root: '/home/me/state/ab12',
      entryRelativePath: 'chart.html'
    })
    expect(mocks.servesFilesByPath).toHaveBeenCalledWith('hub-a')
  })

  it('keeps a Windows host path in its own spelling', async () => {
    expect(await resolvedLocation('C:\\Users\\me\\state\\ab12\\chart.html')).toMatchObject({
      requestBase: 'C:\\Users\\me\\state\\ab12',
      root: 'C:\\Users\\me\\state\\ab12',
      entryRelativePath: 'chart.html'
    })
  })

  it('has no grant on an older host, which keeps today’s unavailable preview', async () => {
    mocks.servesFilesByPath.mockResolvedValue(false)

    expect(
      await resolveDocPreviewGrantRequest(useAppStore.getState(), WORKTREE_ID, PAGE)
    ).toBeNull()
  })

  it('leaves a workspace document on the workspace form without asking the host', async () => {
    expect(await resolvedLocation('/srv/repo/docs/index.html')).toMatchObject({
      owner: { kind: 'runtime', environmentId: 'hub-a', worktreeRoot: '/srv/repo' }
    })
    expect(mocks.servesFilesByPath).not.toHaveBeenCalled()
  })

  // A paired host proxying an SSH workspace would answer from its own disk.
  it('never reads an SSH workspace’s outside document by host path', async () => {
    seed(
      { connectionId: 'hub-target' },
      { hostId: 'ssh:hub-target', runtimeOwnerEnvironmentId: 'hub-a' }
    )

    expect((await resolvedLocation()).owner).toEqual({ kind: 'ssh', connectionId: 'hub-target' })
    expect(mocks.servesFilesByPath).not.toHaveBeenCalled()
  })
})

describe('Share and Open source file for a host-path preview', () => {
  it('Shares under the same key as the editor tab Open source file opens', async () => {
    const location = await resolvedLocation()
    openDocPreviewSource({
      filePath: PAGE,
      relativePath: PAGE,
      worktreeId: WORKTREE_ID,
      runtimeEnvironmentId: 'hub-a',
      externalSshTargetId: null
    })

    const state = useAppStore.getState()
    const sourceTab = state.openFiles.find((file) => file.filePath === PAGE)
    if (!sourceTab) {
      throw new Error('Open source file opened no tab')
    }
    // The source tab is the ordinary editable host file: same host, same absolute path.
    expect(sourceTab).toMatchObject({ relativePath: PAGE, runtimeEnvironmentId: 'hub-a' })
    expect(sourceTab.readOnly).toBeUndefined()
    expect(sourceTab.terminalArtifactGrantId).toBeUndefined()
    expect(editorTabFileAccess(state, sourceTab)).toEqual({ kind: 'user-file' })
    expect(fileArtifactSourceKey(docPreviewGrantFileOwner(location.owner), PAGE)).toBe(
      editorArtifactSourceKey(sourceTab)
    )
  })

  it('reads the shared page by path on the host the grant names', async () => {
    mocks.readRuntimeFilePreview.mockResolvedValue({ content: '<h1>chart</h1>', isBinary: false })

    const request = await readDocPreviewArtifactRequest(await resolvedLocation(), PAGE, 'key-1')

    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(
      {
        target: { kind: 'environment', environmentId: 'hub-a' },
        worktreeId: `id:${WORKTREE_ID}`,
        worktreePath: null
      },
      PAGE,
      { kind: 'user-file' }
    )
    expect(request).toEqual({
      sourceKey: 'key-1',
      content: '<h1>chart</h1>',
      contentType: 'text/html',
      fileName: 'chart.html'
    })
  })
})

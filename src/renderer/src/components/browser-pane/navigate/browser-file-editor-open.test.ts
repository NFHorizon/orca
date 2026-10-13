import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({
  statUserOpenedPath: vi.fn(),
  openFile: vi.fn(),
  connectionId: vi.fn<() => string | null | undefined>(),
  ownerTarget: vi.fn<() => unknown>(),
  notFoundToast: vi.fn(),
  unverifiableToast: vi.fn()
}))

vi.mock('@/lib/user-opened-local-path', () => ({ statUserOpenedPath: mocks.statUserOpenedPath }))
vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdFromState: mocks.connectionId
}))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  getRuntimeTargetForWorktreeOwner: mocks.ownerTarget,
  requireRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))
vi.mock('@/components/native-chat/native-chat-file-link-toasts', () => ({
  showFileLinkNotFoundToast: mocks.notFoundToast,
  showFileLinkUnverifiableToast: mocks.unverifiableToast
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: (id: string) => (id === 'wt-1' ? { id, path: '/repo' } : undefined),
      openFile: mocks.openFile
    })
  }
}))

import {
  canOpenBrowserFileInWorkspaceEditor,
  openBrowserFileSource
} from './browser-file-editor-open'

// The resolvers are mocked, so the state's contents never matter.
const state = useAppStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectionId.mockReturnValue(null)
  mocks.ownerTarget.mockReturnValue({ kind: 'local' })
  mocks.statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: false })
})

describe('canOpenBrowserFileInWorkspaceEditor', () => {
  it('allows a workspace this computer owns', () => {
    expect(canOpenBrowserFileInWorkspaceEditor(state, 'wt-1')).toBe(true)
  })

  it('refuses an SSH workspace, whose editor would read the remote file at that path', () => {
    mocks.connectionId.mockReturnValue('ssh-1')
    expect(canOpenBrowserFileInWorkspaceEditor(state, 'wt-1')).toBe(false)
  })

  it('refuses a paired-server workspace', () => {
    mocks.ownerTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
    expect(canOpenBrowserFileInWorkspaceEditor(state, 'wt-1')).toBe(false)
  })

  it('refuses a workspace whose owner cannot be determined', () => {
    mocks.connectionId.mockReturnValue(undefined)
    expect(canOpenBrowserFileInWorkspaceEditor(state, 'wt-1')).toBe(false)
    mocks.connectionId.mockReturnValue(null)
    mocks.ownerTarget.mockReturnValue(null)
    expect(canOpenBrowserFileInWorkspaceEditor(state, 'wt-1')).toBe(false)
  })
})

describe('openBrowserFileSource', () => {
  it('opens a project file as an editable project-relative source tab', async () => {
    await openBrowserFileSource('wt-1', '/repo/site/index.html')

    expect(mocks.statUserOpenedPath).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1', worktreePath: '/repo' }),
      '/repo/site/index.html'
    )
    expect(mocks.openFile).toHaveBeenCalledWith({
      filePath: '/repo/site/index.html',
      relativePath: 'site/index.html',
      worktreeId: 'wt-1',
      language: 'html',
      mode: 'edit'
    })
  })

  it('opens a file outside the project by its absolute path, as a user-named file', async () => {
    await openBrowserFileSource('wt-1', '/tmp/Design Review.html')

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/Design Review.html',
        relativePath: '/tmp/Design Review.html'
      })
    )
  })

  it('keeps the absolute path for a project path that leads out of the project', async () => {
    mocks.statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: true })

    await openBrowserFileSource('wt-1', '/repo/linked/page.html')

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: '/repo/linked/page.html' })
    )
  })

  it('says the file is gone when it no longer exists', async () => {
    mocks.statUserOpenedPath.mockRejectedValue(new Error('ENOENT: no such file'))

    await openBrowserFileSource('wt-1', '/tmp/gone.html')

    expect(mocks.notFoundToast).toHaveBeenCalledWith('/tmp/gone.html')
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('does not claim the file is gone when it could not be checked', async () => {
    const error = new Error('access denied')
    mocks.statUserOpenedPath.mockRejectedValue(error)

    await openBrowserFileSource('wt-1', '/tmp/private.html')

    expect(mocks.unverifiableToast).toHaveBeenCalledWith('/tmp/private.html', error)
    expect(mocks.notFoundToast).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
  })

  it('opens nothing for a directory', async () => {
    mocks.statUserOpenedPath.mockResolvedValue({ isDirectory: true, escapesWorktree: false })

    await openBrowserFileSource('wt-1', '/repo/site.html')

    expect(mocks.openFile).not.toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  runtimeEnvironmentServesFilesByPath: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/runtime-file-address', () => ({
  runtimeEnvironmentServesFilesByPath: mocks.runtimeEnvironmentServesFilesByPath
}))
vi.mock('@/runtime/runtime-file-watch-client', () => ({ subscribeRuntimeFileChanges: vi.fn() }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn()
}))
vi.mock('@/runtime/runtime-git-client-context', () => ({ getRuntimeGitScope: vi.fn(() => null) }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null),
  getConnectionIdForFile: mocks.getConnectionIdForFile,
  isWorktreeConnectionResolved: vi.fn(() => true)
}))
vi.mock('@/lib/worktree-host-connection-phase', () => import('./local-host-test-fixture'))
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))
// The paired host env-1 owns `repo-runtime::` workspaces.
vi.mock('@/lib/file-owner-runtime-target', () => {
  const ownerTarget = (_s: unknown, worktreeId?: string, owner?: string | null) => {
    const id = owner === undefined && worktreeId?.startsWith('repo-runtime::') ? 'env-1' : owner
    return id ? { kind: 'environment', environmentId: id } : { kind: 'local' }
  }
  return {
    getRuntimeTargetForFileOwner: ownerTarget,
    requireRuntimeTargetForFileOwner: ownerTarget
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { useEditorPanelContentState } from './useEditorPanelContentState'

const HOST_FILE = '/home/me/state/ab12/report.md'
let latestFileContents: Record<string, FileContent> = {}

function HookProbe({ file, openFiles }: { file: OpenFile; openFiles: OpenFile[] }): null {
  latestFileContents = useEditorPanelContentState({
    activeFile: file,
    isChangesMode: false,
    openFiles,
    gitStatusEntries: undefined,
    editorViewMode: {}
  }).fileContents
  return null
}

// A tab opened from a link to a file outside every workspace, named by its absolute path.
const hostFileTab: OpenFile = {
  id: HOST_FILE,
  filePath: HOST_FILE,
  relativePath: HOST_FILE,
  worktreeId: 'repo-runtime::/srv/repo',
  language: 'markdown',
  isDirty: false,
  mode: 'edit'
}

const hostFileTabs = [hostFileTab]

describe('restoring a tab for a file outside every workspace on a paired host', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    latestFileContents = {}
    Object.assign(window, { api: { fs: { onLocalLogTailChanged: vi.fn() } } })
    mocks.readRuntimeFileContent.mockReset()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(null)
    mocks.runtimeEnvironmentServesFilesByPath.mockReset()
    mocks.getState.mockReturnValue({
      settings: null,
      openFiles: [],
      setLastKnownDiskSignature: vi.fn()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it('reads it from its host by path with the user’s access', async () => {
    mocks.runtimeEnvironmentServesFilesByPath.mockResolvedValue(true)
    mocks.readRuntimeFileContent.mockResolvedValue({ content: '# report', isBinary: false })

    await act(async () => {
      root?.render(<HookProbe file={hostFileTab} openFiles={hostFileTabs} />)
    })

    await vi.waitFor(() => expect(latestFileContents[HOST_FILE]?.content).toBe('# report'))
    expect(mocks.runtimeEnvironmentServesFilesByPath).toHaveBeenCalledWith('env-1')
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'environment', environmentId: 'env-1' },
        filePath: HOST_FILE,
        relativePath: HOST_FILE,
        connectionId: undefined,
        access: { kind: 'user-file' }
      })
    )
  })

  it('keeps today’s refusal on an older host, without reading anything', async () => {
    mocks.runtimeEnvironmentServesFilesByPath.mockResolvedValue(false)

    await act(async () => {
      root?.render(<HookProbe file={hostFileTab} openFiles={hostFileTabs} />)
    })

    await vi.waitFor(() =>
      expect(latestFileContents[HOST_FILE]?.loadError).toBe(
        'External local files are not available for remote workspaces.'
      )
    )
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
  })

  it('never asks a host that proxies an SSH workspace to read by path', async () => {
    mocks.getConnectionIdForFile.mockReturnValue('box')
    mocks.runtimeEnvironmentServesFilesByPath.mockResolvedValue(true)

    await act(async () => {
      root?.render(<HookProbe file={hostFileTab} openFiles={hostFileTabs} />)
    })

    await vi.waitFor(() =>
      expect(latestFileContents[HOST_FILE]?.loadError).toBe(
        'External local files are not available for remote workspaces.'
      )
    )
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
  })
})

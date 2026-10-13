import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTerminalFileLink } from '@/lib/terminal-links'
import type * as FileLinkTargetModule from '@/components/terminal-pane/terminal-file-link-target'
import type { FileLinkPathExistence } from '@/components/terminal-pane/terminal-file-link-target'
import type * as FilePathMappingModule from '@/components/terminal-pane/terminal-file-path-mapping'
import type * as HostFileLinkExistenceModule from '@/components/terminal-pane/terminal-host-file-link-existence'
import { createNativeChatFileLinkExistence } from './native-chat-file-link-existence'

const hostPaths = vi.hoisted(() => ({
  servesFilesByPath: vi.fn(async () => true),
  hostFileLinkTargetExists: vi.fn(async () => true)
}))

// A chat on a paired host, in a workspace that host executes itself.
const serverContext = {
  target: { kind: 'environment', environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/srv/repo',
  sourceHostResolved: true
}

vi.mock('@/lib/connection-context', () => ({
  isWorktreeConnectionResolved: () => true
}))

vi.mock('@/runtime/runtime-file-address', () => ({
  runtimeEnvironmentServesFilesByPath: hostPaths.servesFilesByPath
}))

vi.mock('@/components/terminal-pane/terminal-host-file-link-existence', async (importOriginal) => ({
  ...(await importOriginal<typeof HostFileLinkExistenceModule>()),
  hostFileLinkTargetExists: hostPaths.hostFileLinkTargetExists
}))

vi.mock('@/components/terminal-pane/terminal-file-link-target', async (importOriginal) => ({
  ...(await importOriginal<typeof FileLinkTargetModule>()),
  resolveFileLinkTarget: (link: ParsedTerminalFileLink) => ({
    absolutePath: link.pathText,
    line: null,
    column: null,
    fileContext: serverContext,
    isRemoteRuntimePath: link.pathText.startsWith('/srv/repo/'),
    cacheKey: link.pathText,
    isKnownWorktreeRoot: false
  })
}))

vi.mock('@/components/terminal-pane/terminal-file-path-mapping', async (importOriginal) => ({
  ...(await importOriginal<typeof FilePathMappingModule>()),
  getTerminalFileContext: () => serverContext
}))

const host = {
  cwd: '/srv/repo',
  worktreeId: 'wt-1',
  worktreePath: '/srv/repo',
  runtimeEnvironmentId: 'env-1',
  connectionId: null
}
const HOST_FILE = '/home/me/state/ab12/report.md'

function link(pathText: string): ParsedTerminalFileLink {
  return {
    pathText,
    line: null,
    column: null,
    startIndex: 0,
    endIndex: pathText.length,
    displayText: pathText
  }
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

function underlines(pathExists: FileLinkPathExistence, path: string) {
  const watcher = createNativeChatFileLinkExistence(host, pathExists).watch()
  watcher.subscribe(() => {})
  watcher.getSnapshot().check(link(path))
  return async () => {
    await settle()
    return watcher.getSnapshot().check(link(path))
  }
}

describe('a chat link outside its workspace on a paired host', () => {
  beforeEach(() => {
    hostPaths.servesFilesByPath.mockReset()
    hostPaths.servesFilesByPath.mockResolvedValue(true)
    hostPaths.hostFileLinkTargetExists.mockReset()
    hostPaths.hostFileLinkTargetExists.mockResolvedValue(true)
  })

  it('asks the host the question a click asks when it serves files by path', async () => {
    const pathExists = vi.fn<FileLinkPathExistence>(async () => false)

    const answer = underlines(pathExists, HOST_FILE)

    expect(await answer()).toBe(true)
    expect(hostPaths.servesFilesByPath).toHaveBeenCalledWith('env-1')
    expect(hostPaths.hostFileLinkTargetExists).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: HOST_FILE }),
      expect.any(Map),
      null
    )
    // Never this computer's same-named file.
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('keeps today’s check on an older host', async () => {
    hostPaths.servesFilesByPath.mockResolvedValue(false)
    const pathExists = vi.fn<FileLinkPathExistence>(async () => true)

    const answer = underlines(pathExists, HOST_FILE)

    expect(await answer()).toBe(true)
    expect(hostPaths.hostFileLinkTargetExists).not.toHaveBeenCalled()
    expect(pathExists).toHaveBeenCalledWith(serverContext, HOST_FILE, false)
  })

  it('keeps workspace paths on the workspace check', async () => {
    const pathExists = vi.fn<FileLinkPathExistence>(async () => true)

    const answer = underlines(pathExists, '/srv/repo/src/a.ts')

    expect(await answer()).toBe(true)
    expect(hostPaths.servesFilesByPath).not.toHaveBeenCalled()
    expect(pathExists).toHaveBeenCalledWith(serverContext, '/srv/repo/src/a.ts', true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { ParsedTerminalFileLink } from '@/lib/terminal-links'
import type * as FileLinkTargetModule from '@/components/terminal-pane/terminal-file-link-target'
import type {
  FileLinkPathExistence,
  FileLinkTarget
} from '@/components/terminal-pane/terminal-file-link-target'
import type * as FilePathMappingModule from '@/components/terminal-pane/terminal-file-path-mapping'
import { createNativeChatFileLinkExistence } from './native-chat-file-link-existence'

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

function underlines(
  pathExists: FileLinkPathExistence,
  hostServesLinkByPath: (target: FileLinkTarget) => Promise<boolean>,
  path: string
) {
  const watcher = createNativeChatFileLinkExistence(host, pathExists, hostServesLinkByPath).watch()
  watcher.subscribe(() => {})
  watcher.getSnapshot().check(link(path))
  return async () => {
    await settle()
    return watcher.getSnapshot().check(link(path))
  }
}

describe('a chat link outside its workspace on a paired host', () => {
  it('is underlined as the host’s file when the host serves it by path', async () => {
    const pathExists = vi.fn<FileLinkPathExistence>(async () => false)
    const hostServes = vi.fn(async () => true)

    expect(await underlines(pathExists, hostServes, HOST_FILE)()).toBe(true)
    expect(hostServes).toHaveBeenCalledWith(expect.objectContaining({ absolutePath: HOST_FILE }))
    // Never this computer's same-named file.
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('keeps today’s batched check for every other answer', async () => {
    const pathExists = vi.fn<FileLinkPathExistence>(async () => true)

    expect(await underlines(pathExists, async () => false, '/Users/me/notes.md')()).toBe(true)
    expect(pathExists).toHaveBeenCalledWith(serverContext, '/Users/me/notes.md', false)
  })
})

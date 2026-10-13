import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { Store } from '../persistence'

// Why win32 paths on every host: a Windows host must read its own drive and UNC spellings and
// refuse foreign or drive-relative ones, whatever machine runs the test.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof NodePath>('node:path')
  return { ...actual.win32, default: actual.win32 }
})
vi.mock('node:fs/promises', () => {
  const identity = vi.fn(async (target: unknown) => String(target))
  return { realpath: identity, stat: identity, open: identity }
})
vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: vi.fn(async () => []) }))

import { nativeChatScratchRootFor } from '../native-chat/native-chat-scratch-folder'
import { initOrcaProfilePaths } from '../orca-profiles/profile-storage-paths'
import { resolveHostPathTarget } from './runtime-host-path-target'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
const store = {
  getRepos: () => [
    { id: 'repo', path: 'C:\\repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [
    { id: 'folder', folderPath: '\\\\server\\share\\Notes Folder', projectGroupId: 'none' }
  ],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
} as unknown as Store

const USER_DATA = 'C:\\Users\\me\\AppData\\Roaming\\Orca'
const SCRATCH = `${nativeChatScratchRootFor(USER_DATA)}\\0123456789abcdef0123456789abcdef`

beforeEach(() => {
  installFakeAppEnvironment({ getPath: () => USER_DATA })
  initOrcaProfilePaths()
  // Why C:\: each relative spelling below then resolves into C:\repo, so only the absolute rule refuses it.
  vi.spyOn(process, 'cwd').mockReturnValue('C:\\')
})

afterEach(() => {
  vi.restoreAllMocks()
})

function outcome(path: string, access?: { kind: 'user-file' }): Promise<'ok' | 'denied'> {
  return resolveHostPathTarget({ path, ...(access ? { access } : {}) }, store, 'read').then(
    () => 'ok',
    () => 'denied'
  )
}

describe('host paths on a Windows host', () => {
  it.each([
    'C:\\repo\\src\\a.ts',
    'c:/repo/src/a.ts',
    '\\\\server\\share\\Notes Folder\\todo.md',
    '//server/share/notes folder/todo.md',
    `${SCRATCH}\\chart.html`,
    `${SCRATCH.toLowerCase().replaceAll('\\', '/')}/chart.html`
  ])('allows %s', async (path) => {
    expect(await outcome(path)).toBe('ok')
    expect(await outcome(path, { kind: 'user-file' })).toBe('ok')
  })

  it.each([
    'C:\\Users\\me\\notes.txt',
    `${USER_DATA}\\orca-data.json`,
    `${USER_DATA}\\floating-workspace\\untitled.md`,
    `${SCRATCH}\\..\\..\\orca-data.json`,
    '\\\\server\\share\\other\\todo.md',
    // Relative to the current drive or folder, or another system's spelling.
    'C:repo\\src\\a.ts',
    '\\repo\\src\\a.ts',
    '/repo/src/a.ts',
    'repo\\src\\a.ts'
  ])('refuses %s, user-file access included', async (path) => {
    expect(await outcome(path)).toBe('denied')
    expect(await outcome(path, { kind: 'user-file' })).toBe('denied')
  })
})

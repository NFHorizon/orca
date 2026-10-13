import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { Store } from '../persistence'

// Why win32 paths on every host: drive letters, backslashes and drive casing must resolve the same
// roots in both scopes on a Windows desktop or host, whatever machine runs the test.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof NodePath>('node:path')
  return { ...actual.win32, default: actual.win32 }
})
vi.mock('node:fs/promises', () => {
  const identity = vi.fn(async (target: unknown) => String(target))
  return { realpath: identity, stat: identity, open: identity }
})
vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: vi.fn(async () => []) }))

import { resolveLocalRequestPathInScope } from './local-file-access-resolution'
import {
  DESKTOP_FILE_ROOT_SCOPE,
  HOST_FILE_ROOT_SCOPE,
  type LocalFileRootScope
} from './local-file-root-scope'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
const store = {
  getRepos: () => [
    { id: 'repo', path: 'C:\\repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getProjects: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [
    { id: 'folder', folderPath: 'D:\\Notes Folder', projectGroupId: 'none' }
  ],
  getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
} as unknown as Store

const FLOATING = 'C:\\Users\\me\\AppData\\Roaming\\Orca\\floating-workspace'

beforeEach(() => {
  installFakeAppEnvironment({ getPath: () => 'C:\\Users\\me\\AppData\\Roaming\\Orca' })
})

function outcome(scope: LocalFileRootScope, target: string): Promise<'ok' | 'denied'> {
  return resolveLocalRequestPathInScope(target, undefined, store, 'read', scope).then(
    () => 'ok',
    () => 'denied'
  )
}

describe('default roots under Windows path forms', () => {
  it.each([
    'C:\\repo\\src\\a.ts',
    'c:\\repo\\src\\a.ts',
    'C:/repo/src/a.ts',
    'C:\\repo\\src\\..\\b.ts',
    'D:\\Notes Folder\\todo.md',
    'd:/notes folder/todo.md'
  ])('allows %s in both scopes', async (target) => {
    expect(await outcome(DESKTOP_FILE_ROOT_SCOPE, target)).toBe('ok')
    expect(await outcome(HOST_FILE_ROOT_SCOPE, target)).toBe('ok')
  })

  it.each([
    'C:\\repo-other\\a.ts',
    'C:\\repo\\..\\secret.txt',
    'D:\\repo\\a.ts',
    'C:\\Users\\me\\notes.txt'
  ])('refuses %s in both scopes', async (target) => {
    expect(await outcome(DESKTOP_FILE_ROOT_SCOPE, target)).toBe('denied')
    expect(await outcome(HOST_FILE_ROOT_SCOPE, target)).toBe('denied')
  })

  it.each([
    `${FLOATING}\\untitled.md`,
    `${FLOATING.replace('C:\\', 'c:/').replaceAll('\\', '/')}/untitled.md`
  ])('allows the floating folder %s on the desktop only', async (target) => {
    expect(await outcome(DESKTOP_FILE_ROOT_SCOPE, target)).toBe('ok')
    expect(await outcome(HOST_FILE_ROOT_SCOPE, target)).toBe('denied')
  })
})

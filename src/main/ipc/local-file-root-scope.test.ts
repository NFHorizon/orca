import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { requireRuntimeFileProvider } from '../runtime/runtime-file-command-target'
import { readLocalMobileFile } from '../runtime/runtime-file-commands-terminal-file-paths'
import {
  resolveDesktopAuthorizedPath,
  resolveLocalRequestPath,
  resolveLocalRequestPathInScope
} from './local-file-access-resolution'
import {
  DESKTOP_FILE_ROOT_SCOPE,
  HOST_FILE_ROOT_SCOPE,
  resolveHostAuthorizedPath,
  type LocalFileRootScope
} from './local-file-root-scope'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

let base: string
let project: string
let folderWorkspace: string
let floating: string
let outside: string
let store: Store

function makeStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
  return {
    getRepos: () => [
      { id: 'repo', path: project, displayName: 'project', badgeColor: '#000', addedAt: 0 }
    ],
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [
      { id: 'folder', folderPath: folderWorkspace, projectGroupId: 'none' }
    ],
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

async function outcome(promise: Promise<unknown>): Promise<'ok' | 'denied'> {
  return promise.then(
    () => 'ok',
    () => 'denied'
  )
}

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-root-scope-'))
  project = join(base, 'project')
  folderWorkspace = join(base, 'notes-folder')
  outside = join(base, 'outside')
  const userData = join(base, 'user-data')
  floating = join(userData, 'floating-workspace')
  installFakeAppEnvironment({ getPath: () => userData })
  for (const dir of [project, folderWorkspace, outside, floating]) {
    await mkdir(dir, { recursive: true })
  }
  for (const dir of [project, folderWorkspace, outside, floating]) {
    await writeFile(join(dir, 'file.md'), 'text\n')
  }
  store = makeStore()
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('one resolver, each caller with its own default roots', () => {
  const byScope = (scope: LocalFileRootScope, target: string, access?: unknown) =>
    outcome(resolveLocalRequestPathInScope(target, access, store, 'read', scope))

  it('gives the desktop and the host the same project and folder-workspace roots', async () => {
    for (const scope of [DESKTOP_FILE_ROOT_SCOPE, HOST_FILE_ROOT_SCOPE]) {
      expect(await byScope(scope, join(project, 'file.md'))).toBe('ok')
      expect(await byScope(scope, join(folderWorkspace, 'file.md'))).toBe('ok')
      expect(await byScope(scope, join(outside, 'file.md'))).toBe('denied')
    }
  })

  it('reaches the floating-workspace folder from the desktop only', async () => {
    expect(await byScope(DESKTOP_FILE_ROOT_SCOPE, join(floating, 'file.md'))).toBe('ok')
    expect(await byScope(HOST_FILE_ROOT_SCOPE, join(floating, 'file.md'))).toBe('denied')
  })

  it('honours a declared access kind outside the roots on the desktop only', async () => {
    const userFile = { kind: 'user-file' }
    expect(await byScope(DESKTOP_FILE_ROOT_SCOPE, join(outside, 'file.md'), userFile)).toBe('ok')
    expect(await byScope(HOST_FILE_ROOT_SCOPE, join(outside, 'file.md'), userFile)).toBe('denied')
    for (const scope of [DESKTOP_FILE_ROOT_SCOPE, HOST_FILE_ROOT_SCOPE]) {
      expect(await byScope(scope, join(outside, 'file.md'), { kind: 'grant-everything' })).toBe(
        'denied'
      )
    }
  })

  it('gives every declared kind only the host roots on the host', async () => {
    const outsideDocument = join(outside, 'file.md')
    const kinds: [unknown, 'read' | 'write' | 'import-into'][] = [
      [{ kind: 'user-file' }, 'read'],
      [{ kind: 'user-file' }, 'write'],
      [{ kind: 'chat-image' }, 'read'],
      [{ kind: 'document-resource', documentPath: outsideDocument }, 'read'],
      [{ kind: 'document-folder', documentPath: outsideDocument }, 'import-into']
    ]
    for (const [access, operation] of kinds) {
      const onHost = (target: string) =>
        outcome(
          resolveLocalRequestPathInScope(target, access, store, operation, HOST_FILE_ROOT_SCOPE)
        )
      expect(await onHost(join(outside, 'file.md')), JSON.stringify(access)).toBe('denied')
      expect(await onHost(join(folderWorkspace, 'file.md')), JSON.stringify(access)).toBe('ok')
    }
  })

  it('makes each caller entry point its scope of that resolver', async () => {
    const targets = [project, folderWorkspace, floating, outside].map((dir) => join(dir, 'file.md'))
    for (const target of targets) {
      expect(await outcome(resolveDesktopAuthorizedPath(target, store)), target).toBe(
        await byScope(DESKTOP_FILE_ROOT_SCOPE, target)
      )
      expect(await outcome(resolveLocalRequestPath(target, undefined, store, 'read')), target).toBe(
        await byScope(DESKTOP_FILE_ROOT_SCOPE, target)
      )
      expect(await outcome(resolveHostAuthorizedPath(target, store)), target).toBe(
        await byScope(HOST_FILE_ROOT_SCOPE, target)
      )
    }
  })
})

describe('the host runtime file services use the host scope', () => {
  it('authorizes the local file provider against the host roots', async () => {
    const provider = requireRuntimeFileProvider(
      { executionHostId: 'local' },
      { requireStore: () => store }
    )

    await expect(provider.stat(join(folderWorkspace, 'file.md'))).resolves.toMatchObject({
      type: 'file'
    })
    await expect(provider.stat(join(floating, 'file.md'))).rejects.toThrow('Access denied')
  })

  it('reads a phone-requested file only inside the host roots', async () => {
    await expect(readLocalMobileFile(join(folderWorkspace, 'file.md'), store)).resolves.toBe(
      'text\n'
    )
    await expect(readLocalMobileFile(join(floating, 'file.md'), store)).rejects.toThrow(
      'Access denied'
    )
  })
})

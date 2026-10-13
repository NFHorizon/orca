import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../shared/local-file-access'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { nativeChatVisualsFolderFor } from '../native-chat/native-chat-visuals-folder'
import { initOrcaProfilePaths } from '../orca-profiles/profile-storage-paths'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { RuntimeFileCommands } from './orca-runtime-files'
import { requireRuntimeFileProvider } from './runtime-file-command-target'
import type { HostPathFileTarget } from './runtime-host-path-target'

let linkedWorktree = ''

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => [{ path: linkedWorktree }]) }
})

let base: string
let project: string
let folderWorkspace: string
let visualsFolder: string
let floating: string
let outside: string
let store: Store
let commands: RuntimeFileCommands

function makeStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization and the provider read only these Store members.
  return {
    getRepos: () => [
      { id: 'repo', path: project, displayName: 'project', badgeColor: '#000', addedAt: 0 }
    ],
    getRepo: () => undefined,
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [
      { id: 'folder', folderPath: folderWorkspace, projectGroupId: 'none' }
    ],
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

function makeCommands(): RuntimeFileCommands {
  const unused = vi.fn(async () => {
    throw new Error('not used by host-path requests')
  })
  return new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveWorktreeSelector: unused,
    resolveRuntimeFileTarget: unused,
    resolveRuntimeGitTarget: unused,
    openFile: vi.fn(),
    openDiff: vi.fn()
  })
}

/** Every content and metadata method of the host-path form, by the access it declares. */
function requests(path: string, access?: HostPathFileTarget['access']) {
  const target = { path, ...(access ? { access } : {}) }
  return {
    read: () => commands.readHostPathFile(target),
    readPreview: () => commands.readHostPathFilePreview(target),
    readChunk: () => commands.readHostPathFileChunk(target, 0, 4),
    stat: () => commands.statHostPathFile(target),
    write: () => commands.writeHostPathFile(target, 'saved\n', undefined, undefined, 'local')
  }
}

const ACCESSES = [undefined, { kind: 'user-file' }] as const

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-host-path-'))
  project = join(base, 'project')
  linkedWorktree = join(base, 'project-feature')
  folderWorkspace = join(base, 'notes folder')
  outside = join(base, 'outside')
  const userData = join(base, 'user-data')
  installFakeAppEnvironment({ getPath: () => userData })
  initOrcaProfilePaths()
  visualsFolder = nativeChatVisualsFolderFor(userData, 'session-1')
  floating = join(userData, 'floating-workspace')
  for (const dir of [project, linkedWorktree, folderWorkspace, visualsFolder, floating, outside]) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'file.md'), 'text\n')
  }
  store = makeStore()
  commands = makeCommands()
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('host-path requests inside this host’s roots', () => {
  it.each(ACCESSES)(
    'reads, previews, chunks, stats and saves in every root (access %j)',
    async (access) => {
      for (const dir of [project, linkedWorktree, folderWorkspace, visualsFolder]) {
        const file = join(dir, 'file.md')
        const request = requests(file, access)
        await expect(request.read(), dir).resolves.toEqual({
          path: file,
          content: 'text\n',
          truncated: false,
          byteLength: 5
        })
        await expect(request.readPreview(), dir).resolves.toEqual({
          content: 'text\n',
          isBinary: false
        })
        await expect(request.readChunk(), dir).resolves.toMatchObject({
          contentBase64: Buffer.from('text').toString('base64'),
          bytesRead: 4
        })
        await expect(request.stat(), dir).resolves.toMatchObject({ size: 5, isDirectory: false })
        await expect(request.write(), dir).resolves.toEqual({ ok: true })
        expect(await readFile(file, 'utf8')).toBe('saved\n')
      }
    }
  )

  it('creates a new file in a chat visuals folder', async () => {
    const file = join(visualsFolder, 'chart.html')
    await expect(
      commands.writeHostPathFile(
        { path: file, access: { kind: 'user-file' } },
        '<p>hi</p>',
        undefined,
        undefined,
        'local'
      )
    ).resolves.toEqual({ ok: true })
    expect(await readFile(file, 'utf8')).toBe('<p>hi</p>')
  })

  it('stats a root folder itself', async () => {
    await expect(commands.statHostPathFile({ path: visualsFolder })).resolves.toMatchObject({
      isDirectory: true
    })
  })

  it('keeps the ordinary write rules: a directory is never overwritten', async () => {
    await expect(
      commands.writeHostPathFile({ path: visualsFolder }, 'x', undefined, undefined, 'local')
    ).rejects.toThrow('Cannot write to a directory')
  })

  it('keeps the ordinary host expectation on writes', async () => {
    const file = join(project, 'file.md')
    await expect(commands.writeHostPathFile({ path: file }, 'x')).rejects.toThrow()
    await expect(
      commands.writeHostPathFile({ path: file }, 'x', undefined, undefined, 'ssh:box')
    ).rejects.toThrow('Workspace host changed')
    expect(await readFile(file, 'utf8')).toBe('text\n')
  })
})

describe('host-path requests outside this host’s roots', () => {
  async function expectRefusedEverywhere(path: string): Promise<void> {
    for (const access of ACCESSES) {
      for (const [name, request] of Object.entries(requests(path, access))) {
        await expect(request(), `${name} ${JSON.stringify(access)} ${path}`).rejects.toThrow(
          PATH_OUTSIDE_ALLOWED_DIRECTORIES
        )
      }
    }
  }

  it('refuses an existing file outside every root, user-file access included', async () => {
    await expectRefusedEverywhere(join(outside, 'file.md'))
    expect(await readFile(join(outside, 'file.md'), 'utf8')).toBe('text\n')
  })

  it('refuses the rest of Orca’s state folder and the floating-workspace folder', async () => {
    await writeFile(join(base, 'user-data', 'orca-data.json'), '{}')
    await expectRefusedEverywhere(join(base, 'user-data', 'orca-data.json'))
    await expectRefusedEverywhere(join(floating, 'file.md'))
  })

  it('refuses a link inside a root that leads outside', async () => {
    await symlink(join(outside, 'file.md'), join(visualsFolder, 'escape.md'))
    await symlink(outside, join(project, 'escape-dir'))
    await expectRefusedEverywhere(join(visualsFolder, 'escape.md'))
    await expectRefusedEverywhere(join(project, 'escape-dir', 'file.md'))
    await expectRefusedEverywhere(join(project, 'escape-dir', 'new.md'))
  })

  it('refuses `..` out of a root', async () => {
    await expectRefusedEverywhere(`${project}/../outside/file.md`)
    await expectRefusedEverywhere(`${visualsFolder}/../../../outside/file.md`)
  })

  it('refuses a relative path, even one that names a file inside a root', async () => {
    await expectRefusedEverywhere(relative(process.cwd(), join(project, 'file.md')))
    await expectRefusedEverywhere('file.md')
  })
})

describe('workspace-addressed host requests keep their own roots', () => {
  it('never reach the chat visuals folder', async () => {
    const provider = requireRuntimeFileProvider(
      { executionHostId: 'local' },
      { requireStore: () => store }
    )
    await expect(provider.stat(join(visualsFolder, 'file.md'))).rejects.toThrow(
      PATH_OUTSIDE_ALLOWED_DIRECTORIES
    )
    await expect(provider.writeFile(join(visualsFolder, 'file.md'), 'x')).rejects.toThrow(
      PATH_OUTSIDE_ALLOWED_DIRECTORIES
    )
  })
})

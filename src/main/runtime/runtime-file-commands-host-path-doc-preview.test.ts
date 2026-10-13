import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { DOC_PREVIEW_PATH_AUTHORIZATION_ERROR } from '../../shared/doc-preview-file-access'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../shared/local-file-access'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { nativeChatScratchFolderFor } from '../native-chat/native-chat-scratch-folder'
import { initOrcaProfilePaths } from '../orca-profiles/profile-storage-paths'
import type { Store } from '../persistence'
import { RuntimeFileCommands } from './orca-runtime-files'
import type { ResolvedRuntimeFileTarget } from './runtime-file-command-target'
import type { HostPathDocPreviewTarget } from './runtime-file-commands-host-path-files'

let base: string
let project: string
let folderWorkspace: string
let scratchFolder: string
let outside: string
let store: Store
let commands: RuntimeFileCommands

function makeStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
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
  return new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveWorktreeSelector: vi.fn(),
    // Only the workspace form resolves a worktree; it names the repo checkout.
    resolveRuntimeFileTarget: vi.fn(
      async () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the workspace read uses only the worktree path and its host.
        ({
          worktree: { id: 'repo::wt', repoId: 'repo', path: project },
          executionHostId: 'local'
        }) as ResolvedRuntimeFileTarget
    ),
    resolveRuntimeGitTarget: vi.fn(),
    openFile: vi.fn(),
    openDiff: vi.fn()
  })
}

/** The preview a document at `entryPath` holds before the reader approves any directory. */
function entryOnly(
  boundaryPath: string,
  entryPath: string,
  path = entryPath
): HostPathDocPreviewTarget {
  return { path, boundaryPath, entryPath, implicitRootPath: null, authorizedRootPaths: [] }
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-host-path-doc-'))
  project = join(base, 'project')
  folderWorkspace = join(base, 'notes folder')
  outside = join(base, 'outside')
  const userData = join(base, 'user-data')
  installFakeAppEnvironment({ getPath: () => userData })
  initOrcaProfilePaths()
  scratchFolder = nativeChatScratchFolderFor(userData, 'session-1')
  for (const dir of [join(project, 'docs'), folderWorkspace, scratchFolder, outside]) {
    await put(join(dir, 'index.html'), '<h1>doc</h1>')
    await put(join(dir, 'style.css'), 'h1{}')
    await put(join(dir, 'assets', 'logo.svg'), '<svg/>')
  }
  await put(join(project, 'secret.txt'), 'secret')
  store = makeStore()
  commands = makeCommands()
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const DOC = { content: '<h1>doc</h1>', isBinary: false }

describe('readHostPathDocPreviewFile: the entry document', () => {
  it('reads a document inside a workspace, with its workspace as the boundary', async () => {
    for (const [root, entry] of [
      [project, join(project, 'docs', 'index.html')],
      [folderWorkspace, join(folderWorkspace, 'index.html')]
    ]) {
      await expect(
        commands.readHostPathDocPreviewFile(entryOnly(root, entry)),
        root
      ).resolves.toEqual(DOC)
    }
  })

  it('reads a document in a chat scratch folder, entry alone, with or without user-file', async () => {
    const entry = join(scratchFolder, 'index.html')
    await expect(
      commands.readHostPathDocPreviewFile(entryOnly(scratchFolder, entry))
    ).resolves.toEqual(DOC)
    await expect(
      commands.readHostPathDocPreviewFile({
        ...entryOnly(scratchFolder, entry),
        access: { kind: 'user-file' }
      })
    ).resolves.toEqual(DOC)
  })

  it.each([undefined, { kind: 'user-file' } as const])(
    'refuses a document outside every workspace and the scratch folder (access %j)',
    async (access) => {
      const entry = join(outside, 'index.html')
      await expect(
        commands.readHostPathDocPreviewFile({ ...entryOnly(outside, entry), access })
      ).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
    }
  )

  it('refuses any outside path in the request, even with the file itself inside', async () => {
    const entry = join(scratchFolder, 'index.html')
    const outsideRoot = join(outside, 'assets')
    for (const request of [
      { ...entryOnly(outside, entry) },
      { ...entryOnly(scratchFolder, join(outside, 'index.html'), entry) },
      { ...entryOnly(scratchFolder, entry), implicitRootPath: outsideRoot },
      { ...entryOnly(scratchFolder, entry), authorizedRootPaths: [outsideRoot] }
    ]) {
      await expect(commands.readHostPathDocPreviewFile(request)).rejects.toThrow(
        PATH_OUTSIDE_ALLOWED_DIRECTORIES
      )
    }
  })

  it('refuses a scratch-folder link that leads outside', async () => {
    const link = join(scratchFolder, 'linked.html')
    await symlink(join(outside, 'index.html'), link)
    await expect(
      commands.readHostPathDocPreviewFile(entryOnly(scratchFolder, link))
    ).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
  })

  it('refuses relative paths', async () => {
    const entry = join(scratchFolder, 'index.html')
    const relativeEntry = relative(process.cwd(), entry)
    for (const request of [
      entryOnly(scratchFolder, relativeEntry),
      entryOnly(relative(process.cwd(), scratchFolder), entry),
      { ...entryOnly(scratchFolder, entry), authorizedRootPaths: ['assets'] }
    ]) {
      await expect(commands.readHostPathDocPreviewFile(request)).rejects.toThrow(
        PATH_OUTSIDE_ALLOWED_DIRECTORIES
      )
    }
  })
})

describe('readHostPathDocPreviewFile: files beside the entry', () => {
  it('refuses a sibling or sub-resource the reader has not approved', async () => {
    const entry = join(scratchFolder, 'index.html')
    for (const sibling of [
      join(scratchFolder, 'style.css'),
      join(scratchFolder, 'assets', 'logo.svg')
    ]) {
      await expect(
        commands.readHostPathDocPreviewFile(entryOnly(scratchFolder, entry, sibling))
      ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
    }
  })

  it('gives a document at its boundary no silent authority over that directory', async () => {
    const entry = join(scratchFolder, 'index.html')
    await expect(
      commands.readHostPathDocPreviewFile({
        ...entryOnly(scratchFolder, entry, join(scratchFolder, 'style.css')),
        implicitRootPath: scratchFolder
      })
    ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
  })

  it('reads a file under a directory the reader approved', async () => {
    const entry = join(scratchFolder, 'index.html')
    await expect(
      commands.readHostPathDocPreviewFile({
        ...entryOnly(scratchFolder, entry, join(scratchFolder, 'assets', 'logo.svg')),
        authorizedRootPaths: [join(scratchFolder, 'assets')]
      })
    ).resolves.toEqual({
      content: Buffer.from('<svg/>').toString('base64'),
      isBinary: true,
      mimeType: 'image/svg+xml'
    })
  })

  it('reads beside a workspace document under its own directory, but not elsewhere', async () => {
    const entry = join(project, 'docs', 'index.html')
    const withImplicitRoot = (path: string): HostPathDocPreviewTarget => ({
      ...entryOnly(project, entry, path),
      implicitRootPath: join(project, 'docs')
    })
    await expect(
      commands.readHostPathDocPreviewFile(withImplicitRoot(join(project, 'docs', 'style.css')))
    ).resolves.toEqual({ content: 'h1{}', isBinary: false })
    await expect(
      commands.readHostPathDocPreviewFile(withImplicitRoot(join(project, 'secret.txt')))
    ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
  })

  it('refuses an approved directory outside the preview boundary', async () => {
    const entry = join(project, 'docs', 'index.html')
    await expect(
      commands.readHostPathDocPreviewFile({
        ...entryOnly(join(project, 'docs'), entry, join(scratchFolder, 'style.css')),
        authorizedRootPaths: [scratchFolder]
      })
    ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
  })

  it('refuses a chat-visual access before reading', async () => {
    const entry = join(scratchFolder, 'index.html')
    await expect(
      commands.readHostPathDocPreviewFile({
        ...entryOnly(scratchFolder, entry),
        access: { kind: 'chat-visual' }
      })
    ).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
  })
})

describe('readDocPreviewFile: the workspace form', () => {
  it('reads with the same authority as before', async () => {
    await expect(
      commands.readDocPreviewFile('id:wt', 'docs/style.css', 'docs/index.html', 'docs', [])
    ).resolves.toEqual({ content: 'h1{}', isBinary: false })
    await expect(
      commands.readDocPreviewFile('id:wt', 'secret.txt', 'docs/index.html', 'docs', [])
    ).rejects.toThrow(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
  })
})

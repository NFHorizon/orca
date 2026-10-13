import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { NATIVE_CHAT_VISUAL_MAX_BYTES } from '../../shared/native-chat-visual-directive'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../shared/local-file-access'
import { NOT_A_REGULAR_FILE_MESSAGE } from '../ipc/filesystem/local-regular-file-read'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import {
  createChatVisualAccessFixture,
  VISUAL_HTML,
  type ChatVisualAccessFixture
} from '../native-chat/native-chat-visual-access-test-fixture'
import { initOrcaProfilePaths } from '../orca-profiles/profile-storage-paths'
import type { Store } from '../persistence'
import type * as RepoWorktrees from '../repo-worktrees'
import { RuntimeFileCommands } from './orca-runtime-files'

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

const CHAT_VISUAL = { kind: 'chat-visual' } as const

let base: string
let project: string
let fixture: ChatVisualAccessFixture
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
    getFolderWorkspaces: () => [],
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

function makeCommands(store: Store): RuntimeFileCommands {
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

function readVisual(path: string) {
  return commands.readHostPathFile({ path, access: CHAT_VISUAL })
}

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-host-chat-visual-'))
  project = join(base, 'project')
  const userData = join(base, 'user-data')
  await mkdir(project, { recursive: true })
  installFakeAppEnvironment({ getPath: () => userData })
  initOrcaProfilePaths()
  fixture = await createChatVisualAccessFixture(userData, project)
  commands = makeCommands(makeStore())
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('a chat-visual read by host path', () => {
  it('reads a visual in a chat scratch folder like any files.read', async () => {
    await expect(readVisual(fixture.visual)).resolves.toEqual({
      path: fixture.visual,
      content: VISUAL_HTML,
      truncated: false,
      byteLength: Buffer.byteLength(VISUAL_HTML)
    })
  })

  it('refuses every path but a visual directly in a chat folder, project files included', async () => {
    for (const [label, path] of fixture.refused) {
      // A project file is readable without the kind; the kind never falls back to it.
      await expect(readVisual(path), label).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
    }
    await expect(commands.readHostPathFile({ path: join(project, 'chart.html') })).resolves.toEqual(
      expect.objectContaining({ content: VISUAL_HTML })
    )
  })

  it('tells a missing visual from a refused one', async () => {
    await expect(readVisual(join(fixture.scratchFolder, 'gone.html'))).rejects.toMatchObject({
      message: expect.stringContaining('ENOENT'),
      code: 'ENOENT'
    })
    // A chat that never wrote a visual has no folder yet.
    await expect(
      readVisual(join(dirname(fixture.scratchFolder), 'a'.repeat(32), 'chart.html'))
    ).rejects.toThrow('ENOENT')
  })

  it('refuses a visual over 512 KiB, reading one at the cap', async () => {
    const atCap = join(fixture.scratchFolder, 'at-cap.html')
    const overCap = join(fixture.scratchFolder, 'over-cap.html')
    await writeFile(atCap, 'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES))
    await writeFile(overCap, 'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES + 1))
    await expect(readVisual(atCap)).resolves.toMatchObject({
      byteLength: NATIVE_CHAT_VISUAL_MAX_BYTES,
      truncated: false
    })
    await expect(readVisual(overCap)).rejects.toThrow('file_too_large')
  })

  it('refuses a NUL byte or invalid UTF-8, and a directory', async () => {
    await writeFile(join(fixture.scratchFolder, 'with-nul.html'), Buffer.from('<p>\0</p>'))
    await writeFile(join(fixture.scratchFolder, 'latin1.html'), Buffer.from([0x3c, 0xe9, 0x3e]))
    await mkdir(join(fixture.scratchFolder, 'folder.html'))
    await expect(readVisual(join(fixture.scratchFolder, 'with-nul.html'))).rejects.toThrow(
      'binary_file'
    )
    await expect(readVisual(join(fixture.scratchFolder, 'latin1.html'))).rejects.toThrow(
      'binary_file'
    )
    await expect(readVisual(join(fixture.scratchFolder, 'folder.html'))).rejects.toThrow(
      NOT_A_REGULAR_FILE_MESSAGE
    )
  })

  it('serves no other method, in the scratch folder or a project', async () => {
    for (const path of [fixture.visual, join(project, 'chart.html')]) {
      const target = { path, access: CHAT_VISUAL }
      const others = {
        readPreview: () => commands.readHostPathFilePreview(target),
        readChunk: () => commands.readHostPathFileChunk(target, 0, 4),
        stat: () => commands.statHostPathFile(target),
        write: () => commands.writeHostPathFile(target, 'saved\n', undefined, undefined, 'local')
      }
      for (const [name, request] of Object.entries(others)) {
        await expect(request(), `${name} ${path}`).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
      }
      expect(await readFile(path, 'utf8')).toBe(VISUAL_HTML)
    }
  })
})

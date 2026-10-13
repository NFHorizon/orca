import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { NATIVE_CHAT_VISUAL_MAX_BYTES } from '../../../shared/native-chat-visual-directive'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../shared/local-file-access'
import {
  createChatVisualAccessFixture,
  VISUAL_HTML,
  type ChatVisualAccessFixture
} from '../../native-chat/native-chat-visual-access-test-fixture'
import { initOrcaProfilePaths } from '../../orca-profiles/profile-storage-paths'
import type { Store } from '../../persistence'
import type * as RepoWorktrees from '../../repo-worktrees'
import { registerFilesystemMutationHandlers } from '../filesystem-mutations'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { registerFilesystemReadHandlers } from './filesystem-read-handlers'
import { NOT_A_REGULAR_FILE_MESSAGE } from './local-regular-file-read'

type Handler = (event: unknown, args: Record<string, unknown>) => Promise<unknown>

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  app: { getPath: () => tmpdir() },
  shell: {}
}))
vi.mock('../../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktrees>('../../repo-worktrees')
  return { ...actual, listRepoWorktreeGraph: vi.fn(async () => []) }
})

const CHAT_VISUAL = { kind: 'chat-visual' } as const
const EVENT = { sender: { id: 1, once: vi.fn(), removeListener: vi.fn() } }

let base: string
let project: string
let fixture: ChatVisualAccessFixture

function makeStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these Store members.
  return {
    getRepos: () => [
      { id: 'repo', path: project, displayName: 'project', badgeColor: '#000', addedAt: 0 }
    ],
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '' })
  } as unknown as Store
}

function invoke(channel: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler(EVENT, args)
}

function readVisual(filePath: string): Promise<unknown> {
  return invoke('fs:readFile', { filePath, access: CHAT_VISUAL })
}

beforeEach(async () => {
  handlers.clear()
  invalidateAuthorizedRootsCache()
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-ipc-chat-visual-'))
  project = join(base, 'project')
  const userData = join(base, 'user-data')
  await mkdir(project, { recursive: true })
  installFakeAppEnvironment({ getPath: () => userData })
  initOrcaProfilePaths()
  fixture = await createChatVisualAccessFixture(userData, project)
  const store = makeStore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read handlers use only the store.
  registerFilesystemReadHandlers({ store } as FilesystemHandlerContext)
  registerFilesystemMutationHandlers(store)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('a desktop chat-visual read', () => {
  it('reads a visual in a chat scratch folder like any file read', async () => {
    await expect(readVisual(fixture.visual)).resolves.toEqual({
      content: VISUAL_HTML,
      isBinary: false
    })
  })

  it('refuses every path but a visual directly in a chat folder, project files included', async () => {
    for (const [label, path] of fixture.refused) {
      await expect(readVisual(path), label).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
    }
    // The same project file reads without the kind; the kind never falls back to it.
    await expect(invoke('fs:readFile', { filePath: join(project, 'chart.html') })).resolves.toEqual(
      { content: VISUAL_HTML, isBinary: false }
    )
  })

  it('tells a missing visual from a refused one', async () => {
    await expect(readVisual(join(fixture.scratchFolder, 'gone.html'))).rejects.toThrow('ENOENT')
    await expect(
      readVisual(join(dirname(fixture.scratchFolder), 'a'.repeat(32), 'chart.html'))
    ).rejects.toThrow('ENOENT')
  })

  it('refuses a visual over 512 KiB, NUL bytes, invalid UTF-8 and a directory', async () => {
    const atCap = join(fixture.scratchFolder, 'at-cap.html')
    await writeFile(atCap, 'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES))
    await writeFile(
      join(fixture.scratchFolder, 'over-cap.html'),
      'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES + 1)
    )
    await writeFile(join(fixture.scratchFolder, 'with-nul.html'), Buffer.from('<p>\0</p>'))
    await writeFile(join(fixture.scratchFolder, 'latin1.html'), Buffer.from([0x3c, 0xe9, 0x3e]))
    await mkdir(join(fixture.scratchFolder, 'folder.html'))

    await expect(readVisual(atCap)).resolves.toMatchObject({ isBinary: false })
    await expect(readVisual(join(fixture.scratchFolder, 'over-cap.html'))).rejects.toThrow(
      'file_too_large'
    )
    for (const file of ['with-nul.html', 'latin1.html']) {
      await expect(readVisual(join(fixture.scratchFolder, file)), file).rejects.toThrow(
        'binary_file'
      )
    }
    await expect(readVisual(join(fixture.scratchFolder, 'folder.html'))).rejects.toThrow(
      NOT_A_REGULAR_FILE_MESSAGE
    )
  })

  it('serves no other channel, in the scratch folder or a project', async () => {
    for (const filePath of [fixture.visual, join(project, 'chart.html')]) {
      const others: [string, Record<string, unknown>][] = [
        ['fs:stat', { filePath }],
        ['fs:pathExists', { filePath }],
        ['fs:readFileChunk', { filePath, offset: 0, length: 4 }],
        ['fs:rename', { oldPath: filePath, newPath: `${filePath}.moved` }],
        ['fs:importExternalPaths', { sourcePaths: [], destDir: dirname(filePath) }]
      ]
      for (const [channel, args] of others) {
        await expect(
          invoke(channel, { ...args, access: CHAT_VISUAL }),
          `${channel} ${filePath}`
        ).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
      }
      expect(await readFile(filePath, 'utf8')).toBe(VISUAL_HTML)
    }
  })
})

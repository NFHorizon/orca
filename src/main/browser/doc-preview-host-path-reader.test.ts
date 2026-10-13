import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { fromPartition: vi.fn() }
}))
vi.mock('./browser-session-partition-policies', () => ({
  installBrowserSessionPartitionPolicies: vi.fn()
}))
vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/user-data'
}))

import { readDocPreviewFile } from './doc-preview-file-reader'
import { handleDocPreviewRequest } from './doc-preview-protocol'
import {
  authorizeDocPreviewDirectory,
  mintDocPreviewGrant,
  revokeAllDocPreviewGrants,
  revokeDocPreviewGrant
} from './doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'

const CHAT_FOLDER = '/home/me/state/ab12'

// Why the renderer's shape: an outside document's own folder is both its boundary and its root.
function hostPathGrant(folder = CHAT_FOLDER): ReturnType<typeof mintDocPreviewGrant> {
  return mintDocPreviewGrant({
    owner: { kind: 'host-path', environmentId: 'env-1', worktreeSelector: 'id:wt-1' },
    requestBase: folder,
    root: folder,
    entryRelativePath: 'chart.html',
    browserPageId: 'page-1'
  })
}

function servePage(content = '<h1>chart</h1>'): void {
  mocks.callRuntimeEnvironment.mockResolvedValue({
    ok: true,
    result: { content, isBinary: false }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  revokeAllDocPreviewGrants()
})

describe('readDocPreviewFile — host-path owner', () => {
  it('reads the entry by its path, bounded by its own folder with no silent directory authority', async () => {
    servePage()

    const outcome = await readDocPreviewFile(hostPathGrant(), 'chart.html')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.readDocPreview',
      {
        path: `${CHAT_FOLDER}/chart.html`,
        boundaryPath: CHAT_FOLDER,
        entryPath: `${CHAT_FOLDER}/chart.html`,
        implicitRootPath: null,
        authorizedRootPaths: []
      },
      15_000
    )
    expect(outcome).toEqual({
      ok: true,
      bytes: Buffer.from('<h1>chart</h1>', 'utf8'),
      contentType: 'text/html; charset=utf-8'
    })
  })

  it('asks for approval before reading an unapproved sibling, without touching the host', async () => {
    const outcome = await readDocPreviewFile(hostPathGrant(), 'secrets.txt')

    expect(outcome).toMatchObject({ ok: false, status: 403, reason: 'authorization-required' })
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('never resolves a traversal out of the folder, such as another chat folder', async () => {
    for (const request of ['../cd34/other.html', 'assets/../../cd34/other.html', '..']) {
      expect(await readDocPreviewFile(hostPathGrant(), request)).toMatchObject({
        ok: false,
        status: 404
      })
    }
    expect(mocks.callRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('reads an approved asset and sends the approval for the host to enforce', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { content: png.toString('base64'), isBinary: true, mimeType: 'image/png' }
    })
    const grant = hostPathGrant()
    expect(authorizeDocPreviewDirectory(grant.id, 'assets/logo.png')).toBe(true)

    const outcome = await readDocPreviewFile(grant, 'assets/logo.png')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.readDocPreview',
      {
        path: `${CHAT_FOLDER}/assets/logo.png`,
        boundaryPath: CHAT_FOLDER,
        entryPath: `${CHAT_FOLDER}/chart.html`,
        implicitRootPath: null,
        authorizedRootPaths: [`${CHAT_FOLDER}/assets`]
      },
      15_000
    )
    expect(outcome).toEqual({ ok: true, bytes: png, contentType: 'image/png' })
  })

  it('serves nothing when the host refuses the path, e.g. a symlink out of the folder', async () => {
    mocks.callRuntimeEnvironment.mockResolvedValue({
      ok: false,
      error: { code: 'internal_error', message: 'doc_preview_path_unauthorized' }
    })
    const grant = hostPathGrant()
    authorizeDocPreviewDirectory(grant.id, 'link/page.html')

    expect(await readDocPreviewFile(grant, 'link/page.html')).toEqual({
      ok: false,
      status: 404,
      reason: 'unreadable',
      message: 'doc_preview_path_unauthorized'
    })
  })

  it('keeps a Windows host path in its own spelling', async () => {
    servePage()
    const folder = 'C:\\Users\\me\\state\\ab12'

    await readDocPreviewFile(hostPathGrant(folder), 'chart.html')

    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.readDocPreview',
      expect.objectContaining({
        path: `${folder}\\chart.html`,
        boundaryPath: folder,
        entryPath: `${folder}\\chart.html`
      }),
      15_000
    )
  })
})

describe('host-path preview grant lifetime', () => {
  it('stops serving the document once its grant is revoked', async () => {
    servePage()
    const grant = hostPathGrant()
    const url = buildDocPreviewUrl(grant.id, 'chart.html')

    expect((await handleDocPreviewRequest(new Request(url))).status).toBe(200)
    revokeDocPreviewGrant(grant.id)
    expect((await handleDocPreviewRequest(new Request(url))).status).toBe(404)
    expect(mocks.callRuntimeEnvironment).toHaveBeenCalledOnce()
  })
})

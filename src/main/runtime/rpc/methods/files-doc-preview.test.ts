import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { MIXED_FILE_TARGET_MESSAGE } from '../../../../shared/rpc-contract/files-target-params'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'
import { HOST_PATH_NOT_SERVED_HERE_MESSAGE } from './files-host-path-owner'

const WORKSPACE = {
  worktree: 'id:wt-1',
  relativePath: 'docs/index.html',
  entryRelativePath: 'docs/index.html',
  implicitRootRelativePath: 'docs',
  authorizedRootRelativePaths: ['assets']
}

const HOST_PATH = {
  path: '/srv/scratch/0123/index.html',
  access: { kind: 'user-file' },
  boundaryPath: '/srv/scratch/0123',
  entryPath: '/srv/scratch/0123/index.html',
  implicitRootPath: null,
  authorizedRootPaths: ['/srv/scratch/0123/assets']
}

function makeRequest(params: unknown, executionHost?: unknown): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method: 'files.readDocPreview',
    params,
    ...(executionHost === undefined ? {} : { executionHost })
  }
}

function makeRuntime() {
  const fns = {
    readDocPreviewFile: vi.fn().mockResolvedValue({ content: '<h1>safe</h1>', isBinary: false }),
    readHostPathDocPreviewFile: vi
      .fn()
      .mockResolvedValue({ content: '<h1>host</h1>', isBinary: false })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler reaches only the stubbed runtime members.
  const runtime = { getRuntimeId: () => 'test-runtime', ...fns } as unknown as OrcaRuntimeService
  return { fns, dispatcher: new RpcDispatcher({ runtime, methods: FILE_METHODS }) }
}

describe('files.readDocPreview', () => {
  it('passes document-preview authority to the dedicated host method', async () => {
    const { fns, dispatcher } = makeRuntime()

    const response = await dispatcher.dispatch(makeRequest(WORKSPACE))

    expect(fns.readDocPreviewFile).toHaveBeenCalledWith(
      'id:wt-1',
      'docs/index.html',
      'docs/index.html',
      'docs',
      ['assets'],
      undefined
    )
    expect(fns.readHostPathDocPreviewFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: true, result: { content: '<h1>safe</h1>' } })
  })

  it('passes a document named by host path, with its authority, to the host-path command', async () => {
    const { fns, dispatcher } = makeRuntime()

    const response = await dispatcher.dispatch(makeRequest(HOST_PATH))

    expect(fns.readHostPathDocPreviewFile).toHaveBeenCalledWith(HOST_PATH, undefined)
    expect(fns.readDocPreviewFile).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: true, result: { content: '<h1>host</h1>' } })
  })

  it.each([undefined, 'local'])('serves the host-path form tagged %j', async (tag) => {
    const { fns, dispatcher } = makeRuntime()
    await expect(dispatcher.dispatch(makeRequest(HOST_PATH, tag))).resolves.toMatchObject({
      ok: true
    })
    expect(fns.readHostPathDocPreviewFile).toHaveBeenCalledTimes(1)
  })

  it.each(['ssh:box', 'runtime:env-1', 'nonsense', 42])(
    'refuses the host-path form tagged for another host (%j) without reading',
    async (tag) => {
      const { fns, dispatcher } = makeRuntime()
      await expect(dispatcher.dispatch(makeRequest(HOST_PATH, tag))).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument', message: HOST_PATH_NOT_SERVED_HERE_MESSAGE }
      })
      expect(fns.readHostPathDocPreviewFile).not.toHaveBeenCalled()
    }
  )

  it('still routes a workspace request tagged for another host to its workspace', async () => {
    const { fns, dispatcher } = makeRuntime()
    await dispatcher.dispatch(makeRequest(WORKSPACE, 'ssh:box'))
    expect(fns.readDocPreviewFile).toHaveBeenCalledTimes(1)
  })

  it('refuses a request naming both forms before the runtime', async () => {
    const { fns, dispatcher } = makeRuntime()
    await expect(
      dispatcher.dispatch(makeRequest({ ...WORKSPACE, path: HOST_PATH.path }))
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: MIXED_FILE_TARGET_MESSAGE }
    })
    expect(fns.readDocPreviewFile).not.toHaveBeenCalled()
    expect(fns.readHostPathDocPreviewFile).not.toHaveBeenCalled()
  })

  it('refuses a chat-visual access before the runtime', async () => {
    const { fns, dispatcher } = makeRuntime()
    await expect(
      dispatcher.dispatch(makeRequest({ ...HOST_PATH, access: { kind: 'chat-visual' } }))
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(fns.readHostPathDocPreviewFile).not.toHaveBeenCalled()
  })
})

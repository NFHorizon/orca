import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { MIXED_FILE_TARGET_MESSAGE } from '../../../../shared/rpc-contract/files-target-params'
import { HOST_PATH_NOT_SERVED_HERE_MESSAGE } from './files-host-path-owner'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown, executionHost?: unknown): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method,
    params,
    ...(executionHost === undefined ? {} : { executionHost })
  }
}

function makeRuntime() {
  const fns = {
    readMobileFile: vi.fn().mockResolvedValue('workspace-read'),
    readHostPathFile: vi.fn().mockResolvedValue('host-read'),
    readFileExplorerPreview: vi.fn().mockResolvedValue('workspace-preview'),
    readHostPathFilePreview: vi.fn().mockResolvedValue('host-preview'),
    readFileExplorerChunk: vi.fn().mockResolvedValue('workspace-chunk'),
    readHostPathFileChunk: vi.fn().mockResolvedValue('host-chunk'),
    statRuntimeFile: vi.fn().mockResolvedValue('workspace-stat'),
    statHostPathFile: vi.fn().mockResolvedValue('host-stat'),
    writeFileExplorerFile: vi.fn().mockResolvedValue('workspace-write'),
    writeHostPathFile: vi.fn().mockResolvedValue('host-write')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers reach only the stubbed runtime members.
  const runtime = { getRuntimeId: () => 'test-runtime', ...fns } as unknown as OrcaRuntimeService
  return { fns, dispatcher: new RpcDispatcher({ runtime, methods: FILE_METHODS }) }
}

const HOST_PATH = { path: '/srv/notes/a.md', access: { kind: 'user-file' } }
const WORKSPACE = { worktree: 'id:wt-1', relativePath: 'a.md' }
const SAVE = { content: 'saved', expectedExecutionHostId: 'local' }

describe('file methods route each target form to its own command', () => {
  it.each([
    ['files.read', {}, 'workspace-read', 'host-read'],
    ['files.readPreview', {}, 'workspace-preview', 'host-preview'],
    ['files.readChunk', { offset: 4, length: 8 }, 'workspace-chunk', 'host-chunk'],
    ['files.stat', {}, 'workspace-stat', 'host-stat'],
    ['files.write', SAVE, 'workspace-write', 'host-write']
  ])('%s', async (method, fields, workspaceResult, hostResult) => {
    const { dispatcher } = makeRuntime()
    await expect(
      dispatcher.dispatch(makeRequest(method, { ...WORKSPACE, ...fields }))
    ).resolves.toMatchObject({ ok: true, result: workspaceResult })
    await expect(
      dispatcher.dispatch(makeRequest(method, { ...HOST_PATH, ...fields }))
    ).resolves.toMatchObject({ ok: true, result: hostResult })
  })

  it('passes the workspace form exactly as before', async () => {
    const { fns, dispatcher } = makeRuntime()
    await dispatcher.dispatch(makeRequest('files.read', WORKSPACE))
    await dispatcher.dispatch(makeRequest('files.readPreview', WORKSPACE))
    await dispatcher.dispatch(
      makeRequest('files.readChunk', { ...WORKSPACE, offset: 4, length: 8 })
    )
    await dispatcher.dispatch(makeRequest('files.stat', WORKSPACE))
    await dispatcher.dispatch(makeRequest('files.write', { ...WORKSPACE, ...SAVE }))

    expect(fns.readMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.md')
    expect(fns.readFileExplorerPreview).toHaveBeenCalledWith('id:wt-1', 'a.md')
    expect(fns.readFileExplorerChunk).toHaveBeenCalledWith('id:wt-1', 'a.md', 4, 8)
    expect(fns.statRuntimeFile).toHaveBeenCalledWith('id:wt-1', 'a.md')
    expect(fns.writeFileExplorerFile).toHaveBeenCalledWith(
      'id:wt-1',
      'a.md',
      'saved',
      undefined,
      undefined,
      'local'
    )
  })

  it('passes the host path, its access and the method fields', async () => {
    const { fns, dispatcher } = makeRuntime()
    await dispatcher.dispatch(makeRequest('files.read', HOST_PATH))
    await dispatcher.dispatch(
      makeRequest('files.readChunk', { ...HOST_PATH, offset: 4, length: 8 })
    )
    await dispatcher.dispatch(makeRequest('files.write', { ...HOST_PATH, ...SAVE }))

    const target = expect.objectContaining(HOST_PATH)
    expect(fns.readHostPathFile).toHaveBeenCalledWith(target)
    expect(fns.readHostPathFileChunk).toHaveBeenCalledWith(target, 4, 8)
    expect(fns.writeHostPathFile).toHaveBeenCalledWith(
      target,
      'saved',
      undefined,
      undefined,
      'local'
    )
  })

  it.each(['files.read', 'files.readPreview', 'files.stat', 'files.write'])(
    '%s refuses a request naming both forms before reaching the runtime',
    async (method) => {
      const { fns, dispatcher } = makeRuntime()
      const response = await dispatcher.dispatch(
        makeRequest(method, { ...WORKSPACE, ...HOST_PATH, ...SAVE })
      )
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument', message: MIXED_FILE_TARGET_MESSAGE }
      })
      for (const fn of Object.values(fns)) {
        expect(fn).not.toHaveBeenCalled()
      }
    }
  )

  describe('a path is served only by the host that owns it', () => {
    const METHOD_FIELDS = [
      ['files.read', {}],
      ['files.readPreview', {}],
      ['files.readChunk', { offset: 4, length: 8 }],
      ['files.stat', {}],
      ['files.write', SAVE]
    ] as const

    it.each(METHOD_FIELDS)(
      '%s refuses a path tagged for another host without touching this disk',
      async (method, fields) => {
        // An SSH target, a server this process did not relay to, or an unreadable tag.
        for (const executionHost of ['ssh:box', 'runtime:env-1', 'nonsense', 42]) {
          const { fns, dispatcher } = makeRuntime()
          const response = await dispatcher.dispatch(
            makeRequest(method, { ...HOST_PATH, ...fields }, executionHost)
          )
          expect(response, String(executionHost)).toMatchObject({
            ok: false,
            error: { code: 'invalid_argument', message: HOST_PATH_NOT_SERVED_HERE_MESSAGE }
          })
          for (const fn of Object.values(fns)) {
            expect(fn).not.toHaveBeenCalled()
          }
        }
      }
    )

    it.each(METHOD_FIELDS)(
      '%s serves an untagged or local-tagged path here',
      async (method, fields) => {
        for (const executionHost of [undefined, 'local']) {
          const { dispatcher } = makeRuntime()
          await expect(
            dispatcher.dispatch(makeRequest(method, { ...HOST_PATH, ...fields }, executionHost))
          ).resolves.toMatchObject({ ok: true })
        }
      }
    )

    it('leaves the workspace form to its workspace, whatever the tag', async () => {
      const { fns, dispatcher } = makeRuntime()
      await expect(
        dispatcher.dispatch(makeRequest('files.read', WORKSPACE, 'ssh:box'))
      ).resolves.toMatchObject({ ok: true, result: 'workspace-read' })
      expect(fns.readMobileFile).toHaveBeenCalledWith('id:wt-1', 'a.md')
    })
  })
})

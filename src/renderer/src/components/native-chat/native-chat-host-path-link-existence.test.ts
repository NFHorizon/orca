import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../../shared/runtime-file-contracts'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../../shared/local-file-access'
import type { FileLinkTarget } from '@/components/terminal-pane/terminal-file-link-target'
import { runtimeEnvironmentServesFilesByPath } from '@/runtime/runtime-file-address'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  type RuntimeRpcRequest
} from '@/runtime/runtime-file-client-test-harness'
import { createHostPathLinkExistence } from './native-chat-host-path-link-existence'

const store = vi.hoisted(() => ({
  runtimeStatusByEnvironmentId: new Map<string, { status: unknown }>()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

installRuntimeFileClientEnvironment()

// Neutral host path outside the workspace; which paths a host serves is the host's rule.
const HOST_FILE = '/home/me/state/ab12/report.md'
let servesByPath = true

function link(absolutePath: string): FileLinkTarget {
  return {
    absolutePath,
    line: null,
    column: null,
    fileContext: {
      target: { kind: 'environment', environmentId: 'env-1' },
      worktreeId: 'wt-1',
      worktreePath: '/srv/repo',
      sourceHostResolved: true
    },
    isRemoteRuntimePath: false,
    cacheKey: absolutePath,
    isKnownWorktreeRoot: false
  }
}

function hostCalls(method?: string): RuntimeRpcRequest[] {
  return runtimeEnvironmentTransportCall.mock.calls
    .map(([request]) => request)
    .filter((request) => (method ? request.method === method : request.method !== 'status.get'))
}

function answer(result: unknown) {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

function refuse(message: string) {
  return { id: 'rpc', ok: false, error: { code: 'runtime_error', message }, _meta: {} }
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(async () => {
  servesByPath = true
  store.runtimeStatusByEnvironmentId = new Map()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeRpcRequest) =>
    args.method === 'status.get'
      ? Promise.resolve(
          answer({
            runtimeId: 'remote-runtime',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: [
              FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
              ...(servesByPath ? [FILES_HOST_PATH_RUNTIME_CAPABILITY] : [])
            ]
          })
        )
      : runtimeEnvironmentCall(args)
  )
})

async function hostAnswered(serves: boolean): Promise<void> {
  servesByPath = serves
  await runtimeEnvironmentServesFilesByPath('env-1')
  runtimeEnvironmentTransportCall.mockClear()
}

describe('a chat link to a file outside the workspace', () => {
  it('is the host’s file after one by-path stat, with no path resolution', async () => {
    await hostAnswered(true)
    runtimeEnvironmentCall.mockResolvedValue(answer({ size: 8, isDirectory: false, mtime: 1 }))

    expect(await createHostPathLinkExistence()(link(HOST_FILE))).toBe(true)

    expect(hostCalls()).toEqual([
      expect.objectContaining({
        method: 'files.stat',
        params: { path: HOST_FILE, access: { kind: 'user-file' } },
        timeoutMs: 5_000
      })
    ])
  })

  it.each([
    ['a path the host does not serve', refuse(PATH_OUTSIDE_ALLOWED_DIRECTORIES)],
    ['a path the host does not have', refuse('ENOENT: no such file or directory')]
  ])('leaves %s to today’s check after one stat', async (_label, reply) => {
    await hostAnswered(true)
    runtimeEnvironmentCall.mockResolvedValue(reply)

    expect(await createHostPathLinkExistence()(link('/Users/me/notes.md'))).toBe(false)
    expect(hostCalls()).toHaveLength(1)
  })

  it.each([
    ['unreachable', new Error('socket closed')],
    ['too slow', new Error('Runtime request timed out')]
  ])('leaves it to today’s check when the host is %s, never as an error', async (_label, error) => {
    await hostAnswered(true)
    runtimeEnvironmentCall.mockRejectedValue(error)

    await expect(createHostPathLinkExistence()(link(HOST_FILE))).resolves.toBe(false)
  })

  it('never asks an older host, even across many links and rechecks', async () => {
    await hostAnswered(false)
    const hasFile = createHostPathLinkExistence()

    for (let round = 0; round < 3; round += 1) {
      for (let index = 0; index < 5; index += 1) {
        expect(await hasFile(link(`/tmp/out-${index}.log`))).toBe(false)
      }
    }

    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
  })

  it('never asks a host the app already shows as unreachable', async () => {
    await hostAnswered(true)
    store.runtimeStatusByEnvironmentId.set('env-1', { status: null })

    expect(await createHostPathLinkExistence()(link(HOST_FILE))).toBe(false)
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
  })

  it('gives every link back to today’s check within one deadline when the host stops answering', async () => {
    await hostAnswered(true)
    vi.useFakeTimers()
    // The host still has a cached capable status, but now answers nothing, status checks included.
    runtimeEnvironmentTransportCall.mockImplementation(() => new Promise(() => {}))
    const hasFile = createHostPathLinkExistence()
    const settled: boolean[] = []

    for (let index = 0; index < 20; index += 1) {
      void hasFile(link(`/Users/me/notes-${index}.md`)).then((exists) => settled.push(exists))
    }
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(settled).toEqual(Array.from({ length: 20 }, () => false))
    // Links that waited in the queue past the deadline never reach the host.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(hostCalls('files.stat').length).toBeLessThanOrEqual(4)
  })

  it('does not wait for a host that has never answered', async () => {
    runtimeEnvironmentTransportCall.mockImplementation(() => new Promise(() => {}))

    await expect(createHostPathLinkExistence()(link(HOST_FILE))).resolves.toBe(false)
    expect(hostCalls('files.stat')).toEqual([])
  })

  it('keeps workspace paths off this check', async () => {
    await hostAnswered(true)

    expect(
      await createHostPathLinkExistence()({ ...link('/srv/repo/a.ts'), isRemoteRuntimePath: true })
    ).toBe(false)
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
  })

  it('asks about at most four links at once', async () => {
    await hostAnswered(true)
    const pending: (() => void)[] = []
    runtimeEnvironmentCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(answer({ size: 1, isDirectory: false, mtime: 1 })))
        })
    )
    const hasFile = createHostPathLinkExistence()

    const answers = Promise.all(
      Array.from({ length: 10 }, (_, index) => hasFile(link(`/home/me/state/ab12/${index}.md`)))
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pending).toHaveLength(4)
    while (pending.length > 0) {
      pending.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(await answers).toEqual(Array.from({ length: 10 }, () => true))
    expect(hostCalls('files.stat')).toHaveLength(10)
  })
})

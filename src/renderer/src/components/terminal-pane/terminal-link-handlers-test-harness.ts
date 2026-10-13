import { afterEach, beforeEach, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { getConnectionId } from '@/lib/connection-context'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { clearRuntimeHostPathProbesForTests } from '@/runtime/runtime-file-address'
import type { TerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../../shared/local-file-access'

export function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

export function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

export async function flushDoubleRaf(): Promise<void> {
  await flushAsyncWork()
  await flushAsyncWork()
}

/** What a host advertising `files.host-path.v1` answers for a path outside its workspaces and scratch folder. */
export const HOST_PATH_REFUSAL = {
  id: 'rpc-host-path',
  ok: false,
  error: { code: 'runtime_error', message: PATH_OUTSIDE_ALLOWED_DIRECTORIES },
  _meta: { runtimeId: 'remote-runtime' }
}

/** Per-spec window/IPC stubs plus mock resets every terminal link suite shares. */
export function installTerminalLinkTestEnvironment(doubles: TerminalLinkTestDoubles): void {
  const {
    openUrlMock,
    openFileUriMock,
    openFilePathMock,
    statMock,
    fsPathExistsMock,
    runtimeEnvironmentCallMock,
    runtimeEnvironmentTransportCallMock,
    hostPathStatMock,
    storeState
  } = doubles

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    clearRuntimeHostPathProbesForTests()
    vi.clearAllMocks()
    runtimeEnvironmentTransportCallMock.mockReset()
    hostPathStatMock.mockReset()
    hostPathStatMock.mockReturnValue(HOST_PATH_REFUSAL)
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) => {
        if (args.method === 'files.stat' && args.params && 'path' in args.params) {
          return hostPathStatMock(args)
        }
        return (
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
        )
      }
    )
    vi.mocked(getConnectionId).mockReturnValue(null)
    openFilePathMock.mockResolvedValue(true)
    storeState.settings = undefined
    storeState.activeFileIdByWorktree = {}
    storeState.openFiles = []
    storeState.worktreesByRepo = {}
    registerHttpLinkStoreAccessor(() => storeState)
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      api: {
        shell: {
          openUrl: openUrlMock,
          openFileUri: openFileUriMock,
          openFilePath: openFilePathMock,
          pathExists: vi.fn().mockResolvedValue(true)
        },
        fs: {
          pathExists: fsPathExistsMock,
          stat: statMock
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCallMock }
      }
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      return setTimeout(() => callback(0), 0) as unknown as number
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
      clearTimeout(handle)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
}

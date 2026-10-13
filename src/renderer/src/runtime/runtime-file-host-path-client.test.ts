import { beforeEach, describe, expect, it } from 'vitest'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../shared/runtime-file-contracts'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../shared/local-file-access'
import {
  downloadRuntimeFile,
  readRuntimeFileContent,
  readRuntimeFilePreview
} from './runtime-file-read-client'
import { writeRuntimeFile } from './runtime-file-mutation-client'
import { runtimePathExists, statRuntimePath } from './runtime-file-metadata-client'
import { readRuntimeFileRange, statRuntimeReadTarget } from './runtime-file-range-client'
import { runtimePathsExist } from './runtime-path-existence-batch'
import {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import {
  knownRuntimeEnvironmentServesFilesByPath,
  runtimeEnvironmentServesFilesByPath
} from './runtime-file-address'
import { createCompatibleRuntimeStatusResponse } from './runtime-compatibility-test-fixture'
import {
  fsAppendDownloadedFileChunk,
  fsFinishDownloadedFile,
  fsReadFile,
  fsStartDownloadedFile,
  fsStat,
  fsWriteFile,
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  type RuntimeRpcRequest
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const USER_FILE = { kind: 'user-file' } as const
// Neutral host path outside the workspace; which paths a host serves is the host's rule.
const HOST_FILE = '/home/me/state/ab12/report.md'

/** Hosts that advertise path addressing; every other environment is an older host. */
let pathServingHosts = new Set<string>()

function owner(environmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    target: { kind: 'environment' as const, environmentId },
    worktreeId: 'repo::/srv/repo',
    worktreePath: '/srv/repo',
    ...overrides
  }
}

function ok(result: unknown) {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

function fail(code: string, message: string) {
  return { id: 'rpc', ok: false, error: { code, message }, _meta: { runtimeId: 'remote-runtime' } }
}

function fileCalls(): RuntimeRpcRequest[] {
  return runtimeEnvironmentCall.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method !== 'status.get')
}

beforeEach(() => {
  pathServingHosts = new Set(['env-a', 'env-b'])
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeRpcRequest) => {
    if (args.method === 'status.get') {
      return Promise.resolve(
        ok({
          runtimeId: 'remote-runtime',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: [
            FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
            ...(pathServingHosts.has(args.selector ?? '')
              ? [FILES_HOST_PATH_RUNTIME_CAPABILITY]
              : [])
          ]
        })
      )
    }
    return runtimeEnvironmentCall(args)
  })
})

describe('a file outside the workspace on a host that serves paths', () => {
  it('reads, saves and stats it on its owner by absolute path with the user’s access', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeRpcRequest) =>
      method === 'files.read'
        ? ok({ path: HOST_FILE, content: '# report', truncated: false, byteLength: 8 })
        : method === 'files.stat'
          ? ok({ size: 8, isDirectory: false, mtime: 1 })
          : ok({})
    )

    const read = await readRuntimeFileContent({
      target: { kind: 'environment', environmentId: 'env-a' },
      filePath: HOST_FILE,
      relativePath: HOST_FILE,
      worktreeId: 'repo::/srv/repo',
      access: USER_FILE
    })
    await writeRuntimeFile(
      { ...owner('env-a'), expectedExecutionHostId: 'local' },
      HOST_FILE,
      '# edited',
      USER_FILE
    )
    const stat = await statRuntimePath(owner('env-a'), HOST_FILE, USER_FILE)

    expect(read).toEqual({ content: '# report', isBinary: false })
    expect(stat.isDirectory).toBe(false)
    expect(fileCalls()).toEqual([
      expect.objectContaining({
        selector: 'env-a',
        method: 'files.read',
        params: { path: HOST_FILE, access: USER_FILE }
      }),
      expect.objectContaining({
        selector: 'env-a',
        method: 'files.write',
        params: {
          path: HOST_FILE,
          access: USER_FILE,
          content: '# edited',
          expectedExecutionHostId: 'local'
        }
      }),
      expect.objectContaining({
        selector: 'env-a',
        method: 'files.stat',
        params: { path: HOST_FILE, access: USER_FILE }
      })
    ])
    // Never this computer's same-named file.
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(fsWriteFile).not.toHaveBeenCalled()
    expect(fsStat).not.toHaveBeenCalled()
  })

  it('keeps the same absolute path on two hosts on its own owner', async () => {
    runtimeEnvironmentCall.mockResolvedValue(ok({}))

    await writeRuntimeFile(owner('env-a'), HOST_FILE, 'from a', USER_FILE)
    await writeRuntimeFile(owner('env-b'), HOST_FILE, 'from b', USER_FILE)

    expect(fileCalls()).toEqual([
      expect.objectContaining({
        selector: 'env-a',
        params: expect.objectContaining({ path: HOST_FILE, content: 'from a' })
      }),
      expect.objectContaining({
        selector: 'env-b',
        params: expect.objectContaining({ path: HOST_FILE, content: 'from b' })
      })
    ])
  })

  it('sends a path a document references without the user’s access', async () => {
    runtimeEnvironmentCall.mockResolvedValue(
      ok({ content: 'iVBORw0K', isBinary: true, isImage: true, mimeType: 'image/png' })
    )

    await readRuntimeFilePreview(owner('env-a'), '/home/me/state/ab12/chart.png')

    expect(fileCalls()).toEqual([
      expect.objectContaining({
        method: 'files.readPreview',
        params: { path: '/home/me/state/ab12/chart.png' }
      })
    ])
  })

  it('falls back to the base64 preview by path for a binary file', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeRpcRequest) =>
      method === 'files.read'
        ? fail('runtime_error', 'binary_file')
        : ok({ content: 'JVBERi0=', isBinary: true, mimeType: 'application/pdf' })
    )

    const result = await readRuntimeFileContent({
      target: { kind: 'environment', environmentId: 'env-a' },
      filePath: '/home/me/state/ab12/out.pdf',
      relativePath: '/home/me/state/ab12/out.pdf',
      worktreeId: 'repo::/srv/repo',
      access: USER_FILE
    })

    expect(result.isBinary).toBe(true)
    expect(fileCalls().map((call) => [call.method, call.params])).toEqual([
      ['files.read', { path: '/home/me/state/ab12/out.pdf', access: USER_FILE }],
      ['files.readPreview', { path: '/home/me/state/ab12/out.pdf', access: USER_FILE }]
    ])
  })

  it('reads CSV metadata and chunks by path', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method }: RuntimeRpcRequest) =>
      method === 'files.stat'
        ? ok({ size: 3, isDirectory: false, mtime: 1 })
        : ok({ contentBase64: 'YWJj', bytesRead: 3, eof: true })
    )
    const args = {
      target: { kind: 'environment' as const, environmentId: 'env-a' },
      filePath: '/home/me/state/ab12/rows.csv',
      relativePath: '/home/me/state/ab12/rows.csv',
      worktreeId: 'repo::/srv/repo',
      access: USER_FILE
    }

    await statRuntimeReadTarget(args)
    expect(await readRuntimeFileRange(args, 0, 3)).toEqual(new Uint8Array([97, 98, 99]))

    expect(fileCalls().map((call) => [call.method, call.params])).toEqual([
      ['files.stat', { path: args.filePath, access: USER_FILE }],
      ['files.readChunk', { path: args.filePath, access: USER_FILE, offset: 0, length: 3 }]
    ])
  })

  it('downloads it in chunks by path', async () => {
    fsStartDownloadedFile.mockResolvedValue({ canceled: false, transferId: 't-1' })
    fsFinishDownloadedFile.mockResolvedValue({ canceled: false, destinationPath: '/dl/report.md' })
    runtimeEnvironmentCall.mockResolvedValue(ok({ contentBase64: 'YWJj', bytesRead: 3, eof: true }))

    const result = await downloadRuntimeFile(owner('env-a'), HOST_FILE, 'report.md', USER_FILE)

    expect(result).toEqual({ canceled: false, destinationPath: '/dl/report.md' })
    expect(fsAppendDownloadedFileChunk).toHaveBeenCalledWith({
      transferId: 't-1',
      contentBase64: 'YWJj'
    })
    const calls = fileCalls()
    expect(calls).toEqual(
      calls.map(() =>
        expect.objectContaining({ params: expect.objectContaining({ path: HOST_FILE }) })
      )
    )
  })

  it('answers existence by path: missing is false, mixed batches ask each path', async () => {
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }: RuntimeRpcRequest) => {
      if (method === 'files.pathsExist') {
        return ok([{ exists: true }])
      }
      return typeof params === 'object' &&
        params !== null &&
        'path' in params &&
        params.path === HOST_FILE
        ? ok({ size: 1, isDirectory: false, mtime: 1 })
        : fail('runtime_error', 'ENOENT: no such file or directory')
    })

    expect(await runtimePathExists(owner('env-a'), '/home/me/state/ab12/gone.md')).toBe(false)
    expect(
      await runtimePathsExist(owner('env-a'), [HOST_FILE, '/home/me/state/ab12/gone.md'])
    ).toEqual([{ exists: true }, { exists: false }])
  })

  it('addresses a Windows host path verbatim', async () => {
    const windowsFile = 'C:\\Users\\me\\AppData\\Roaming\\orca\\ab12\\report.md'
    runtimeEnvironmentCall.mockResolvedValue(ok({}))

    await writeRuntimeFile(
      owner('env-a', { worktreeId: 'repo::C:/repo', worktreePath: 'C:\\repo' }),
      windowsFile,
      'x',
      USER_FILE
    )
    await writeRuntimeFile(
      owner('env-a', { worktreeId: 'repo::C:/repo', worktreePath: 'C:\\repo' }),
      'C:\\repo\\src\\a.ts',
      'y'
    )

    expect(fileCalls().map((call) => call.params)).toEqual([
      expect.objectContaining({ path: windowsFile, content: 'x' }),
      expect.objectContaining({ worktree: 'id:repo::C:/repo', relativePath: 'src/a.ts' })
    ])
  })

  it('serves a folder workspace’s outside file by path and its own files by relative path', async () => {
    runtimeEnvironmentCall.mockResolvedValue(ok({ size: 1, isDirectory: false, mtime: 1 }))
    const folder = owner('env-a', { worktreeId: 'folder:fw-1', worktreePath: '/home/me/notes' })

    await statRuntimePath(folder, HOST_FILE)
    await statRuntimePath(folder, '/home/me/notes/today.md')

    expect(fileCalls().map((call) => call.params)).toEqual([
      { path: HOST_FILE },
      { worktree: 'id:folder:fw-1', relativePath: 'today.md' }
    ])
  })
})

describe('what stays as it was', () => {
  it('refuses on an older host without asking it or reading this computer', async () => {
    pathServingHosts = new Set()

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment', environmentId: 'env-a' },
        filePath: HOST_FILE,
        relativePath: HOST_FILE,
        worktreeId: 'repo::/srv/repo',
        access: USER_FILE
      })
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')
    await expect(writeRuntimeFile(owner('env-a'), HOST_FILE, 'x', USER_FILE)).rejects.toThrow(
      'Remote file is outside the owning runtime worktree'
    )
    await expect(statRuntimePath(owner('env-a'), HOST_FILE)).rejects.toThrow(
      'Remote file is outside the owning runtime worktree'
    )

    expect(fileCalls()).toEqual([])
    expect(fsReadFile).not.toHaveBeenCalled()
    expect(fsWriteFile).not.toHaveBeenCalled()
    expect(fsStat).not.toHaveBeenCalled()
  })

  it('asks an older host its status at most once per status lifetime, and keeps it cached', async () => {
    pathServingHosts = new Set()
    const statusCalls = () =>
      runtimeEnvironmentTransportCall.mock.calls.filter(
        ([request]) => request.method === 'status.get'
      )

    for (let index = 0; index < 5; index += 1) {
      await expect(statRuntimePath(owner('env-a'), `/tmp/out-${index}.log`)).rejects.toThrow(
        'Remote file is outside the owning runtime worktree'
      )
      await expect(writeRuntimeFile(owner('env-a'), HOST_FILE, 'x', USER_FILE)).rejects.toThrow(
        'Remote file is outside the owning runtime worktree'
      )
    }
    // Other capability checks still read the cached status instead of re-asking.
    expect(
      await runtimeEnvironmentSupportsCapability(
        'env-a',
        FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY
      )
    ).toBe(true)

    expect(statusCalls()).toHaveLength(1)
    expect(fileCalls()).toEqual([])
  })

  it.each([
    ['a connection check', () => clearRuntimeCompatibilityCache('env-a')],
    [
      'a replaced runtime',
      () => {
        const replacement = createCompatibleRuntimeStatusResponse('replacement-runtime')
        if (replacement.ok) {
          clearRecentRuntimeCompatibilityFailure('env-a', replacement.result)
        }
      }
    ]
  ])('drops the answer with the shared status on %s', async (_label, reset) => {
    pathServingHosts = new Set()
    expect(await runtimeEnvironmentServesFilesByPath('env-a')).toBe(false)
    // The status was cached by the first answer, so this re-reads it without asking.
    expect(knownRuntimeEnvironmentServesFilesByPath('env-a')).toBe(false)
    pathServingHosts = new Set(['env-a'])

    reset()

    expect(knownRuntimeEnvironmentServesFilesByPath('env-a')).toBeUndefined()
    expect(await runtimeEnvironmentServesFilesByPath('env-a')).toBe(true)
  })

  it('does not re-ask an unreachable host within a minute', async () => {
    runtimeEnvironmentTransportCall.mockRejectedValue(new Error('socket closed'))

    for (let index = 0; index < 5; index += 1) {
      expect(await runtimeEnvironmentServesFilesByPath('env-a')).toBe(false)
    }

    expect(runtimeEnvironmentTransportCall).toHaveBeenCalledTimes(1)
  })

  it('shows the host’s refusal for a path it does not serve, never this computer’s file', async () => {
    runtimeEnvironmentCall.mockResolvedValue(
      fail('runtime_error', PATH_OUTSIDE_ALLOWED_DIRECTORIES)
    )

    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment', environmentId: 'env-a' },
        filePath: '/etc/hosts',
        relativePath: '/etc/hosts',
        worktreeId: 'repo::/srv/repo',
        access: USER_FILE
      })
    ).rejects.toThrow(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('never names a path to a host that proxies an SSH workspace', async () => {
    await expect(
      writeRuntimeFile(
        { ...owner('env-a'), expectedExecutionHostId: 'ssh:box' },
        HOST_FILE,
        'x',
        USER_FILE
      )
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')
    await expect(
      readRuntimeFileContent({
        target: { kind: 'environment', environmentId: 'env-a' },
        filePath: HOST_FILE,
        relativePath: HOST_FILE,
        worktreeId: 'repo::/srv/repo',
        connectionId: 'box'
      })
    ).rejects.toThrow('Remote file is outside the owning runtime worktree')

    expect(fileCalls()).toEqual([])
  })

  it('keeps workspace files on the relative-path form', async () => {
    runtimeEnvironmentCall.mockResolvedValue(ok({ content: 'x', truncated: false, byteLength: 1 }))

    await readRuntimeFileContent({
      target: { kind: 'environment', environmentId: 'env-a' },
      filePath: '/srv/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: 'repo::/srv/repo',
      access: USER_FILE
    })

    expect(fileCalls().map((call) => call.params)).toEqual([
      { worktree: 'id:repo::/srv/repo', relativePath: 'a.ts' }
    ])
  })
})

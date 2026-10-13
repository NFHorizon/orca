import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

import {
  clearNativeChatVisualFileCacheForTests,
  markNativeChatVisualReads,
  peekNativeChatVisualFile,
  readNativeChatVisualFile,
  type NativeChatVisualFile
} from './native-chat-visual-path-read-client'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../../shared/local-file-access'

const readFile = vi.fn()
const CHAT_A = '/state/chat-scratch/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CHAT_B = '/state/chat-scratch/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const local = (path: string): NativeChatVisualFile => ({ target: { kind: 'local' }, path })
const onHost = (environmentId: string, path: string): NativeChatVisualFile => ({
  target: { kind: 'environment', environmentId },
  path
})
const hostRead = (content: string) => ({ path: 'p', content, truncated: false, byteLength: 1 })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

beforeEach(() => {
  clearNativeChatVisualFileCacheForTests()
  callRuntimeRpc.mockReset()
  readFile.mockReset()
  vi.stubGlobal('window', { api: { fs: { readFile } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readNativeChatVisualFile', () => {
  it("reads a local chat's visual through this computer with the chat-visual kind", async () => {
    readFile.mockResolvedValueOnce({ content: '<p>a</p>', isBinary: false })
    const file = local(`${CHAT_A}/usage.html`)
    expect(await readNativeChatVisualFile(file)).toEqual({ ok: true, page: { html: '<p>a</p>' } })
    expect(readFile).toHaveBeenCalledWith({
      filePath: `${CHAT_A}/usage.html`,
      access: { kind: 'chat-visual' }
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['a paired host', 'env-paired', `${CHAT_A}/usage.html`],
    [
      'a managed SSH host on Windows',
      'env-ssh',
      'C:\\Users\\me\\AppData\\Roaming\\orca\\chat-scratch\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\usage.html'
    ]
  ])(
    "reads a visual on %s by its host path, never from this computer's disk",
    async (_, env, path) => {
      callRuntimeRpc.mockResolvedValueOnce(hostRead('<p>h</p>'))
      expect(await readNativeChatVisualFile(onHost(env, path))).toEqual({
        ok: true,
        page: { html: '<p>h</p>' }
      })
      expect(callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: env },
        'files.read',
        { path, access: { kind: 'chat-visual' } },
        { timeoutMs: 15_000 }
      )
      expect(readFile).not.toHaveBeenCalled()
    }
  )

  it('keeps the same file name in two chats, and the same path on two hosts, apart', async () => {
    readFile.mockImplementation(({ filePath }: { filePath: string }) =>
      Promise.resolve({ content: filePath, isBinary: false })
    )
    callRuntimeRpc.mockImplementation((target: { environmentId: string }) =>
      Promise.resolve(hostRead(target.environmentId))
    )
    const files = [
      local(`${CHAT_A}/v.html`),
      local(`${CHAT_B}/v.html`),
      onHost('env-1', `${CHAT_A}/v.html`),
      onHost('env-2', `${CHAT_A}/v.html`)
    ]
    for (const file of files) {
      await readNativeChatVisualFile(file)
    }
    expect(files.map((file) => peekNativeChatVisualFile(file)?.html)).toEqual([
      `${CHAT_A}/v.html`,
      `${CHAT_B}/v.html`,
      'env-1',
      'env-2'
    ])
  })

  it('shares one read between visuals of the same file asking at once', async () => {
    const pending = deferred<{ content: string; isBinary: boolean }>()
    readFile.mockReturnValueOnce(pending.promise)
    const file = local(`${CHAT_A}/v.html`)
    const first = readNativeChatVisualFile(file)
    const second = readNativeChatVisualFile(file)
    pending.resolve({ content: 'x', isBinary: false })
    expect(await first).toEqual(await second)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('a fresh read never joins one begun before its mark, and shares one begun after', async () => {
    const stale = deferred<{ content: string; isBinary: boolean }>()
    readFile
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ content: 'new', isBinary: false })
    const file = local(`${CHAT_A}/v.html`)
    const before = readNativeChatVisualFile(file)
    const mark = markNativeChatVisualReads()
    const fresh = readNativeChatVisualFile(file, { startedAfter: mark })
    const joined = readNativeChatVisualFile(file, { startedAfter: mark })
    expect(await fresh).toEqual({ ok: true, page: { html: 'new' } })
    expect(await joined).toEqual(await fresh)
    expect(readFile).toHaveBeenCalledTimes(2)
    // The older read lands last; the cache keeps the newer page.
    stale.resolve({ content: 'old', isBinary: false })
    expect(await before).toEqual({ ok: true, page: { html: 'old' } })
    expect(peekNativeChatVisualFile(file)?.html).toBe('new')
  })

  it.each([
    ['ENOENT: no such file or directory', 'not_found'],
    [`${PATH_OUTSIDE_ALLOWED_DIRECTORIES}. If this blocks a legitimate workflow, ...`, 'refused'],
    ['Not a regular file', 'refused'],
    ['file_too_large', 'refused'],
    ['binary_file', 'refused'],
    ['socket hang up', 'unavailable']
  ])('reads "%s" as %s', async (message, reason) => {
    callRuntimeRpc.mockRejectedValueOnce(new Error(message))
    expect(await readNativeChatVisualFile(onHost('env-1', `${CHAT_A}/v.html`))).toEqual({
      ok: false,
      reason
    })
  })

  it('refuses a binary local file and a cut-off host read', async () => {
    readFile.mockResolvedValueOnce({ content: '', isBinary: true })
    callRuntimeRpc.mockResolvedValueOnce({ ...hostRead('<p'), truncated: true })
    expect(await readNativeChatVisualFile(local(`${CHAT_A}/v.html`))).toEqual({
      ok: false,
      reason: 'refused'
    })
    expect(await readNativeChatVisualFile(onHost('env-1', `${CHAT_A}/v.html`))).toEqual({
      ok: false,
      reason: 'refused'
    })
  })

  it('keeps the cached page when the host is out of reach, and drops it on a verdict', async () => {
    const file = onHost('env-1', `${CHAT_A}/v.html`)
    callRuntimeRpc.mockResolvedValueOnce(hostRead('<p>kept</p>'))
    await readNativeChatVisualFile(file)
    callRuntimeRpc.mockRejectedValueOnce(new Error('timeout'))
    await readNativeChatVisualFile(file)
    expect(peekNativeChatVisualFile(file)?.html).toBe('<p>kept</p>')
    callRuntimeRpc.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'))
    await readNativeChatVisualFile(file)
    expect(peekNativeChatVisualFile(file)).toBeNull()
  })
})

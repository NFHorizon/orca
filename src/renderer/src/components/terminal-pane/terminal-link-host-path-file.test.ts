import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../../shared/runtime-file-contracts'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  statMock,
  openFileMock,
  createBrowserTabMock,
  hostPathStatMock,
  runtimeEnvironmentCallMock,
  runtimeEnvironmentTransportCallMock
} = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('./terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: vi.fn()
}))

installTerminalLinkTestEnvironment(doubles)
// The document preview looks for a tab already showing the page before it opens one.
Object.assign(storeState, { browserTabsByWorktree: {} })

const serverWorkspace = {
  worktreeId: 'wt-feat',
  worktreePath: '/srv/repo',
  runtimeEnvironmentId: 'env-1'
}
// Neutral host path outside every workspace; which paths a host serves is its own rule.
const HOST_FILE = '/home/me/state/ab12/report.md'

function hostHasNoWorkspaceFor(path: string, extra: Record<string, unknown> = {}): void {
  runtimeEnvironmentCallMock.mockResolvedValue({
    id: 'rpc-1',
    ok: true,
    result: {
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: path,
      exists: false,
      isDirectory: false,
      ...extra
    },
    _meta: { runtimeId: 'remote-runtime' }
  })
}

function hostServesByPath(isDirectory = false): void {
  hostPathStatMock.mockReturnValue({
    id: 'rpc-stat',
    ok: true,
    result: { size: 8, isDirectory, mtime: 1 },
    _meta: { runtimeId: 'remote-runtime' }
  })
}

function hostIsOlder(): void {
  runtimeEnvironmentTransportCallMock.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
    if (!status?.ok) {
      return runtimeEnvironmentCallMock(args)
    }
    const capabilities = status.result.capabilities?.filter(
      (capability) => capability !== FILES_HOST_PATH_RUNTIME_CAPABILITY
    )
    return { ...status, result: { ...status.result, capabilities } }
  })
}

const grant = {
  openTarget: {
    kind: 'absolute-file',
    provider: 'local',
    absolutePath: HOST_FILE,
    grantId: 'g-1'
  }
}

describe('a link to a file its paired or SSH host serves by path', () => {
  it('opens it editable, owned by that host and named by its absolute path', async () => {
    hostHasNoWorkspaceFor(HOST_FILE)
    hostServesByPath()

    openDetectedFilePath(HOST_FILE, null, null, serverWorkspace)
    await flushDoubleRaf()

    expect(hostPathStatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'files.stat',
        params: { path: HOST_FILE, access: { kind: 'user-file' } }
      })
    )
    expect(openFileMock).toHaveBeenCalledTimes(1)
    const opened = openFileMock.mock.calls[0]![0]
    expect(opened).toMatchObject({
      filePath: HOST_FILE,
      relativePath: HOST_FILE,
      worktreeId: 'wt-feat',
      runtimeEnvironmentId: 'env-1',
      mode: 'edit'
    })
    expect(opened).not.toHaveProperty('readOnly')
    expect(opened).not.toHaveProperty('terminalArtifactGrantId')
    // Never this computer's same-named file.
    expect(statMock).not.toHaveBeenCalled()
  })

  it('prefers the editable host file over a read-only grant the terminal also earned', async () => {
    hostHasNoWorkspaceFor(HOST_FILE, grant)
    hostServesByPath()

    openDetectedFilePath(HOST_FILE, null, null, { ...serverWorkspace, terminalHandle: 'term-1' })
    await flushDoubleRaf()

    const opened = openFileMock.mock.calls[0]![0]
    expect(opened).not.toHaveProperty('readOnly')
    expect(opened).not.toHaveProperty('terminalArtifactGrantId')
  })

  it('renders an HTML file in the document preview, read from its host', async () => {
    const page = '/home/me/state/ab12/chart.html'
    hostHasNoWorkspaceFor(page)
    hostServesByPath()

    openDetectedFilePath(page, null, null, serverWorkspace)
    await flushDoubleRaf()

    expect(createBrowserTabMock).toHaveBeenCalledTimes(1)
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-feat',
      expect.any(String),
      expect.objectContaining({
        docLocation: { kind: 'workspace-doc', worktreeId: 'wt-feat', filePath: page },
        // The preview mints its own grant on the host; it never becomes a file:// page here.
        browserRuntimeEnvironmentId: null
      })
    )
    expect(openFileMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  })

  it('keeps opening the source of an HTML file its host does not serve by path', async () => {
    const page = '/etc/site/index.html'
    hostHasNoWorkspaceFor(page, { openTarget: { ...grant.openTarget, absolutePath: page } })

    openDetectedFilePath(page, null, null, { ...serverWorkspace, terminalHandle: 'term-1' })
    await flushDoubleRaf()

    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: page, readOnly: true, terminalArtifactGrantId: 'g-1' }),
      { forceContentReload: true }
    )
  })

  it('downloads a Shift-clicked file from its host', async () => {
    hostHasNoWorkspaceFor(HOST_FILE)
    hostServesByPath()

    openDetectedFilePath(HOST_FILE, null, null, {
      ...serverWorkspace,
      openWithSystemDefault: true
    })
    await flushDoubleRaf()

    expect(downloadAndOpenRemoteTerminalFile).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'env-1' } }),
      HOST_FILE
    )
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('opens nothing for a directory', async () => {
    hostHasNoWorkspaceFor('/home/me/state/ab12')
    hostServesByPath(true)

    openDetectedFilePath('/home/me/state/ab12', null, null, serverWorkspace)
    await flushDoubleRaf()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  })

  it('links the path in the terminal that printed it', async () => {
    hostHasNoWorkspaceFor(HOST_FILE)
    hostServesByPath()
    const { provider } = createProviderSetup([makeBufferLine(HOST_FILE)], new Map(), {
      worktreePath: '/srv/repo',
      startupCwd: '/srv/repo',
      runtimeEnvironmentId: 'env-1',
      getRuntimeTerminalHandleForPane: () => 'term-1'
    })

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (found) => resolve(found ?? []))
    })

    expect(links.map((link) => link.text)).toEqual([HOST_FILE])
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
  })
})

describe('a link its host does not serve by path stays as it was', () => {
  it('keeps the read-only grant on an older host, without asking it by path', async () => {
    hostIsOlder()
    hostHasNoWorkspaceFor(HOST_FILE, grant)

    openDetectedFilePath(HOST_FILE, null, null, { ...serverWorkspace, terminalHandle: 'term-1' })
    await flushDoubleRaf()

    expect(hostPathStatMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, terminalArtifactGrantId: 'g-1' }),
      { forceContentReload: true }
    )
  })

  it('keeps the grant for a path the host refuses to serve', async () => {
    hostHasNoWorkspaceFor('/etc/hosts', {
      openTarget: { ...grant.openTarget, absolutePath: '/etc/hosts' }
    })

    openDetectedFilePath('/etc/hosts', null, null, { ...serverWorkspace, terminalHandle: 'term-1' })
    await flushDoubleRaf()

    expect(hostPathStatMock).toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true, terminalArtifactGrantId: 'g-1' }),
      { forceContentReload: true }
    )
  })

  it('falls back to this computer only when the host has no such file', async () => {
    hostHasNoWorkspaceFor('/Users/me/notes.md')
    hostPathStatMock.mockReturnValue({
      id: 'rpc-stat',
      ok: false,
      error: { code: 'runtime_error', message: 'ENOENT: no such file or directory' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    openDetectedFilePath('/Users/me/notes.md', null, null, serverWorkspace)
    await flushDoubleRaf()

    expect(statMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/Users/me/notes.md', access: { kind: 'user-file' } })
    )
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEnvironmentId: null, readOnly: true }),
      { forceContentReload: true }
    )
  })

  it('reports an unverifiable open when the host cannot answer by path', async () => {
    hostHasNoWorkspaceFor(HOST_FILE)
    hostPathStatMock.mockRejectedValue(new Error('socket closed'))
    const onOpenFailure = vi.fn()

    openDetectedFilePath(HOST_FILE, null, null, { ...serverWorkspace, onOpenFailure })
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unverifiable' }))
  })
})

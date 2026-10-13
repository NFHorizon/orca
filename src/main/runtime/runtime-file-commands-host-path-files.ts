import { isAbsolute, sep } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult,
  RuntimeFileStatResult,
  RuntimeHostPathFileReadResult
} from '../../shared/runtime-file-contracts'
import type { LocalFileAccess } from '../../shared/local-file-access'
import { PATH_ACCESS_DENIED_MESSAGE } from '../ipc/filesystem-auth'
import { readLocalFileRange } from '../ipc/filesystem/local-file-range-read'
import {
  resolveLocalRequestPathInScope,
  type LocalRequestOperation
} from '../ipc/local-file-access-resolution'
import { HOST_PATH_TARGET_ROOT_SCOPE } from '../ipc/local-file-root-scope'
import type { LocalFilesystemProvider } from '../providers/local-filesystem-provider'
import type { Store } from '../persistence'
import { toRuntimeFileStatResult } from './runtime-file-command-access'
import { isMobileBinaryPath } from './runtime-file-command-host'
import { requireLocalRuntimeFileRoute } from './runtime-file-command-target'
import { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } from './runtime-file-commands-create-file-explorer-dir-no-clobber'
import { assertRuntimeFileMutationExpectation } from './runtime-file-commands-mobile-file-list-limit'
import { truncateMobileFilePreview } from './runtime-file-commands-terminal-artifact-access'
import { readAuthorizedFilePreview } from './runtime-file-commands-read-file-explorer-preview'
import { readAuthorizedLocalMobileFile } from './runtime-file-commands-terminal-file-paths'

/** A file on this host named by its absolute path; `access` is what the client declares. */
export type HostPathFileTarget = { path: string; access?: LocalFileAccess }

const THIS_HOST = { executionHostId: LOCAL_EXECUTION_HOST_ID } as const

// Why not isAbsolute alone: on Windows `\dir\file` is absolute to whichever drive is current.
function isHostNativeAbsolutePath(path: string): boolean {
  return isAbsolute(path) && (sep === '/' || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path))
}

/** This host's authorization of a host-path request; its rule lives in the scope. */
export function resolveHostPathTarget(
  target: HostPathFileTarget,
  store: Store,
  operation: LocalRequestOperation
): Promise<string> {
  if (!isHostNativeAbsolutePath(target.path)) {
    return Promise.reject(new Error(PATH_ACCESS_DENIED_MESSAGE))
  }
  return resolveLocalRequestPathInScope(
    target.path,
    target.access,
    store,
    operation,
    HOST_PATH_TARGET_ROOT_SCOPE
  )
}

export class RuntimeFileCommandsWithHostPathFiles extends RuntimeFileCommandsWithCreateFileExplorerDirNoClobber {
  async readHostPathFile(target: HostPathFileTarget): Promise<RuntimeHostPathFileReadResult> {
    const store = this.host.requireStore()
    if (isMobileBinaryPath(target.path)) {
      throw new Error('binary_file')
    }
    const content = await readAuthorizedLocalMobileFile(
      await resolveHostPathTarget(target, store, 'read')
    )
    const truncated = truncateMobileFilePreview(content)
    return {
      path: target.path,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  async readHostPathFilePreview(
    target: HostPathFileTarget,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    return readAuthorizedFilePreview(
      await resolveHostPathTarget(target, this.host.requireStore(), 'read'),
      maxContentBytes
    )
  }

  async readHostPathFileChunk(
    target: HostPathFileTarget,
    offset: number,
    length: number
  ): Promise<RuntimeFileReadChunkResult> {
    return readLocalFileRange(
      await resolveHostPathTarget(target, this.host.requireStore(), 'read'),
      offset,
      length
    )
  }

  async statHostPathFile(target: HostPathFileTarget): Promise<RuntimeFileStatResult> {
    return toRuntimeFileStatResult(
      await this.hostPathFileProvider(target, 'read').stat(target.path)
    )
  }

  async writeHostPathFile(
    target: HostPathFileTarget,
    content: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    assertRuntimeFileMutationExpectation(
      THIS_HOST.executionHostId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    await this.hostPathFileProvider(target, 'write').writeFile(target.path, content)
    return { ok: true }
  }

  // Why the ordinary provider: its stat and write semantics stay the workspace form's; only the
  // authorization differs.
  private hostPathFileProvider(
    target: HostPathFileTarget,
    operation: LocalRequestOperation
  ): LocalFilesystemProvider {
    return requireLocalRuntimeFileRoute(THIS_HOST).createProvider({
      requireStore: () => this.host.requireStore(),
      resolveAuthorizedPath: (path, store) =>
        resolveHostPathTarget({ path, access: target.access }, store, operation)
    })
  }
}

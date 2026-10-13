import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult,
  RuntimeFileStatResult,
  RuntimeHostPathFileReadResult
} from '../../shared/runtime-file-contracts'
import { readLocalFileRange } from '../ipc/filesystem/local-file-range-read'
import type { LocalRequestOperation } from '../ipc/local-file-access-resolution'
import type { LocalFilesystemProvider } from '../providers/local-filesystem-provider'
import { toRuntimeFileStatResult } from './runtime-file-command-access'
import { isMobileBinaryPath } from './runtime-file-command-host'
import { requireLocalRuntimeFileRoute } from './runtime-file-command-target'
import { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } from './runtime-file-commands-create-file-explorer-dir-no-clobber'
import { assertRuntimeFileMutationExpectation } from './runtime-file-commands-mobile-file-list-limit'
import { truncateMobileFilePreview } from './runtime-file-commands-terminal-artifact-access'
import { readAuthorizedFilePreview } from './runtime-file-commands-read-file-explorer-preview'
import { readAuthorizedLocalMobileFile } from './runtime-file-commands-terminal-file-paths'
import { resolveHostPathTarget, type HostPathFileTarget } from './runtime-host-path-target'

const THIS_HOST = { executionHostId: LOCAL_EXECUTION_HOST_ID } as const

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

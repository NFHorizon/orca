import {
  readAuthorizedDocPreviewFile,
  type DocPreviewFileAccessResult
} from '../../shared/doc-preview-file-access'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult,
  RuntimeFileStatResult,
  RuntimeHostPathFileReadResult
} from '../../shared/runtime-file-contracts'
import { readLocalFileRange } from '../ipc/filesystem/local-file-range-read'
import { readChatVisualAccessFile } from '../native-chat/native-chat-visual-access-read'
import type { LocalRequestOperation } from '../ipc/local-file-access-resolution'
import type { LocalFilesystemProvider } from '../providers/local-filesystem-provider'
import { toRuntimeFileStatResult } from './runtime-file-command-access'
import { isMobileBinaryPath } from './runtime-file-command-host'
import { requireLocalRuntimeFileRoute } from './runtime-file-command-target'
import { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } from './runtime-file-commands-create-file-explorer-dir-no-clobber'
import {
  assertPreviewWithinTransportBudget,
  assertRuntimeFileMutationExpectation
} from './runtime-file-commands-mobile-file-list-limit'
import { truncateMobileFilePreview } from './runtime-file-commands-terminal-artifact-access'
import {
  docPreviewReadLimits,
  readAuthorizedFilePreview
} from './runtime-file-commands-read-file-explorer-preview'
import { readAuthorizedLocalMobileFile } from './runtime-file-commands-terminal-file-paths'
import { resolveHostPathTarget, type HostPathFileTarget } from './runtime-host-path-target'

const THIS_HOST = { executionHostId: LOCAL_EXECUTION_HOST_ID } as const

/** A document preview's read of `path`, with the authority its preview holds, all host paths. */
export type HostPathDocPreviewTarget = HostPathFileTarget & {
  boundaryPath: string
  entryPath: string
  implicitRootPath: string | null
  authorizedRootPaths: readonly string[]
}

export class RuntimeFileCommandsWithHostPathFiles extends RuntimeFileCommandsWithCreateFileExplorerDirNoClobber {
  async readHostPathFile(target: HostPathFileTarget): Promise<RuntimeHostPathFileReadResult> {
    // Why before every root check: a chat visual is read from this host's scratch root only.
    if (target.access?.kind === 'chat-visual') {
      const content = await readChatVisualAccessFile(target.path)
      return {
        path: target.path,
        content,
        truncated: false,
        byteLength: Buffer.byteLength(content, 'utf8')
      }
    }
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

  async readHostPathDocPreviewFile(
    target: HostPathDocPreviewTarget,
    maxContentBytes?: number
  ): Promise<DocPreviewFileAccessResult> {
    const store = this.host.requireStore()
    // Why every path and not the file alone: each names this host's disk, so each must be one it
    // serves by path. The reader then confines the file to the entry or an approved directory.
    const authorize = (path: string): Promise<string> =>
      resolveHostPathTarget({ path, access: target.access }, store, 'read')
    const [boundaryPath, entryPath, targetPath, implicitRootPath, authorizedRootPaths] =
      await Promise.all([
        authorize(target.boundaryPath),
        authorize(target.entryPath),
        authorize(target.path),
        target.implicitRootPath === null ? null : authorize(target.implicitRootPath),
        Promise.all(target.authorizedRootPaths.map(authorize))
      ])
    return assertPreviewWithinTransportBudget(
      await readAuthorizedDocPreviewFile({
        boundaryPath,
        entryPath,
        implicitRootPath,
        authorizedRootPaths,
        targetPath,
        ...docPreviewReadLimits(maxContentBytes)
      }),
      maxContentBytes
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

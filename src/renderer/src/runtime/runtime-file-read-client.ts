import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult,
  RuntimeFileReadResult
} from '../../../shared/runtime-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import type {
  RuntimeFileDownloadResult,
  RuntimeFileOperationArgs,
  RuntimeFileReadArgs,
  RuntimeReadableFileContent
} from './runtime-file-client-types'
import { assertExternalSshReadOwnership, hasRemoteRuntimeOwner } from './runtime-file-routing'
import {
  getRuntimeWorkspaceFileAddress,
  getRuntimeWorkspaceReadAddress,
  mayAddressByHostPath,
  resolveRuntimeHostPathAddress,
  type RuntimeFileAddress
} from './runtime-file-address'
import { isAgentSessionAttachmentStorePath } from '../../../shared/agent-session-attachments'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import { readRuntimeTerminalArtifactContent } from './runtime-terminal-artifact-read'

const REMOTE_DOWNLOAD_CHUNK_BYTES = 384 * 1024
const REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE =
  'Remote file download requires a newer Orca server. Update the headless server and try again.'

// Why local only: an SSH read is the remote host's to check, and its relay never sees this field.
export function localAccess(
  connectionId: string | undefined,
  access: LocalFileAccess | undefined
): { access?: LocalFileAccess } {
  return access && !connectionId ? { access } : {}
}

export async function readRuntimeFileContent({
  target,
  filePath,
  relativePath,
  worktreeId,
  connectionId,
  expectedExternalSshTargetId,
  includeLocalLogMetadata,
  access,
  terminalArtifactGrantId
}: RuntimeFileReadArgs): Promise<RuntimeReadableFileContent> {
  assertExternalSshReadOwnership(target, connectionId, expectedExternalSshTargetId)
  if (target.kind !== 'environment' || !worktreeId) {
    return window.api.fs.readFile({
      filePath,
      connectionId,
      includeLocalLogMetadata,
      ...localAccess(connectionId, access)
    })
  }
  if (terminalArtifactGrantId) {
    return readRuntimeTerminalArtifactContent({
      target,
      worktreeId,
      absolutePath: filePath,
      grantId: terminalArtifactGrantId
    })
  }
  const address =
    getRuntimeWorkspaceReadAddress({ target, filePath, relativePath, worktreeId }) ??
    (await resolveRuntimeHostPathAddress({ target, worktreeId, connectionId }, filePath, access))
  if (!address) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }

  let result: RuntimeFileReadResult
  try {
    result = await callRuntimeRpc<RuntimeFileReadResult>(
      address.target,
      'files.read',
      address.params,
      { timeoutMs: 15_000 }
    )
  } catch (err) {
    // Why: files.read rejects binary paths with the typed 'binary_file' error; fall
    // back to the base64 preview RPC so PDFs/images render like local/SSH paths.
    // Match the exact typed error so an unrelated failure can't spoof the fallback.
    if (err instanceof RuntimeRpcCallError && err.message === 'binary_file') {
      return callRuntimeRpc<RuntimeFilePreviewResult>(
        address.target,
        'files.readPreview',
        address.params,
        { timeoutMs: 15_000 }
      )
    }
    throw err
  }
  if (result.truncated) {
    // Why: the runtime file RPC is preview-sized today; treating a truncated
    // payload as editable content would make saves overwrite the rest of the file.
    throw new Error(`Remote file is too large to open in the editor (${result.byteLength} bytes)`)
  }
  return { content: result.content, isBinary: false }
}

export async function readRuntimeFilePreview(
  context: RuntimeFileOperationArgs,
  filePath: string,
  access?: LocalFileAccess
): Promise<RuntimeFilePreviewResult> {
  assertExternalSshReadOwnership(
    context.target,
    context.connectionId,
    context.expectedExternalSshTargetId
  )
  const runtimeTarget = context.target
  const workspaceAddress = getRuntimeWorkspaceFileAddress(context, filePath)
  // A chat attachment lives in the paired server's store, outside every worktree; that server
  // reads it back itself (an older one answers method_not_found, and the preview falls back).
  if (
    !workspaceAddress &&
    runtimeTarget.kind === 'environment' &&
    isAgentSessionAttachmentStorePath(filePath)
  ) {
    return callRuntimeRpc<RuntimeFilePreviewResult>(
      runtimeTarget,
      'agentSessionAttachment.read',
      { path: filePath },
      { timeoutMs: 15_000 }
    )
  }
  const address =
    workspaceAddress ??
    (mayAddressByHostPath(context, filePath)
      ? await resolveRuntimeHostPathAddress(context, filePath, access)
      : null)
  if (!address) {
    if (hasRemoteRuntimeOwner(context)) {
      throw new Error('Remote file is outside the owning runtime worktree')
    }
    return window.api.fs.readFile({
      filePath,
      connectionId: context.connectionId,
      ...localAccess(context.connectionId, access)
    })
  }
  return callRuntimeRpc<RuntimeFilePreviewResult>(
    address.target,
    'files.readPreview',
    address.params,
    { timeoutMs: 15_000 }
  )
}

export async function downloadRuntimeFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  suggestedName: string,
  access?: LocalFileAccess
): Promise<RuntimeFileDownloadResult> {
  assertExternalSshReadOwnership(
    context.target,
    context.connectionId,
    context.expectedExternalSshTargetId
  )
  const address =
    getRuntimeWorkspaceFileAddress(context, filePath) ??
    (mayAddressByHostPath(context, filePath)
      ? await resolveRuntimeHostPathAddress(context, filePath, access)
      : null)
  if (!address) {
    if (hasRemoteRuntimeOwner(context)) {
      throw new Error('Remote file is outside the owning runtime worktree')
    }
    if (context.connectionId) {
      return window.api.fs.downloadFile({ filePath, connectionId: context.connectionId })
    }
    const result = await readRuntimeFilePreview(context, filePath)
    return window.api.fs.saveDownloadedFile({
      suggestedName,
      content: result.content,
      encoding: result.isBinary ? 'base64' : 'utf8'
    })
  }

  if (!(await remoteChunkedDownloadAvailable(address))) {
    return downloadRemoteFileViaPreview(address, suggestedName)
  }

  const download = await window.api.fs.startDownloadedFile({ suggestedName })
  if (download.canceled) {
    return download
  }

  let finished = false
  try {
    let offset = 0
    for (;;) {
      const chunk = await readRemoteDownloadChunk(address, offset)
      if (chunk.bytesRead > 0) {
        await window.api.fs.appendDownloadedFileChunk({
          transferId: download.transferId,
          contentBase64: chunk.contentBase64
        })
      }
      offset += chunk.bytesRead
      if (chunk.eof) {
        break
      }
      if (chunk.bytesRead <= 0) {
        throw new Error('Remote download stalled before reaching EOF')
      }
    }
    const result = await window.api.fs.finishDownloadedFile({ transferId: download.transferId })
    finished = true
    return result
  } finally {
    if (!finished) {
      await window.api.fs.cancelDownloadedFile({ transferId: download.transferId }).catch(() => {})
    }
  }
}

async function remoteChunkedDownloadAvailable(address: RuntimeFileAddress): Promise<boolean> {
  try {
    await callRuntimeRpc<RuntimeFileReadChunkResult>(
      address.target,
      'files.readChunk',
      { ...address.params, offset: 0, length: 1 },
      { timeoutMs: 60_000 }
    )
    return true
  } catch (error) {
    // Why: compatible older headless servers may lack chunked downloads while
    // still supporting preview-sized file reads that can complete the request.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return false
    }
    throw error
  }
}

async function readRemoteDownloadChunk(
  address: RuntimeFileAddress,
  offset: number
): Promise<RuntimeFileReadChunkResult> {
  return callRuntimeRpc<RuntimeFileReadChunkResult>(
    address.target,
    'files.readChunk',
    { ...address.params, offset, length: REMOTE_DOWNLOAD_CHUNK_BYTES },
    { timeoutMs: 60_000 }
  )
}

async function downloadRemoteFileViaPreview(
  address: RuntimeFileAddress,
  suggestedName: string
): Promise<RuntimeFileDownloadResult> {
  try {
    const result = await callRuntimeRpc<RuntimeFilePreviewResult>(
      address.target,
      'files.readPreview',
      address.params,
      { timeoutMs: 15_000 }
    )
    // Why: old servers use an empty, metadata-free binary result to signal an
    // unsupported binary; recognized zero-byte previews are still complete.
    if (result.isBinary && !result.content && !result.isImage && !result.mimeType) {
      throw new Error(REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE)
    }
    return window.api.fs.saveDownloadedFile({
      suggestedName,
      content: result.content,
      encoding: result.isBinary ? 'base64' : 'utf8'
    })
  } catch (error) {
    if (isUnsupportedRemotePreviewDownload(error)) {
      throw new Error(REMOTE_DOWNLOAD_UPDATE_REQUIRED_MESSAGE)
    }
    throw error
  }
}

function isUnsupportedRemotePreviewDownload(error: unknown): boolean {
  if (!(error instanceof RuntimeRpcCallError)) {
    return false
  }
  return (
    error.code === 'method_not_found' ||
    (error.code === 'runtime_error' &&
      (error.message === 'file_too_large' || error.message === 'binary_file'))
  )
}

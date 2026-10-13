import type { MarkdownDocument } from '../../../shared/filesystem-entry-types'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { assertLocalFilesystemFallbackAllowed } from './runtime-file-routing'
import {
  getRuntimeWorkspaceFileAddress,
  mayAddressByHostPath,
  resolveRuntimeHostPathAddress
} from './runtime-file-address'
import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import { localAccess } from './runtime-file-read-client'

export async function listRuntimeMarkdownDocuments(
  context: RuntimeFileOperationArgs,
  rootPath: string
): Promise<MarkdownDocument[]> {
  const target = context.target
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.listMarkdownDocuments({
      rootPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<MarkdownDocument[]>(
    target,
    'files.listMarkdownDocuments',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 15_000 }
  )
}

export async function statRuntimePath(
  context: RuntimeFileOperationArgs,
  absolutePath: string,
  access?: LocalFileAccess
): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
  const address =
    getRuntimeWorkspaceFileAddress(context, absolutePath) ??
    (mayAddressByHostPath(context, absolutePath)
      ? await resolveRuntimeHostPathAddress(context, absolutePath, access)
      : null)
  if (!address) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.stat({
      filePath: absolutePath,
      connectionId: context.connectionId,
      ...localAccess(context.connectionId, access)
    })
  }
  return callRuntimeRpc<{ size: number; isDirectory: boolean; mtime: number }>(
    address.target,
    'files.stat',
    address.params,
    { timeoutMs: 15_000 }
  )
}

export function isMissingRuntimePathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('enoent') || message.includes('not found') || message.includes('no such file')
  )
}

export async function runtimePathExists(
  context: RuntimeFileOperationArgs,
  absolutePath: string,
  expectedEnvironmentPairingRevision?: number
): Promise<boolean> {
  const address =
    getRuntimeWorkspaceFileAddress(context, absolutePath) ??
    (mayAddressByHostPath(context, absolutePath)
      ? await resolveRuntimeHostPathAddress(context, absolutePath)
      : null)
  if (!address) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.pathExists({
      filePath: absolutePath,
      connectionId: context.connectionId
    })
  }

  try {
    await callRuntimeRpc(address.target, 'files.stat', address.params, {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision
    })
    return true
  } catch (err) {
    if (isMissingRuntimePathError(err)) {
      return false
    }
    throw err
  }
}

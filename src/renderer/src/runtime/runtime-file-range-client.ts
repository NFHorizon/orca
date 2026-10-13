import type { RuntimeFileReadChunkResult } from '../../../shared/runtime-types'
import { validateFileRangeRequest } from '../../../shared/file-range-read'
import type { RuntimeFileReadArgs } from './runtime-file-client-types'
import { assertExternalSshReadOwnership } from './runtime-file-routing'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import {
  getRuntimeWorkspaceReadAddress,
  resolveRuntimeHostPathAddress,
  type RuntimeFileAddress
} from './runtime-file-address'

async function rangeReadAddress(args: RuntimeFileReadArgs): Promise<RuntimeFileAddress | null> {
  assertExternalSshReadOwnership(args.target, args.connectionId, args.expectedExternalSshTargetId)
  if (args.target.kind !== 'environment') {
    return null
  }
  if (!args.worktreeId) {
    throw new Error('Remote file has no owning runtime worktree')
  }
  const address =
    getRuntimeWorkspaceReadAddress(args) ??
    (await resolveRuntimeHostPathAddress(args, args.filePath, args.access))
  if (!address) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }
  return address
}

export type RuntimeFileSnapshot = { size: number; isDirectory: boolean; mtime: number }

export async function statRuntimeReadTarget(
  args: RuntimeFileReadArgs
): Promise<RuntimeFileSnapshot> {
  const remote = await rangeReadAddress(args)
  if (!remote) {
    return window.api.fs.stat({
      filePath: args.filePath,
      connectionId: args.connectionId,
      access: args.access
    })
  }
  return callRuntimeRpc<RuntimeFileSnapshot>(remote.target, 'files.stat', remote.params, {
    timeoutMs: 15_000
  })
}

export async function readRuntimeFileRange(
  args: RuntimeFileReadArgs,
  offset: number,
  length: number
): Promise<Uint8Array<ArrayBuffer>> {
  validateFileRangeRequest(offset, length)
  let result: RuntimeFileReadChunkResult
  try {
    const remote = await rangeReadAddress(args)
    result = remote
      ? await callRuntimeRpc<RuntimeFileReadChunkResult>(
          remote.target,
          'files.readChunk',
          { ...remote.params, offset, length },
          { timeoutMs: 60_000 }
        )
      : await window.api.fs.readFileChunk({
          filePath: args.filePath,
          connectionId: args.connectionId,
          access: args.access,
          offset,
          length
        })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(
        'Large CSV previews require a newer Orca server. Update the server and retry.'
      )
    }
    throw error
  }
  const bytes = Uint8Array.from(atob(result.contentBase64), (character) => character.charCodeAt(0))
  if (bytes.length !== result.bytesRead || bytes.length > length || bytes.length === 0) {
    throw new Error('File changed or returned an invalid CSV chunk. Reload the preview.')
  }
  return bytes
}

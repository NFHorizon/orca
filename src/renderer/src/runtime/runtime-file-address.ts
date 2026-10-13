import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../shared/runtime-file-contracts'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeFileOperationArgs, RuntimeFileReadArgs } from './runtime-file-client-types'
import {
  canReadRelativeRuntimeFile,
  getRemoteFileArgs,
  isAbsolutePathLike
} from './runtime-file-routing'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

/** The fields that name one file on its owner host; spread into any `files.*` request. */
export type RuntimeFileTargetParams =
  | { worktree: string; relativePath: string }
  | { path: string; access?: { kind: 'user-file' } }

/** A file on a paired or SSH host, addressed the way that host serves it. */
export type RuntimeFileAddress = {
  target: RuntimeClientTarget & { kind: 'environment' }
  params: RuntimeFileTargetParams
}

type HostPathOwnerContext = Pick<RuntimeFileOperationArgs, 'target' | 'connectionId'> &
  Partial<Pick<RuntimeFileOperationArgs, 'worktreeId' | 'expectedExecutionHostId'>>

export function runtimeEnvironmentServesFilesByPath(environmentId: string): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    environmentId,
    FILES_HOST_PATH_RUNTIME_CAPABILITY,
    15_000
  )
}

/** A runtime-owned workspace's file inside its worktree, addressed by its relative path. */
export function getRuntimeWorkspaceFileAddress(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): RuntimeFileAddress | null {
  const remote = getRemoteFileArgs(context, absolutePath)
  return remote
    ? {
        target: remote.target,
        params: { worktree: remote.worktreeSelector, relativePath: remote.relativePath }
      }
    : null
}

/** {@link getRuntimeWorkspaceFileAddress} for an open file, which knows its relative path instead of its root. */
export function getRuntimeWorkspaceReadAddress(
  args: RuntimeFileReadArgs
): RuntimeFileAddress | null {
  const target = args.target
  return target.kind === 'environment' &&
    args.worktreeId &&
    canReadRelativeRuntimeFile(args.relativePath)
    ? {
        target,
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          relativePath: args.relativePath
        }
      }
    : null
}

/** Whether only a host can say if it serves this path; false answers without asking anyone. */
export function mayAddressByHostPath(context: HostPathOwnerContext, absolutePath: string): boolean {
  return (
    context.target.kind === 'environment' &&
    Boolean(context.worktreeId) &&
    // Why: a host proxying an SSH workspace would answer from its own disk, not that workspace's.
    !context.connectionId &&
    (context.expectedExecutionHostId === undefined ||
      context.expectedExecutionHostId === 'local') &&
    isAbsolutePathLike(absolutePath)
  )
}

/**
 * A runtime-owned workspace's file outside its worktree, addressed by its absolute path on a host
 * that serves paths. The host alone decides which paths it reaches. Null leaves the caller's
 * refusal in place; never this computer's file.
 */
export async function resolveRuntimeHostPathAddress(
  context: HostPathOwnerContext,
  absolutePath: string,
  access?: LocalFileAccess
): Promise<RuntimeFileAddress | null> {
  const target = context.target
  if (
    target.kind !== 'environment' ||
    !mayAddressByHostPath(context, absolutePath) ||
    !(await runtimeEnvironmentServesFilesByPath(target.environmentId))
  ) {
    return null
  }
  return {
    target,
    params: {
      path: absolutePath,
      // Why: only a path the user named carries user authority; document references stay plain.
      ...(access?.kind === 'user-file' ? { access: { kind: 'user-file' as const } } : {})
    }
  }
}

import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../shared/runtime-file-contracts'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeFileOperationArgs, RuntimeFileReadArgs } from './runtime-file-client-types'
import {
  canReadRelativeRuntimeFile,
  getRemoteFileArgs,
  isAbsolutePathLike
} from './runtime-file-routing'
import { getRuntimeEnvironmentStatus, peekRuntimeEnvironmentStatus } from './runtime-rpc-client'
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

// Why: the answer is read from the shared status cache on every call, which already drops it when
// the host's runtime is replaced, the connection is re-checked or re-paired. Only a failed probe's
// time is kept here, so a host that can't answer isn't re-asked for a minute.
const HOST_PATH_PROBE_RETRY_MS = 60_000
const hostPathProbeFailedAt = new Map<string, number>()
const hostPathProbes = new Map<string, Promise<boolean>>()

function servesFilesByPath(status: RuntimeStatus): boolean {
  return status.capabilities?.includes(FILES_HOST_PATH_RUNTIME_CAPABILITY) === true
}

function probeHostPathCapability(environmentId: string): Promise<boolean> {
  const running = hostPathProbes.get(environmentId)
  if (running) {
    return running
  }
  const failedAt = hostPathProbeFailedAt.get(environmentId)
  if (failedAt !== undefined && Date.now() - failedAt < HOST_PATH_PROBE_RETRY_MS) {
    return Promise.resolve(false)
  }
  const probe = getRuntimeEnvironmentStatus(environmentId, 15_000)
    .then((status) => {
      hostPathProbeFailedAt.delete(environmentId)
      return servesFilesByPath(status)
    })
    // Why: a host that can't answer is treated as an older one, so callers keep today's path.
    .catch(() => {
      hostPathProbeFailedAt.set(environmentId, Date.now())
      return false
    })
    .finally(() => hostPathProbes.delete(environmentId))
  hostPathProbes.set(environmentId, probe)
  return probe
}

/**
 * Whether the host's cached status says it serves files by path; undefined when no status is
 * cached. Never waits: an unknown answer is probed in the background.
 */
export function knownRuntimeEnvironmentServesFilesByPath(
  environmentId: string
): boolean | undefined {
  const status = peekRuntimeEnvironmentStatus(environmentId)
  if (!status) {
    void probeHostPathCapability(environmentId)
    return undefined
  }
  return servesFilesByPath(status)
}

/** Waits for the host only when no status is cached for it. */
export function runtimeEnvironmentServesFilesByPath(environmentId: string): Promise<boolean> {
  const status = peekRuntimeEnvironmentStatus(environmentId)
  return status
    ? Promise.resolve(servesFilesByPath(status))
    : probeHostPathCapability(environmentId)
}

export function clearRuntimeHostPathProbesForTests(): void {
  hostPathProbeFailedAt.clear()
  hostPathProbes.clear()
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

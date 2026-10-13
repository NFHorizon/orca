import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../shared/runtime-file-contracts'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeFileOperationArgs, RuntimeFileReadArgs } from './runtime-file-client-types'
import {
  canReadRelativeRuntimeFile,
  getRemoteFileArgs,
  isAbsolutePathLike
} from './runtime-file-routing'
import { getRuntimeEnvironmentStatus, peekRuntimeEnvironmentStatus } from './runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
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

type HostPathVerdict = { serves: boolean; checkedAt: number; revision: number | undefined }

// Why: the shared status cache forgets a negative capability answer, so an older host would be
// re-asked on every outside link, click and read; this verdict is kept for the status lifetime.
const HOST_PATH_VERDICT_TTL_MS = 60_000
const hostPathVerdicts = new Map<string, HostPathVerdict>()
const hostPathProbes = new Map<string, Promise<boolean>>()

function currentHostPathVerdict(environmentId: string): HostPathVerdict | undefined {
  const verdict = hostPathVerdicts.get(environmentId)
  if (verdict && verdict.revision === getRuntimeEnvironmentRevision(environmentId)) {
    return verdict
  }
  const status = peekRuntimeEnvironmentStatus(environmentId)
  if (!status) {
    return undefined
  }
  const peeked = {
    serves: status.capabilities?.includes(FILES_HOST_PATH_RUNTIME_CAPABILITY) === true,
    checkedAt: Date.now(),
    revision: getRuntimeEnvironmentRevision(environmentId)
  }
  hostPathVerdicts.set(environmentId, peeked)
  return peeked
}

function probeHostPathVerdict(environmentId: string): Promise<boolean> {
  const running = hostPathProbes.get(environmentId)
  if (running) {
    return running
  }
  const revision = getRuntimeEnvironmentRevision(environmentId)
  const probe = getRuntimeEnvironmentStatus(environmentId, 15_000)
    .then((status) => {
      const serves = status.capabilities?.includes(FILES_HOST_PATH_RUNTIME_CAPABILITY) === true
      hostPathVerdicts.set(environmentId, { serves, checkedAt: Date.now(), revision })
      return serves
    })
    // Why: a host that can't answer is treated as an older one, so callers keep today's path.
    .catch(() => false)
    .finally(() => hostPathProbes.delete(environmentId))
  hostPathProbes.set(environmentId, probe)
  return probe
}

/**
 * Whether the host already answered that it serves files by path; undefined when it never has.
 * Never waits: a missing or stale answer is refreshed in the background.
 */
export function knownRuntimeEnvironmentServesFilesByPath(
  environmentId: string
): boolean | undefined {
  const verdict = currentHostPathVerdict(environmentId)
  if (!verdict || Date.now() - verdict.checkedAt >= HOST_PATH_VERDICT_TTL_MS) {
    void probeHostPathVerdict(environmentId)
  }
  return verdict?.serves
}

/** Waits for the host only when it has never answered; a stale answer is used and refreshed. */
export function runtimeEnvironmentServesFilesByPath(environmentId: string): Promise<boolean> {
  const known = knownRuntimeEnvironmentServesFilesByPath(environmentId)
  return known === undefined ? probeHostPathVerdict(environmentId) : Promise.resolve(known)
}

export function clearRuntimeHostPathVerdictsForTests(): void {
  hostPathVerdicts.clear()
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

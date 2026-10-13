import { z } from 'zod'

export const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

export const FileOpen = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing relative path'))
})

/** What a host-path request may declare. Absent means the host's own roots, as for workspace files. */
export const HostPathFileAccess = z.object({ kind: z.literal('user-file') })

/**
 * A file on the host serving the request, named by its absolute path in that host's own spelling
 * instead of a workspace and a relative path. Which paths it may reach is the host's rule.
 */
export const HostPathTarget = z.object({
  // Why a type error, not coercion to '': it abandons this form outright, so a request without
  // `path` reports the workspace form's errors (see workspaceOrHostPathTarget).
  path: z.string({ error: 'Missing path' }).min(1, 'Missing path'),
  access: HostPathFileAccess.optional()
})

export const MIXED_FILE_TARGET_MESSAGE =
  'Name a file by worktree and relativePath, or by path, not both'

const WORKSPACE_TARGET_KEYS = ['worktree', 'relativePath'] as const
const HOST_PATH_TARGET_KEYS = ['path', 'access'] as const

function hasAnyKey(input: unknown, keys: readonly string[]): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    Object.entries(input).some(([key, value]) => value !== undefined && keys.includes(key))
  )
}

/**
 * `{worktree, relativePath, ...}` exactly as before, or `{path, access?, ...}`; a request naming
 * both forms, or neither, is refused. A request without `path` or `access` reports the workspace
 * form's own errors, so older clients see the messages they always did.
 *
 * Why each form refuses the other's keys with a type error: zod reports a lone non-aborted
 * option's issues as-is, so the form a request did not choose must always abort.
 */
export function workspaceOrHostPathTarget<
  WorkspaceShape extends z.ZodRawShape,
  HostPathShape extends z.ZodRawShape
>(workspaceForm: z.ZodObject<WorkspaceShape>, hostPathForm: z.ZodObject<HostPathShape>) {
  return z.union(
    [
      workspaceForm.extend({ path: z.never().optional(), access: z.never().optional() }),
      hostPathForm.extend({ worktree: z.never().optional(), relativePath: z.never().optional() })
    ],
    {
      error: (issue) => {
        if (issue.code !== 'invalid_union') {
          return undefined
        }
        const namesHostPath = hasAnyKey(issue.input, HOST_PATH_TARGET_KEYS)
        if (namesHostPath && hasAnyKey(issue.input, WORKSPACE_TARGET_KEYS)) {
          return MIXED_FILE_TARGET_MESSAGE
        }
        return issue.errors[namesHostPath ? 1 : 0]?.[0]?.message
      }
    }
  )
}

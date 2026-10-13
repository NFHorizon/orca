import type { Store } from '../persistence'
import { resolveAuthorizedPath, type ResolveAuthorizedPathOptions } from './filesystem-auth'
import { getDefaultFloatingWorkspacePath } from './floating-workspace-directory'

/**
 * The roots a local file request may use without a declared access kind, beyond the store's
 * registered project roots (repos, their worktree folders and folder workspaces). Each caller
 * passes its own: the desktop window and this host's runtime file services differ.
 */
export type LocalFileRootScope = {
  extraRoots: () => readonly string[]
}

/** Desktop IPC adds the app-owned floating-workspace folder, which no runtime client may reach. */
export const DESKTOP_FILE_ROOT_SCOPE: LocalFileRootScope = {
  extraRoots: () => [getDefaultFloatingWorkspacePath()]
}

/** Runtime file services (paired and SSH clients reach them through this host): project roots only. */
export const HOST_FILE_ROOT_SCOPE: LocalFileRootScope = {
  extraRoots: () => []
}

export type ScopedAuthorizedPathOptions = Omit<ResolveAuthorizedPathOptions, 'extraRoots'>

/** The default-root check of every local file request, against its caller's root scope. */
export function resolveScopedAuthorizedPath(
  targetPath: string,
  store: Store,
  rootScope: LocalFileRootScope,
  options: ScopedAuthorizedPathOptions = {}
): Promise<string> {
  return resolveAuthorizedPath(targetPath, store, {
    ...options,
    extraRoots: rootScope.extraRoots()
  })
}

/** The runtime file services' root check: this host's registered project roots. */
export function resolveHostAuthorizedPath(
  targetPath: string,
  store: Store,
  options: ScopedAuthorizedPathOptions = {}
): Promise<string> {
  return resolveScopedAuthorizedPath(targetPath, store, HOST_FILE_ROOT_SCOPE, options)
}

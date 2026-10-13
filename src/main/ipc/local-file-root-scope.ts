import type { LocalFileAccess } from '../../shared/local-file-access'
import type { Store } from '../persistence'
import { resolveAuthorizedPath, type ResolveAuthorizedPathOptions } from './filesystem-auth'
import { getDefaultFloatingWorkspacePath } from './floating-workspace-directory'
import { nativeChatScratchRootFor } from '../native-chat/native-chat-scratch-folder'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

/**
 * What a local file request may reach, decided by who asks: the desktop window and this host's
 * runtime file services each pass their own.
 */
export type LocalFileRootScope = {
  /** Roots beyond the store's registered project roots (repos, worktree folders, folder workspaces). */
  extraRoots: () => readonly string[]
  /** Declared access kinds honoured outside the roots; any other kind gets the root check only. */
  accessKinds: ReadonlySet<LocalFileAccess['kind']>
}

/** Desktop IPC adds the app-owned floating-workspace folder, which no runtime client may reach. */
export const DESKTOP_FILE_ROOT_SCOPE: LocalFileRootScope = {
  extraRoots: () => [getDefaultFloatingWorkspacePath()],
  accessKinds: new Set(['user-file', 'document-resource', 'chat-image', 'document-folder'])
}

/**
 * Runtime file services (paired and SSH clients reach them through this host): project roots
 * only. No declared kind yet: the desktop's rules reach outside every root, which a remote client
 * must not.
 */
export const HOST_FILE_ROOT_SCOPE: LocalFileRootScope = {
  extraRoots: () => [],
  accessKinds: new Set()
}

/**
 * A runtime request naming a host file by its absolute path: the project roots plus this host's
 * chat scratch folder, every chat's subfolder included. Separate from `HOST_FILE_ROOT_SCOPE` so
 * workspace-addressed requests (and their deletes and renames) never reach Orca's own state.
 * `user-file` is accepted on the wire but not honoured here, so it stays inside these roots too;
 * letting a clicked file reach anywhere on the host is adding it to `accessKinds`.
 */
export const HOST_PATH_TARGET_ROOT_SCOPE: LocalFileRootScope = {
  // Why the profile path: chat hosts and their scratch folders open in it on this process.
  extraRoots: () => [nativeChatScratchRootFor(getProfileUserDataPath())],
  accessKinds: new Set()
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

import { isAbsolute, sep } from 'node:path'
import type { LocalFileAccess } from '../../shared/local-file-access'
import { PATH_ACCESS_DENIED_MESSAGE } from '../ipc/filesystem-auth'
import {
  resolveLocalRequestPathInScope,
  type LocalRequestOperation
} from '../ipc/local-file-access-resolution'
import { HOST_PATH_TARGET_ROOT_SCOPE } from '../ipc/local-file-root-scope'
import type { Store } from '../persistence'

/** A file on this host named by its absolute path; `access` is what the client declares. */
export type HostPathFileTarget = { path: string; access?: LocalFileAccess }

// Why not isAbsolute alone: on Windows `\dir\file` is absolute to whichever drive is current.
function isHostNativeAbsolutePath(path: string): boolean {
  return isAbsolute(path) && (sep === '/' || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path))
}

/** This host's authorization of a host-path request; its rule lives in the scope. */
export function resolveHostPathTarget(
  target: HostPathFileTarget,
  store: Store,
  operation: LocalRequestOperation
): Promise<string> {
  if (!isHostNativeAbsolutePath(target.path)) {
    return Promise.reject(new Error(PATH_ACCESS_DENIED_MESSAGE))
  }
  return resolveLocalRequestPathInScope(
    target.path,
    target.access,
    store,
    operation,
    HOST_PATH_TARGET_ROOT_SCOPE
  )
}

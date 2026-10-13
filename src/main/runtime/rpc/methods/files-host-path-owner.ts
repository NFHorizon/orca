import { parseExecutionHostId } from '../../../../shared/execution-host'
import { InvalidArgumentError, type RpcContext } from '../core'

export const HOST_PATH_NOT_SERVED_HERE_MESSAGE =
  'A file named by path is served only by the host that owns it'

/**
 * A host path names a file on one machine's disk, so only that machine may serve it. A request
 * tagged for another host (an SSH target this process reaches, or a server it failed to relay
 * to) is refused here instead of reading a same-named file on this machine.
 */
export function assertHostPathServedHere({ requestedExecutionHost }: RpcContext): void {
  if (requestedExecutionHost === undefined) {
    return
  }
  const host = parseExecutionHostId(
    typeof requestedExecutionHost === 'string' ? requestedExecutionHost : null
  )
  if (host?.kind !== 'local') {
    throw new InvalidArgumentError(HOST_PATH_NOT_SERVED_HERE_MESSAGE)
  }
}

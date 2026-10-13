import type { FileLinkTarget } from '@/components/terminal-pane/terminal-file-link-target'
import { isHostPathOutsideWorkspace } from '@/components/terminal-pane/terminal-host-file-link-existence'
import { statHostPathFile } from '@/components/terminal-pane/terminal-host-workspace-file'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { knownRuntimeEnvironmentServesFilesByPath } from '@/runtime/runtime-file-address'
import { useAppStore } from '@/store'

// Why: a transcript can name many outside paths, and each turn end rechecks them all.
const HOST_PATH_STAT_CONCURRENCY = 4
// Why: one deadline for the whole check (queue, compatibility wait and stat), so a host that stops
// answering never holds a link back from today's check for longer.
const HOST_PATH_CHECK_DEADLINE_MS = 5_000

/** Whether the link's host serves its file by path; false sends the link to today's check. */
export type HostPathLinkExistence = (target: FileLinkTarget) => Promise<boolean>

/**
 * One `files.stat` by path per outside link, a few at a time, and only on a reachable host already
 * known to serve paths. Refusal, absence, the deadline or loss of contact all answer false.
 */
export function createHostPathLinkExistence(): HostPathLinkExistence {
  let running = 0
  const queued: (() => void)[] = []
  const release = (): void => {
    running -= 1
    queued.shift()?.()
  }
  const acquire = (): Promise<void> => {
    if (running < HOST_PATH_STAT_CONCURRENCY) {
      running += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      queued.push(() => {
        running += 1
        resolve()
      })
    })
  }
  const statWithinDeadline = async (target: FileLinkTarget): Promise<boolean> => {
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        expired = true
        resolve(false)
      }, HOST_PATH_CHECK_DEADLINE_MS)
    })
    const check = (async () => {
      await acquire()
      try {
        if (expired) {
          return false
        }
        const file = await statHostPathFile(
          target.fileContext,
          target.absolutePath,
          HOST_PATH_CHECK_DEADLINE_MS
        ).catch(() => null)
        return file !== null
      } finally {
        release()
      }
    })()
    try {
      return await Promise.race([check, deadline])
    } finally {
      clearTimeout(timer)
    }
  }
  return async (target) => {
    const environmentId = runtimeTargetEnvironmentId(target.fileContext.target)
    if (
      !environmentId ||
      !isHostPathOutsideWorkspace(target) ||
      // Why: the app already shows this host as unreachable; asking it would only wait.
      useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)?.status === null ||
      knownRuntimeEnvironmentServesFilesByPath(environmentId) !== true
    ) {
      return false
    }
    return statWithinDeadline(target)
  }
}

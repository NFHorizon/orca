import type { FileLinkTarget } from '@/components/terminal-pane/terminal-file-link-target'
import { isHostPathOutsideWorkspace } from '@/components/terminal-pane/terminal-host-file-link-existence'
import { statHostPathFile } from '@/components/terminal-pane/terminal-host-workspace-file'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { knownRuntimeEnvironmentServesFilesByPath } from '@/runtime/runtime-file-address'

// Why: a transcript can name many outside paths, and each turn end rechecks them all.
const HOST_PATH_STAT_CONCURRENCY = 4
const HOST_PATH_STAT_TIMEOUT_MS = 5_000

/** Whether the link's host serves its file by path; false sends the link to today's check. */
export type HostPathLinkExistence = (target: FileLinkTarget) => Promise<boolean>

/**
 * One `files.stat` by path per outside link, a few at a time, and only on a host already known
 * to serve paths. Refusal, absence, timeout or loss of contact all answer false, never an error.
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
  return async (target) => {
    const environmentId = runtimeTargetEnvironmentId(target.fileContext.target)
    if (
      !environmentId ||
      !isHostPathOutsideWorkspace(target) ||
      knownRuntimeEnvironmentServesFilesByPath(environmentId) !== true
    ) {
      return false
    }
    await acquire()
    try {
      const file = await statHostPathFile(
        target.fileContext,
        target.absolutePath,
        HOST_PATH_STAT_TIMEOUT_MS
      ).catch(() => null)
      return file !== null
    } finally {
      release()
    }
  }
}

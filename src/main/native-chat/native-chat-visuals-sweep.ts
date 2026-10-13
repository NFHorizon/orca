// How a chat's visuals folder dies. The host never deletes a chat record, so no deletion event
// exists to hang cleanup on; instead each folder's life is re-derived from the records every run:
//   1. a folder no chat record (readable or not) maps to is removed, so any future record
//      deletion cleans up for free;
//   2. a folder whose chat went unused for the retention window is removed: its newest journal row
//      and its newest file are both older than that, and the host holds no execution for the chat.
// Rule 2 decides again under the chat's lifecycle lock, so a start accepted after the first look
// keeps the folder. Anything unproven is kept. A failure is logged and never blocks anything else.

import type { Dirent } from 'node:fs'
import { lstat, opendir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import { nativeChatVisualsFolderName, nativeChatVisualsRootFor } from './native-chat-visuals-folder'

/** How long a chat's visuals outlive its last use. */
export const NATIVE_CHAT_VISUALS_RETENTION_MS = 30 * 24 * 60 * 60_000

export type NativeChatVisualsSweepDeps = {
  stateDirectory: string
  /** Every chat this host holds a row for, readable or not; null when that can't be trusted. */
  listHeldSessionIds: () => readonly string[] | null
  /** When the chat's newest journal row was saved; null when it has none. */
  lastJournalActivityAt: (sessionId: string) => number | null
  /** Runs `task` under the chat's lifecycle lock unless the host still holds execution for it;
   *  null when it does. */
  runWhileExecutionIdle: <T>(sessionId: string, task: () => Promise<T>) => Promise<T | null>
  logger: StructuredAgentSessionLogger
  remove?: (path: string) => Promise<void>
  now?: () => number
}

export type NativeChatVisualsSweepResult = { removed: number; failed: number }

// Only names this host minted: anything else in the folder is never touched.
const FOLDER_NAME = /^[0-9a-f]{32}$/
// An expired folder is renamed under the chat's lock and deleted after it, so the lock is held for
// one rename; a deletion that fails or is cut short leaves this name for a later run.
const EXPIRED_SUFFIX = '.expired'
const EXPIRED_NAME = /^[0-9a-f]{32}\.expired$/
// Bounds one run's disk work; whatever is left goes in a later run.
const MAX_REMOVALS_PER_RUN = 200
// Bounds the entries one folder's age is read from; see `newestEntryTime`.
const MAX_ENTRIES_PER_FOLDER = 256
const YIELD_EVERY = 32

type SweepRun = {
  deps: NativeChatVisualsSweepDeps
  root: string
  cutoff: number
  remove: (path: string) => Promise<void>
  result: NativeChatVisualsSweepResult
}

async function listFolders(root: string): Promise<Dirent[]> {
  try {
    // A root that is not a real directory is not one this host made; nothing under it is touched.
    if (!(await lstat(root)).isDirectory()) {
      return []
    }
    return await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  }
}

export async function sweepNativeChatVisualsFolders(
  deps: NativeChatVisualsSweepDeps,
  isStopped: () => boolean = () => false
): Promise<NativeChatVisualsSweepResult> {
  const result = { removed: 0, failed: 0 }
  const root = nativeChatVisualsRootFor(deps.stateDirectory)
  // Listed before the records are read: a folder is created only after its chat's record, so
  // every folder seen here already has its record in the snapshot below.
  const entries = await listFolders(root)
  const held = deps.listHeldSessionIds()
  if (!held || entries.length === 0) {
    return result
  }
  const sessionByFolder = new Map(
    held.map((sessionId) => [nativeChatVisualsFolderName(sessionId), sessionId])
  )
  const run: SweepRun = {
    deps,
    root,
    cutoff: (deps.now?.() ?? Date.now()) - NATIVE_CHAT_VISUALS_RETENTION_MS,
    remove: deps.remove ?? ((path: string) => rm(path, { recursive: true, force: true })),
    result
  }
  let visited = 0
  for (const entry of entries) {
    if (isStopped() || result.removed + result.failed >= MAX_REMOVALS_PER_RUN) {
      break
    }
    if (++visited % YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
    // A Dirent describes the entry itself, so a symlink is never followed or removed here.
    if (!entry.isDirectory()) {
      continue
    }
    if (EXPIRED_NAME.test(entry.name)) {
      await removeFolder(run, entry.name, 'expired')
      continue
    }
    if (!FOLDER_NAME.test(entry.name)) {
      continue
    }
    const sessionId = sessionByFolder.get(entry.name)
    await (sessionId === undefined
      ? removeFolder(run, entry.name, 'no-record')
      : expireUnusedFolder(run, entry.name, sessionId))
  }
  return result
}

async function removeFolder(
  run: SweepRun,
  name: string,
  reason: 'no-record' | 'expired' | 'inactive',
  sessionId?: string
): Promise<void> {
  try {
    await run.remove(join(run.root, name))
    run.result.removed += 1
  } catch (error) {
    reportFailure(run, reason, sessionId, error)
  }
}

async function expireUnusedFolder(run: SweepRun, name: string, sessionId: string): Promise<void> {
  const folder = join(run.root, name)
  try {
    if (!(await isUnused(run, folder, sessionId))) {
      return
    }
    const parked = await run.deps.runWhileExecutionIdle(sessionId, async () => {
      if (!(await isUnused(run, folder, sessionId))) {
        return false
      }
      await rename(folder, folder + EXPIRED_SUFFIX)
      return true
    })
    if (!parked) {
      return
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      reportFailure(run, 'inactive', sessionId, error)
    }
    return
  }
  await removeFolder(run, name + EXPIRED_SUFFIX, 'inactive', sessionId)
}

/** Files first: the journal is asked only about a folder whose files already look unused. */
async function isUnused(run: SweepRun, folder: string, sessionId: string): Promise<boolean> {
  if ((await newestEntryTime(folder)) >= run.cutoff) {
    return false
  }
  const lastActivityAt = run.deps.lastJournalActivityAt(sessionId)
  return lastActivityAt === null || lastActivityAt < run.cutoff
}

/** The newest mtime among the folder and its entries, none of them followed. Past the entry bound
 *  the folder's own mtime and the entries already read stand in for the rest: adding, removing or
 *  replacing an entry moves the folder's mtime, and the journal covers a turn that rewrote one. */
async function newestEntryTime(folder: string): Promise<number> {
  const self = await lstat(folder)
  if (!self.isDirectory()) {
    return Infinity
  }
  let newest = self.mtimeMs
  let seen = 0
  // Closed by the loop, including on an early return.
  for await (const entry of await opendir(folder)) {
    if (++seen > MAX_ENTRIES_PER_FOLDER) {
      return newest
    }
    try {
      newest = Math.max(newest, (await lstat(join(folder, entry.name))).mtimeMs)
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      // Something is changing the folder right now.
      return Infinity
    }
  }
  return newest
}

function reportFailure(
  run: SweepRun,
  reason: 'no-record' | 'expired' | 'inactive',
  sessionId: string | undefined,
  error: unknown
): void {
  run.result.failed += 1
  run.deps.logger.warn('native-chat visuals folder could not be removed', {
    scope: 'nativeChatVisuals.sweep',
    reason,
    ...(sessionId ? { sessionId } : {}),
    error
  })
}

// Why minutes, not at boot: the first sweep must not compete with session restore; after that, a
// few runs a day is enough for files nothing reads.
const FIRST_SWEEP_DELAY_MS = 2 * 60_000
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000

/** Runs the sweep after startup and then periodically; the returned stop ends both. */
export function scheduleNativeChatVisualsSweep(deps: NativeChatVisualsSweepDeps): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = async (): Promise<void> => {
    try {
      await sweepNativeChatVisualsFolders(deps, () => stopped)
    } catch (error) {
      deps.logger.warn('native-chat visuals sweep failed', {
        scope: 'nativeChatVisuals.sweep',
        error
      })
    }
    arm(SWEEP_INTERVAL_MS)
  }
  const arm = (delayMs: number): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => void run(), delayMs)
    timer.unref?.()
  }
  arm(FIRST_SWEEP_DELAY_MS)
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}

// Reading a chat visual as an ordinary file on the chat's own host: the host-published scratch
// folder joined with the reply's bare file name, read with the `chat-visual` access kind.
//
// The cache only paints a remounted visual at once; every load still reads the file. Failures are
// never cached.

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-metadata-client'
import { chatVisualAccess } from '@/lib/local-file-access'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeHostPathFileReadResult } from '../../../../shared/runtime-file-contracts'
import { isPathOutsideAllowedDirectoriesError } from '../../../../shared/local-file-access'

/** A visual's identity: the host that owns the chat and the file's absolute path there. */
export type NativeChatVisualFile = { target: RuntimeClientTarget; path: string }

export type NativeChatVisualPage = { html: string }

/**
 * `not_found`: the file is not there (yet). `refused`: the host will not show it (outside a chat
 * folder, not a file, too large, not text). `unavailable`: no answer, never a verdict on the file.
 */
export type NativeChatVisualPathReadOutcome =
  | { ok: true; page: NativeChatVisualPage }
  | { ok: false; reason: 'not_found' | 'refused' | 'unavailable' }

const MAX_CACHED_PAGES = 24
const MAX_CACHED_CHARS = 6 * 1024 * 1024
const READ_TIMEOUT_MS = 15_000
// The host's typed refusals of a content read, which it also gives for a visual it won't show.
const REFUSAL_MESSAGES = ['Not a regular file', 'file_too_large', 'binary_file']

type CachedPage = { page: NativeChatVisualPage; read: number }
type PendingRead = { read: number; outcome: Promise<NativeChatVisualPathReadOutcome> }

const cache = new Map<string, CachedPage>()
const inFlight = new Map<string, PendingRead>()
let reads = 0

export function nativeChatVisualHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export function nativeChatVisualFileKey(file: NativeChatVisualFile): string {
  return JSON.stringify([nativeChatVisualHostKey(file.target), file.path])
}

/**
 * The newest read begun so far. A caller that knows the file may have changed (a turn ended, a save
 * landed) passes it as `startedAfter`, so its read never joins one begun before the change.
 */
export function markNativeChatVisualReads(): number {
  return reads
}

export function peekNativeChatVisualFile(file: NativeChatVisualFile): NativeChatVisualPage | null {
  return cache.get(nativeChatVisualFileKey(file))?.page ?? null
}

function remember(key: string, entry: CachedPage): void {
  const held = cache.get(key)
  // Why: reads may finish out of order; an older read must not replace a newer read's page.
  if (held && held.read > entry.read) {
    return
  }
  cache.delete(key)
  cache.set(key, entry)
  let chars = 0
  for (const cached of cache.values()) {
    chars += cached.page.html.length
  }
  for (const [oldestKey, oldest] of cache) {
    if (cache.size <= MAX_CACHED_PAGES && chars <= MAX_CACHED_CHARS) {
      break
    }
    cache.delete(oldestKey)
    chars -= oldest.page.html.length
  }
}

function forget(key: string, read: number): void {
  const held = cache.get(key)
  if (held && held.read < read) {
    cache.delete(key)
  }
}

async function readContent(file: NativeChatVisualFile): Promise<string> {
  if (file.target.kind === 'local') {
    const result = await window.api.fs.readFile({ filePath: file.path, access: chatVisualAccess() })
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return result.content
  }
  const result = await callRuntimeRpc<RuntimeHostPathFileReadResult>(
    file.target,
    'files.read',
    { path: file.path, access: chatVisualAccess() },
    { timeoutMs: READ_TIMEOUT_MS }
  )
  // Why refuse: a cut-off page would show as if whole; the host never truncates this kind anyway.
  if (result.truncated || typeof result.content !== 'string') {
    throw new Error('file_too_large')
  }
  return result.content
}

function failureReason(error: unknown): 'not_found' | 'refused' | 'unavailable' {
  if (isMissingRuntimePathError(error)) {
    return 'not_found'
  }
  const message = error instanceof Error ? error.message : ''
  if (
    isPathOutsideAllowedDirectoriesError(error) ||
    REFUSAL_MESSAGES.some((refusal) => message.includes(refusal))
  ) {
    return 'refused'
  }
  return 'unavailable'
}

async function readOnce(
  key: string,
  read: number,
  file: NativeChatVisualFile
): Promise<NativeChatVisualPathReadOutcome> {
  try {
    const page = { html: await readContent(file) }
    remember(key, { page, read })
    return { ok: true, page }
  } catch (error) {
    const reason = failureReason(error)
    // Why keep the cached page on `unavailable`: losing contact says nothing about the file.
    if (reason !== 'unavailable') {
      forget(key, read)
    }
    return { ok: false, reason }
  }
}

/**
 * Reads the visual's file. Visuals of the same file asking at once share one read, unless the
 * caller passes `startedAfter` (from {@link markNativeChatVisualReads}) and that read began earlier.
 */
export function readNativeChatVisualFile(
  file: NativeChatVisualFile,
  { startedAfter }: { startedAfter?: number } = {}
): Promise<NativeChatVisualPathReadOutcome> {
  const key = nativeChatVisualFileKey(file)
  const pending = inFlight.get(key)
  if (pending && (startedAfter === undefined || pending.read > startedAfter)) {
    return pending.outcome
  }
  reads += 1
  const read = reads
  const outcome = readOnce(key, read, file).finally(() => {
    if (inFlight.get(key)?.read === read) {
      inFlight.delete(key)
    }
  })
  inFlight.set(key, { read, outcome })
  return outcome
}

export function clearNativeChatVisualFileCacheForTests(): void {
  cache.clear()
  inFlight.clear()
}

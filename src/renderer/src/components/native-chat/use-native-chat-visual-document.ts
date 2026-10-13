import { useEffect, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  isRetryableNativeChatVisualFailure,
  peekCachedNativeChatVisual,
  readNativeChatVisual,
  type NativeChatVisualIdentity
} from './native-chat-visual-read-client'
import {
  peekNativeChatVisualFile,
  readNativeChatVisualFile,
  type NativeChatVisualFile,
  type NativeChatVisualPage
} from './native-chat-visual-path-read-client'

export type NativeChatVisualDocumentState =
  | { status: 'loading' }
  | { status: 'ready'; document: NativeChatVisualPage }
  | { status: 'unavailable' }

/**
 * Where a visual's page comes from: its file on the chat's host, read again after each
 * `freshAfter` mark; the older per-session endpoint; or neither yet (the route is still being
 * learned), which reads nothing but shows a page either reader already cached.
 */
export type NativeChatVisualSource =
  | { kind: 'file'; file: NativeChatVisualFile; freshAfter: number }
  | { kind: 'legacy'; identity: NativeChatVisualIdentity }
  | { kind: 'pending'; file: NativeChatVisualFile; identity: NativeChatVisualIdentity }

type ReadableNativeChatVisualSource = Exclude<NativeChatVisualSource, { kind: 'pending' }>

type VisualReadOutcome = { ok: true; page: NativeChatVisualPage } | { ok: false; reason: string }

/** Waits before each retry of a read that may yet succeed; bounded, then the failure shows. */
export const NATIVE_CHAT_VISUAL_RETRY_DELAYS_MS = [1_500, 4_000, 10_000] as const

function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!signal.aborted), ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve(false)
      },
      { once: true }
    )
  })
}

function peekSource(source: NativeChatVisualSource): NativeChatVisualPage | null {
  if (source.kind === 'file') {
    return peekNativeChatVisualFile(source.file)
  }
  if (source.kind === 'legacy') {
    return peekCachedNativeChatVisual(source.identity)
  }
  return peekNativeChatVisualFile(source.file) ?? peekCachedNativeChatVisual(source.identity)
}

async function readSource(source: ReadableNativeChatVisualSource): Promise<VisualReadOutcome> {
  if (source.kind === 'file') {
    return readNativeChatVisualFile(source.file, { startedAfter: source.freshAfter })
  }
  const outcome = await readNativeChatVisual(source.identity)
  return outcome.ok ? { ok: true, page: outcome.document } : outcome
}

function showPage(
  shown: NativeChatVisualDocumentState,
  page: NativeChatVisualPage
): NativeChatVisualDocumentState {
  // Why compare the text: an unchanged page keeps its frame, and what the reader did in it.
  return shown.status === 'ready' && shown.document.html === page.html
    ? shown
    : { status: 'ready', document: { html: page.html } }
}

async function loadWithRetries(
  source: ReadableNativeChatVisualSource,
  signal: AbortSignal,
  setState: (
    update: (shown: NativeChatVisualDocumentState) => NativeChatVisualDocumentState
  ) => void
): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    const outcome = await readSource(source)
    if (signal.aborted) {
      return
    }
    if (outcome.ok) {
      setState((shown) => showPage(shown, outcome.page))
      return
    }
    const delay = NATIVE_CHAT_VISUAL_RETRY_DELAYS_MS[retry]
    if (!isRetryableNativeChatVisualFailure(outcome.reason) || delay === undefined) {
      // Why keep a shown document on `unavailable`: losing contact says nothing about the file.
      setState((shown) =>
        shown.status === 'ready' && outcome.reason === 'unavailable'
          ? shown
          : { status: 'unavailable' }
      )
      return
    }
    if (!(await waitFor(delay, signal))) {
      return
    }
  }
}

/** The source the effect reads, rebuilt from its primitive parts; null while the route is pending. */
function readableSourceFromParts(
  kind: NativeChatVisualSource['kind'],
  environmentId: string | null,
  name: string,
  sessionId: string,
  freshAfter: number
): ReadableNativeChatVisualSource | null {
  const target: RuntimeClientTarget =
    environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
  if (kind === 'file') {
    return { kind, file: { target, path: name }, freshAfter }
  }
  return kind === 'legacy' ? { kind, identity: { target, sessionId, file: name } } : null
}

/**
 * The visual's current page. Starts from the cached copy when there is one, then reads once
 * `enabled`, and again whenever the source, its `freshAfter` mark or `refreshKey` changes. A page
 * that comes back unchanged keeps its frame, and a later failure keeps a page already shown.
 */
export function useNativeChatVisualDocument(
  source: NativeChatVisualSource,
  enabled: boolean,
  refreshKey?: unknown
): NativeChatVisualDocumentState {
  const [state, setState] = useState<NativeChatVisualDocumentState>(() => {
    const cached = peekSource(source)
    return cached ? { status: 'ready', document: cached } : { status: 'loading' }
  })
  const kind = source.kind
  const environmentId = targetEnvironmentId(
    source.kind === 'legacy' ? source.identity.target : source.file.target
  )
  const name = source.kind === 'legacy' ? source.identity.file : source.file.path
  const sessionId = source.kind === 'legacy' ? source.identity.sessionId : ''
  const freshAfter = source.kind === 'file' ? source.freshAfter : 0

  useEffect(() => {
    if (!enabled) {
      return
    }
    const sourceNow = readableSourceFromParts(kind, environmentId, name, sessionId, freshAfter)
    // Why keep the state on `pending`: the route is unknown, which says nothing about the page.
    if (sourceNow === null) {
      return
    }
    const abort = new AbortController()
    void loadWithRetries(sourceNow, abort.signal, setState)
    return () => abort.abort()
  }, [enabled, kind, environmentId, name, sessionId, freshAfter, refreshKey])

  return state
}

function targetEnvironmentId(target: RuntimeClientTarget): string | null {
  return target.kind === 'environment' ? target.environmentId : null
}

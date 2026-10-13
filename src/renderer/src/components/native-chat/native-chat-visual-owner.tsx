import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { FILES_HOST_PATH_RUNTIME_CAPABILITY } from '../../../../shared/runtime-file-contracts'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import {
  createNativeChatVisualRefresh,
  type NativeChatVisualRefresh
} from './native-chat-visual-refresh'

/** The structured chat a transcript belongs to: where its visuals are read and what owns them. */
export type NativeChatVisualOwner = {
  target: RuntimeClientTarget
  sessionId: string
  worktreeId: string
}

/**
 * How the chat's visuals are read: as files in its scratch folder on its host, through the older
 * per-session endpoint (a host without path reads or without a published folder), or not yet
 * known (the host has not said whether it reads by path).
 */
export type NativeChatVisualReadRoute =
  | { kind: 'file'; scratchDirectory: string }
  | { kind: 'legacy' }
  | { kind: 'pending' }

/** Kept apart from the owner so a change here re-renders a visual without remounting its frame. */
export type NativeChatVisualReading = {
  route: NativeChatVisualReadRoute
  refresh: NativeChatVisualRefresh
}

export const NativeChatVisualOwnerContext = createContext<NativeChatVisualOwner | null>(null)
export const NativeChatVisualReadingContext = createContext<NativeChatVisualReading | null>(null)

const LEGACY_ROUTE: NativeChatVisualReadRoute = { kind: 'legacy' }
const PENDING_ROUTE: NativeChatVisualReadRoute = { kind: 'pending' }

/** Null outside a structured chat's transcript, where no visual can be read. */
export function useNativeChatVisualOwner(): NativeChatVisualOwner | null {
  return useContext(NativeChatVisualOwnerContext)
}

/** Null outside a chat that knows its host's folder, where visuals keep the older endpoint. */
export function useNativeChatVisualReading(): NativeChatVisualReading | null {
  return useContext(NativeChatVisualReadingContext)
}

/** For the chat view that knows its turn state: a finished turn may have rewritten its visuals. */
export function useRefreshNativeChatVisualsWhenTurnEnds(isWorking: boolean): void {
  const reading = useContext(NativeChatVisualReadingContext)
  const wasWorking = useRef(isWorking)
  useEffect(() => {
    const finished = wasWorking.current && !isWorking
    wasWorking.current = isWorking
    if (finished) {
      reading?.refresh.refresh()
    }
  }, [isWorking, reading])
}

/** The chat's scratch folder as its host publishes it; null until then and from older hosts. */
function useNativeChatScratchDirectory(
  sessionId: string,
  target: RuntimeClientTarget
): string | null {
  const feed = useMemo(() => getStructuredAgentSessionStatusFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  return useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId)?.scratchDirectory ?? null,
    () => null
  )
}

function useNativeChatVisualReadRoute(
  sessionId: string,
  target: RuntimeClientTarget
): NativeChatVisualReadRoute {
  const scratchDirectory = useNativeChatScratchDirectory(sessionId, target)
  const hostPathFiles = useStructuredAgentSessionHostCapabilityState(
    target,
    FILES_HOST_PATH_RUNTIME_CAPABILITY
  )
  return useMemo(() => {
    if (scratchDirectory === null || hostPathFiles === 'unsupported') {
      return LEGACY_ROUTE
    }
    // Why wait on `unknown`: reading through the older endpoint first would read every visual twice.
    return hostPathFiles === 'supported' ? { kind: 'file', scratchDirectory } : PENDING_ROUTE
  }, [hostPathFiles, scratchDirectory])
}

/** Names the structured chat below it as the owner of the visuals its replies show. */
export function NativeChatVisualOwnerProvider({
  target,
  sessionId,
  tabId,
  children
}: {
  target: RuntimeClientTarget
  sessionId: string
  tabId: string
  children: ReactNode
}): React.JSX.Element {
  // Until the tab's workspace is known there is no workspace to open a visual's tab in.
  const worktreeId = useNativeChatTabOwnerWorktreeId(tabId)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  // The chat's recorded host, never its workspace's: two hosts can share a workspace id.
  const ownerTarget = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
  const owner = useMemo<NativeChatVisualOwner | null>(
    () => (worktreeId ? { target: ownerTarget, sessionId, worktreeId } : null),
    [ownerTarget, sessionId, worktreeId]
  )
  const route = useNativeChatVisualReadRoute(sessionId, ownerTarget)
  const refresh = useMemo(() => createNativeChatVisualRefresh(), [])
  useEffect(() => {
    if (environmentId === null) {
      return
    }
    // A host that answers again may hold files rewritten while it was out of reach.
    return subscribeRuntimeHostContactRegained(environmentId, refresh.refresh)
  }, [environmentId, refresh])
  const reading = useMemo<NativeChatVisualReading>(() => ({ route, refresh }), [route, refresh])
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      <NativeChatVisualReadingContext.Provider value={reading}>
        {children}
      </NativeChatVisualReadingContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}

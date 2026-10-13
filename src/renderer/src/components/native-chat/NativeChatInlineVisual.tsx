import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { NATIVE_CHAT_VISUAL_RESERVED_HEIGHT, NativeChatVisualFrame } from './NativeChatVisualFrame'
import { observeTranscriptVisibility } from './NativeChatTranscriptChrome'
import {
  useNativeChatVisualReading,
  type NativeChatVisualOwner,
  type NativeChatVisualReading
} from './native-chat-visual-owner'
import {
  useNativeChatVisualDocument,
  type NativeChatVisualSource
} from './use-native-chat-visual-document'
import { nativeChatVisualHostPath } from '../../../../shared/native-chat-visual-host-path'
import {
  markNativeChatVisualReads,
  type NativeChatVisualFile
} from './native-chat-visual-path-read-client'
import { useNativeChatVisualSavedMark } from './native-chat-visual-refresh'

const subscribeToNothing = (): (() => void) => () => {}
const noMark = (): number => 0

type NativeChatVisualHostFile =
  | Extract<NativeChatVisualSource, { kind: 'legacy' | 'pending' }>
  | { kind: 'file'; file: NativeChatVisualFile }

/** The visual's file on the chat's own host, or the older endpoint where the host has no folder. */
function useNativeChatVisualHostFile(
  owner: NativeChatVisualOwner,
  reading: NativeChatVisualReading | null,
  file: string
): NativeChatVisualHostFile {
  const route = reading?.route ?? null
  return useMemo(() => {
    const identity = { target: owner.target, sessionId: owner.sessionId, file }
    const path =
      route === null || route.kind === 'legacy'
        ? null
        : nativeChatVisualHostPath(route.scratchDirectory, file)
    if (route === null || path === null) {
      return { kind: 'legacy', identity }
    }
    const hostFile = { target: owner.target, path }
    return route.kind === 'pending'
      ? { kind: 'pending', file: hostFile, identity }
      : { kind: 'file', file: hostFile }
  }, [file, owner.sessionId, owner.target, route])
}

export function NativeChatVisualUnavailable(): React.JSX.Element {
  return (
    <p className="my-2 text-xs text-chat-foreground-faint">
      {translate('components.native-chat.visualUnavailable', 'Visualization unavailable')}
    </p>
  )
}

/**
 * A visual inside an assistant reply. Its frame mounts once the reply scrolls near it and stays
 * mounted, so what the reader did in it survives scrolling away and back.
 */
export function NativeChatInlineVisual({
  owner,
  file,
  title
}: {
  owner: NativeChatVisualOwner
  file: string
  title: string | null
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  const [revealedMark, setRevealedMark] = useState(0)
  const [retired, setRetired] = useState(false)
  const openChatVisualTab = useAppStore((state) => state.openChatVisualTab)
  const reading = useNativeChatVisualReading()
  const hostFile = useNativeChatVisualHostFile(owner, reading, file)
  const chatRefreshMark = useSyncExternalStore(
    reading?.refresh.subscribe ?? subscribeToNothing,
    reading?.refresh.mark ?? noMark,
    reading?.refresh.mark ?? noMark
  )
  const savedMark = useNativeChatVisualSavedMark(hostFile.kind === 'file' ? hostFile.file : null)
  // Marks only grow, so the largest is the latest trigger.
  const freshAfter = Math.max(chatRefreshMark, savedMark, revealedMark)
  const source = useMemo<NativeChatVisualSource>(
    () => (hostFile.kind === 'file' ? { ...hostFile, freshAfter } : hostFile),
    [freshAfter, hostFile]
  )
  const state = useNativeChatVisualDocument(source, near)
  const boxShown = !retired && state.status !== 'unavailable'

  useEffect(() => {
    const element = boxRef.current
    if (!element || !boxShown) {
      return
    }
    let seen = false
    let hidden = false
    return observeTranscriptVisibility(element, (visible) => {
      if (!visible) {
        hidden = seen
        return
      }
      setNear(true)
      // Brought back into view after being scrolled away or hidden: the file may have changed.
      if (hidden) {
        setRevealedMark(markNativeChatVisualReads())
      }
      seen = true
      hidden = false
    })
  }, [boxShown])

  if (!boxShown) {
    return <NativeChatVisualUnavailable />
  }
  const label = title ?? file
  const openLabel = translate('components.native-chat.visualOpenInNewTab', 'Open in new tab')

  return (
    <div ref={boxRef} className="group/visual relative my-3">
      {state.status === 'ready' && near ? (
        <>
          <NativeChatVisualFrame
            document={state.document}
            title={label}
            layout="inline"
            themeScope={boxRef}
            onRetired={() => setRetired(true)}
          />
          <div className="absolute top-2 right-2 transition-opacity can-hover:opacity-0 group-hover/visual:opacity-100 focus-within:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={openLabel}
                  onClick={() =>
                    openChatVisualTab(owner.worktreeId, {
                      target: owner.target,
                      sessionId: owner.sessionId,
                      file,
                      title
                    })
                  }
                >
                  <SquareArrowOutUpRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {openLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        </>
      ) : (
        <div
          role="status"
          aria-label={translate('components.native-chat.visualLoading', 'Loading visualization')}
          className="w-full rounded-md bg-muted/30"
          style={{ height: NATIVE_CHAT_VISUAL_RESERVED_HEIGHT }}
        />
      )}
    </div>
  )
}

// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const statusFeedFor = vi.fn()
let summaries = new Map<string, { scratchDirectory?: string }>()
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: (target: RuntimeClientTarget) => {
    statusFeedFor(target)
    return {
      activate: () => () => {},
      subscribe: () => () => {},
      getSnapshot: () => summaries
    }
  }
}))
const supports = vi.fn()
const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) => supports(...args),
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
const contactListeners = new Map<string, Set<() => void>>()
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    const listeners = contactListeners.get(environmentId) ?? new Set()
    listeners.add(listener)
    contactListeners.set(environmentId, listeners)
    return () => listeners.delete(listener)
  }
}))
function regainContact(environmentId: string): void {
  for (const listener of contactListeners.get(environmentId) ?? []) {
    listener()
  }
}
let tabWorktreeId: string | null = 'wt-1'
vi.mock('./use-native-chat-tab-owner', () => ({
  useNativeChatTabOwnerWorktreeId: () => tabWorktreeId
}))

import {
  NATIVE_CHAT_VISUAL_PROBE_WAIT_MS,
  NativeChatVisualOwnerProvider,
  useNativeChatVisualOwner,
  useNativeChatVisualReading,
  type NativeChatVisualOwner,
  type NativeChatVisualReading
} from './native-chat-visual-owner'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { clearNativeChatVisualCacheForTests } from './native-chat-visual-read-client'
import { clearNativeChatVisualFileCacheForTests } from './native-chat-visual-path-read-client'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const FOLDER = '/state/chat-scratch/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HOST: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-1' }

let seenOwner: NativeChatVisualOwner | null = null
let seenReading: NativeChatVisualReading | null = null
function Probe(): null {
  seenOwner = useNativeChatVisualOwner()
  seenReading = useNativeChatVisualReading()
  return null
}

function chat(target: RuntimeClientTarget): React.JSX.Element {
  return (
    <NativeChatVisualOwnerProvider target={target} sessionId="session-alpha" tabId="tab-1">
      <Probe />
    </NativeChatVisualOwnerProvider>
  )
}

const never = (): Promise<never> => new Promise(() => {})

// The transcript mounts a visual once it scrolls near; here every visual is in view at once.
class InViewObserver {
  constructor(private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
  observe(target: Element): void {
    this.callback([{ target, isIntersecting: true }])
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  summaries = new Map([['session-alpha', { scratchDirectory: FOLDER }]])
  supports.mockReset()
  supports.mockResolvedValue(true)
  callRuntimeRpc.mockReset()
  tabWorktreeId = 'wt-1'
  contactListeners.clear()
  statusFeedFor.mockReset()
  seenOwner = null
  seenReading = null
  // Unknown local capabilities: a local chat must not wait on them.
  setLocalRuntimeCapabilitiesForTests(null)
  vi.stubGlobal('api', { runtime: { getStatus: never } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('NativeChatVisualOwnerProvider', () => {
  it("reads visuals by path from the folder the chat's recorded host publishes", async () => {
    render(chat(HOST))
    await waitFor(() =>
      expect(seenReading?.route).toEqual({ kind: 'file', scratchDirectory: FOLDER })
    )
    expect(seenOwner?.target).toEqual(HOST)
    expect(statusFeedFor).toHaveBeenCalledWith(HOST)
    expect(supports).toHaveBeenCalledWith('env-1', 'files.host-path.v1')
  })

  it('waits while the probe runs, then uses the older endpoint once the wait is up', async () => {
    vi.useFakeTimers()
    supports.mockImplementation(never)
    render(chat(HOST))
    expect(seenReading?.route).toEqual({ kind: 'pending', scratchDirectory: FOLDER })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NATIVE_CHAT_VISUAL_PROBE_WAIT_MS - 1)
    })
    expect(seenReading?.route.kind).toBe('pending')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(seenReading?.route.kind).toBe('legacy')
  })

  it.each<[string, () => void]>([
    ['a probe that fails', () => supports.mockRejectedValue(new Error('timeout'))],
    ['a host without path reads', () => supports.mockResolvedValue(false)],
    ['a host that publishes no folder (older, or a WSL chat)', () => (summaries = new Map())]
  ])('uses the older endpoint for %s', async (_, arrange) => {
    arrange()
    render(chat(HOST))
    await waitFor(() => expect(seenReading?.route.kind).toBe('legacy'))
  })

  it('reads through the older endpoint, not a blank box, when the probe fails', async () => {
    supports.mockRejectedValue(new Error('runtime call queue overloaded'))
    callRuntimeRpc.mockResolvedValue({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>v</p>' })
    clearNativeChatVisualCacheForTests()
    clearNativeChatVisualFileCacheForTests()
    vi.stubGlobal('IntersectionObserver', InViewObserver)
    const { container } = render(
      <TooltipProvider>
        <NativeChatVisualOwnerProvider target={HOST} sessionId="session-alpha" tabId="tab-1">
          <NativeChatMarkdown content='::orca-visual{file="usage.html"}' visualMessageId="m1" />
        </NativeChatVisualOwnerProvider>
      </TooltipProvider>
    )
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      HOST,
      'agentSession.readVisual',
      { sessionId: 'session-alpha', file: 'usage.html' },
      { timeoutMs: 15_000 }
    )
  })

  it('a local chat reads by path at once, without waiting on any probe', () => {
    render(chat({ kind: 'local' }))
    expect(seenReading?.route).toEqual({ kind: 'file', scratchDirectory: FOLDER })
  })

  it('serves a floating chat, whose workspace is the floating one, the same way', () => {
    tabWorktreeId = FLOATING_TERMINAL_WORKTREE_ID
    render(chat({ kind: 'local' }))
    expect(seenOwner).toEqual({
      target: { kind: 'local' },
      sessionId: 'session-alpha',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })
    expect(seenReading?.route).toEqual({ kind: 'file', scratchDirectory: FOLDER })
  })

  it("refreshes the chat's visuals when its host answers again, and asks it again", async () => {
    render(chat(HOST))
    await waitFor(() => expect(supports).toHaveBeenCalledTimes(1))
    const listener = vi.fn()
    seenReading?.refresh.subscribe(listener)
    act(() => regainContact('env-1'))
    expect(listener).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(supports).toHaveBeenCalledTimes(2))
  })

  it('a local chat has no host to come back', () => {
    render(chat({ kind: 'local' }))
    expect([...contactListeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })

  it('keeps the owner when the route changes, so shown visuals are not remounted', async () => {
    let answer: (supported: boolean) => void = () => {}
    supports.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    render(chat(HOST))
    expect(seenReading?.route.kind).toBe('pending')
    const owner = seenOwner
    await act(async () => answer(true))
    expect(seenReading?.route.kind).toBe('file')
    expect(seenOwner).toBe(owner)
  })
})

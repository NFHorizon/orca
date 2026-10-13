// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'

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
let hostPathFiles: StructuredAgentSessionHostCapabilityState = 'supported'
const capabilityAskedOf = vi.fn()
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: (
    target: RuntimeClientTarget,
    capability: string
  ) => {
    capabilityAskedOf(target, capability)
    return hostPathFiles
  }
}))
const contactListeners = new Map<string, () => void>()
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    contactListeners.set(environmentId, listener)
    return () => contactListeners.delete(environmentId)
  }
}))
let tabWorktreeId: string | null = 'wt-1'
vi.mock('./use-native-chat-tab-owner', () => ({
  useNativeChatTabOwnerWorktreeId: () => tabWorktreeId
}))

import {
  NativeChatVisualOwnerProvider,
  useNativeChatVisualOwner,
  useNativeChatVisualReading,
  type NativeChatVisualOwner,
  type NativeChatVisualReading
} from './native-chat-visual-owner'
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

beforeEach(() => {
  summaries = new Map([['session-alpha', { scratchDirectory: FOLDER }]])
  hostPathFiles = 'supported'
  tabWorktreeId = 'wt-1'
  contactListeners.clear()
  statusFeedFor.mockReset()
  capabilityAskedOf.mockReset()
  seenOwner = null
  seenReading = null
})

afterEach(() => {
  cleanup()
})

describe('NativeChatVisualOwnerProvider', () => {
  it("reads visuals by path from the folder the chat's recorded host publishes", () => {
    render(chat(HOST))
    expect(seenOwner?.target).toEqual(HOST)
    expect(seenReading?.route).toEqual({ kind: 'file', scratchDirectory: FOLDER })
    expect(statusFeedFor).toHaveBeenCalledWith(HOST)
    expect(capabilityAskedOf).toHaveBeenCalledWith(HOST, 'files.host-path.v1')
  })

  it.each<[string, () => void, NativeChatVisualReading['route']['kind']]>([
    [
      'a host that reads files by path but has not said so yet',
      () => (hostPathFiles = 'unknown'),
      'pending'
    ],
    ['a host without path reads', () => (hostPathFiles = 'unsupported'), 'legacy'],
    [
      'a host that publishes no folder (older, or a WSL chat)',
      () => (summaries = new Map()),
      'legacy'
    ]
  ])('routes %s', (_, arrange, kind) => {
    arrange()
    render(chat(HOST))
    expect(seenReading?.route.kind).toBe(kind)
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

  it("refreshes the chat's visuals when its host answers again", () => {
    render(chat(HOST))
    const listener = vi.fn()
    seenReading?.refresh.subscribe(listener)
    act(() => contactListeners.get('env-1')?.())
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a local chat has no host to come back', () => {
    render(chat({ kind: 'local' }))
    expect(contactListeners.size).toBe(0)
  })

  it('keeps the owner when the route changes, so shown visuals are not remounted', () => {
    hostPathFiles = 'unknown'
    const view = render(chat(HOST))
    const owner = seenOwner
    hostPathFiles = 'supported'
    view.rerender(chat({ kind: 'environment', environmentId: 'env-1' }))
    expect(seenReading?.route.kind).toBe('file')
    expect(seenOwner).toBe(owner)
  })
})

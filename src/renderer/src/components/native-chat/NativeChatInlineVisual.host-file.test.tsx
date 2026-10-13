// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn()
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

import { NativeChatMarkdown } from './NativeChatMarkdown'
import {
  NativeChatVisualOwnerContext,
  NativeChatVisualReadingContext,
  useRefreshNativeChatVisualsWhenTurnEnds,
  type NativeChatVisualOwner,
  type NativeChatVisualReadRoute,
  type NativeChatVisualReading
} from './native-chat-visual-owner'
import { createNativeChatVisualRefresh } from './native-chat-visual-refresh'
import { clearNativeChatVisualCacheForTests } from './native-chat-visual-read-client'
import { clearNativeChatVisualFileCacheForTests } from './native-chat-visual-path-read-client'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/editor-autosave'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const LOCAL_FOLDER = '/state/chat-scratch/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const WINDOWS_FOLDER = 'C:\\orca\\chat-scratch\\bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const LINE = '::orca-visual{file="usage.html" title="Usage"}'
const LOCAL_PATH = `${LOCAL_FOLDER}/usage.html`

const readFile = vi.fn()

// Every visual reports itself in view; `setVisible` scrolls them away and back.
const observed = new Map<Element, (entries: Partial<IntersectionObserverEntry>[]) => void>()
class ControlledObserver {
  constructor(private readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {}
  observe(target: Element): void {
    observed.set(target, this.callback)
    this.callback([{ target, isIntersecting: true }])
  }
  unobserve(target: Element): void {
    observed.delete(target)
  }
  disconnect(): void {}
}
function setVisible(isIntersecting: boolean): void {
  act(() => {
    for (const [target, callback] of observed) {
      callback([{ target, isIntersecting }])
    }
  })
}

// One owner per host, as the provider memoizes it: a new owner would remount the reply's visuals.
const owners = new Map<string, NativeChatVisualOwner>()
function owner(target: RuntimeClientTarget): NativeChatVisualOwner {
  const key = JSON.stringify(target)
  const held = owners.get(key) ?? {
    target,
    sessionId: 'session-alpha',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID
  }
  owners.set(key, held)
  return held
}

function TurnState({ working }: { working: boolean }): null {
  useRefreshNativeChatVisualsWhenTurnEnds(working)
  return null
}

function chat(
  target: RuntimeClientTarget,
  reading: NativeChatVisualReading | null,
  extra: ReactNode = null
): ReactNode {
  const chatOwner = owner(target)
  return (
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={chatOwner}>
        <NativeChatVisualReadingContext.Provider value={reading}>
          <NativeChatMarkdown content={LINE} visualMessageId="m1" />
          {extra}
        </NativeChatVisualReadingContext.Provider>
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )
}

function reading(route: NativeChatVisualReadRoute): NativeChatVisualReading {
  return { route, refresh: createNativeChatVisualRefresh() }
}

const fileRoute = (scratchDirectory: string): NativeChatVisualReadRoute => ({
  kind: 'file',
  scratchDirectory
})

function localPage(html: string): { content: string; isBinary: boolean } {
  return { content: html, isBinary: false }
}

function frameSource(container: HTMLElement): string {
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
}

beforeEach(() => {
  observed.clear()
  vi.stubGlobal('IntersectionObserver', ControlledObserver)
  vi.stubGlobal('api', { fs: { readFile } })
  clearNativeChatVisualCacheForTests()
  clearNativeChatVisualFileCacheForTests()
  callRuntimeRpc.mockReset()
  readFile.mockReset()
  readFile.mockResolvedValue(localPage('<p>first</p>'))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('inline visuals read as files on the chat host', () => {
  it("reads a local chat's visual from its scratch folder with the chat-visual kind", async () => {
    const { container } = render(chat({ kind: 'local' }, reading(fileRoute(LOCAL_FOLDER))))
    await waitFor(() => expect(frameSource(container)).toContain('<p>first</p>'))
    expect(readFile).toHaveBeenCalledWith({ filePath: LOCAL_PATH, access: { kind: 'chat-visual' } })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it("reads a host chat's visual on that host, joined in the host's own path syntax", async () => {
    callRuntimeRpc.mockResolvedValue({ path: 'p', content: '<p>h</p>', truncated: false })
    const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-ssh' }
    const { container } = render(chat(target, reading(fileRoute(WINDOWS_FOLDER))))
    await waitFor(() => expect(frameSource(container)).toContain('<p>h</p>'))
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      target,
      'files.read',
      { path: `${WINDOWS_FOLDER}\\usage.html`, access: { kind: 'chat-visual' } },
      { timeoutMs: 15_000 }
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it.each([
    ['an older host', reading({ kind: 'legacy' })],
    ['no published folder', null]
  ])('keeps the per-session reader for %s', async (_, value) => {
    callRuntimeRpc.mockResolvedValue({ ok: true, revision: 'r1', sizeBytes: 3, html: '<p>old</p>' })
    const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-old' }
    const { container } = render(chat(target, value))
    await waitFor(() => expect(frameSource(container)).toContain('<p>old</p>'))
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      target,
      'agentSession.readVisual',
      { sessionId: 'session-alpha', file: 'usage.html' },
      { timeoutMs: 15_000 }
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reads nothing while the host has not said how it reads files', async () => {
    const { container } = render(chat({ kind: 'local' }, reading({ kind: 'pending' })))
    await Promise.resolve()
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('shows a rewritten file when the turn ends, and keeps the frame when nothing changed', async () => {
    const value = reading(fileRoute(LOCAL_FOLDER))
    const view = render(chat({ kind: 'local' }, value, <TurnState working />))
    await waitFor(() => expect(frameSource(view.container)).toContain('<p>first</p>'))
    const frame = view.container.querySelector('iframe')

    view.rerender(chat({ kind: 'local' }, value, <TurnState working={false} />))
    await waitFor(() => expect(readFile).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(view.container.querySelector('iframe')).toBe(frame)

    readFile.mockResolvedValue(localPage('<p>second</p>'))
    view.rerender(chat({ kind: 'local' }, value, <TurnState working />))
    view.rerender(chat({ kind: 'local' }, value, <TurnState working={false} />))
    await waitFor(() => expect(frameSource(view.container)).toContain('<p>second</p>'))
  })

  it('reads again when the host comes back, and keeps the page while it is out of reach', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ path: 'p', content: '<p>h</p>', truncated: false })
    const value = reading(fileRoute(LOCAL_FOLDER))
    const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-1' }
    const { container } = render(chat(target, value))
    await waitFor(() => expect(frameSource(container)).toContain('<p>h</p>'))

    vi.useFakeTimers()
    try {
      callRuntimeRpc.mockRejectedValue(new Error('timeout'))
      act(() => value.refresh.refresh())
      // Through every bounded retry: losing contact never blanks a shown page.
      for (let step = 0; step < 4; step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000)
        })
      }
      expect(callRuntimeRpc).toHaveBeenCalledTimes(5)
      expect(frameSource(container)).toContain('<p>h</p>')
      expect(container).not.toHaveTextContent('Visualization unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads again when it scrolls back into view after being hidden', async () => {
    const { container } = render(chat({ kind: 'local' }, reading(fileRoute(LOCAL_FOLDER))))
    await waitFor(() => expect(frameSource(container)).toContain('<p>first</p>'))
    readFile.mockResolvedValue(localPage('<p>revealed</p>'))
    setVisible(false)
    setVisible(true)
    await waitFor(() => expect(frameSource(container)).toContain('<p>revealed</p>'))
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("reads again when the Orca editor saves this visual's file, and only that file", async () => {
    const openFiles = useAppStore.getState().openFiles
    const editorFile = (id: string, filePath: string): OpenFile => ({
      id,
      filePath,
      relativePath: filePath,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      language: 'html',
      isDirty: false,
      mode: 'edit'
    })
    useAppStore.setState({
      openFiles: [
        editorFile('visual', LOCAL_PATH),
        editorFile('other', `${LOCAL_FOLDER}/other.html`),
        { ...editorFile('remote', LOCAL_PATH), runtimeEnvironmentId: 'env-1' }
      ]
    })
    const save = (fileId: string): void => {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(ORCA_EDITOR_FILE_SAVED_EVENT, { detail: { fileId, content: '' } })
        )
      })
    }
    try {
      const { container } = render(chat({ kind: 'local' }, reading(fileRoute(LOCAL_FOLDER))))
      await waitFor(() => expect(frameSource(container)).toContain('<p>first</p>'))
      save('other')
      save('remote')
      await Promise.resolve()
      expect(readFile).toHaveBeenCalledTimes(1)

      readFile.mockResolvedValue(localPage('<p>saved</p>'))
      save('visual')
      await waitFor(() => expect(frameSource(container)).toContain('<p>saved</p>'))
      expect(readFile).toHaveBeenCalledTimes(2)
    } finally {
      useAppStore.setState({ openFiles })
    }
  })

  it('shows one muted line when the host refuses the file', async () => {
    readFile.mockRejectedValue(new Error('binary_file'))
    const { container } = render(chat({ kind: 'local' }, reading(fileRoute(LOCAL_FOLDER))))
    await waitFor(() => expect(container).toHaveTextContent('Visualization unavailable'))
    expect(container.querySelector('iframe')).toBeNull()
  })
})

// When a chat visual reads its file again: the triggers after which the file may have changed.
// Nothing here watches the file; a rewrite shows at the next trigger.

import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/editor-autosave'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  markNativeChatVisualReads,
  nativeChatVisualHostKey,
  type NativeChatVisualFile
} from './native-chat-visual-path-read-client'

/** One chat's refreshes (a turn ended, its host came back), as the read mark each was taken at. */
export type NativeChatVisualRefresh = {
  /** The read mark of the latest refresh; 0 before any. */
  mark: () => number
  subscribe: (listener: () => void) => () => void
  refresh: () => void
}

export function createNativeChatVisualRefresh(): NativeChatVisualRefresh {
  let mark = 0
  const listeners = new Set<() => void>()
  return {
    mark: () => mark,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh: () => {
      mark = markNativeChatVisualReads()
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

/** Whether the editor file `fileId` is this visual's file: the same host and the same path. */
export function editorFileIsNativeChatVisual(
  state: WorktreeOperationRouteState & { openFiles: OpenFile[] },
  fileId: string,
  visual: NativeChatVisualFile
): boolean {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  // Why not an external SSH file: it lives on a host this chat's target does not name.
  if (!file || file.externalSshTargetId?.trim()) {
    return false
  }
  const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  return (
    target !== null &&
    nativeChatVisualHostKey(target) === nativeChatVisualHostKey(visual.target) &&
    normalizeRuntimePathForComparison(file.filePath) ===
      normalizeRuntimePathForComparison(visual.path)
  )
}

function savedFileId(event: Event): string | null {
  if (!(event instanceof CustomEvent)) {
    return null
  }
  const detail: unknown = event.detail
  return typeof detail === 'object' &&
    detail !== null &&
    'fileId' in detail &&
    typeof detail.fileId === 'string'
    ? detail.fileId
    : null
}

/** The read mark at the latest Orca editor save of this visual's file; 0 before any. */
export function useNativeChatVisualSavedMark(file: NativeChatVisualFile | null): number {
  const [mark, setMark] = useState(0)
  const environmentId = file?.target.kind === 'environment' ? file.target.environmentId : null
  const path = file?.path ?? null
  useEffect(() => {
    if (path === null) {
      return
    }
    const visual: NativeChatVisualFile = {
      target: environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
      path
    }
    const onSaved = (event: Event): void => {
      const fileId = savedFileId(event)
      if (fileId && editorFileIsNativeChatVisual(useAppStore.getState(), fileId, visual)) {
        setMark(markNativeChatVisualReads())
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
    return () => window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
  }, [environmentId, path])
  return mark
}

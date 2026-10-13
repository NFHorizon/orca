import { describe, expect, it } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { buildEditorSessionData } from '@/lib/workspace-session'
import { persistedOpenFileSchema } from '../../../../shared/workspace-session-editor-schema'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '../types'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'

// A host file outside every workspace, addressed on its owner host by absolute path.
const HOST_FILE = '/home/me/state/ab12/report.md'

// The owner captured when the link was identified: the host that serves the path.
function hostProvenance(runtimeEnvironmentId: string): EditorFileOperationProvenance {
  return {
    ownershipProjection: 'explicit',
    generation: {
      route: { runtimeEnvironmentId, executionHostId: `runtime:${runtimeEnvironmentId}` },
      runtimeConnectionGeneration: 1,
      runtimePairingRevision: 1,
      runtimeSshGeneration: null,
      nestedSshGeneration: null,
      directSshGeneration: null
    }
  }
}

function openHostFile(store: StoreApi<AppState>, runtimeEnvironmentId: string): void {
  store.getState().openFile(
    {
      filePath: HOST_FILE,
      relativePath: HOST_FILE,
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit',
      runtimeEnvironmentId,
      operationProvenance: hostProvenance(runtimeEnvironmentId)
    },
    { forceContentReload: true }
  )
}

describe('editor tabs for files a host serves by path', () => {
  it('keeps the same absolute path on two hosts as two editable tabs', () => {
    const store = createEditorTabsStore()
    openHostFile(store, 'env-a')
    openHostFile(store, 'env-b')

    const files = store.getState().openFiles
    expect(files.map((file) => [file.filePath, file.runtimeEnvironmentId])).toEqual([
      [HOST_FILE, 'env-a'],
      [HOST_FILE, 'env-b']
    ])
    expect(new Set(files.map((file) => file.id)).size).toBe(2)
    expect(files.every((file) => file.readOnly === undefined)).toBe(true)
  })

  it('persists and restores owner and path with no new session fields', () => {
    const store = createEditorTabsStore()
    openHostFile(store, 'env-a')
    openHostFile(store, 'env-b')

    const session = buildEditorSessionData(store.getState().openFiles, {}, {}, {}, {})
    const persisted = session.openFilesByWorktree?.['wt-1'] ?? []
    expect(persisted).toEqual([
      expect.objectContaining({
        filePath: HOST_FILE,
        relativePath: HOST_FILE,
        runtimeEnvironmentId: 'env-a'
      }),
      expect.objectContaining({
        filePath: HOST_FILE,
        relativePath: HOST_FILE,
        runtimeEnvironmentId: 'env-b'
      })
    ])
    // The existing persisted shape carries it; older builds read the same rows.
    for (const row of persisted) {
      expect(persistedOpenFileSchema.strict().parse(row)).toEqual(row)
      expect(row).not.toHaveProperty('readOnly')
    }

    const restored = createEditorTabsStore()
    restored.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...session
    })

    expect(
      restored
        .getState()
        .openFiles.map((file) => [file.filePath, file.relativePath, file.runtimeEnvironmentId])
    ).toEqual([
      [HOST_FILE, HOST_FILE, 'env-a'],
      [HOST_FILE, HOST_FILE, 'env-b']
    ])
    expect(new Set(restored.getState().openFiles.map((file) => file.id)).size).toBe(2)
  })
})

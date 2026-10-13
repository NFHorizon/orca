import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  createCurrentEditorArtifactRequest,
  createEditorArtifactRequest,
  editorArtifactContentType,
  editorArtifactSourceKey
} from './editor-artifact-upload'
import { fileArtifactSourceKey } from '@/lib/file-artifact-source-key'

const mocks = vi.hoisted(() => ({
  drafts: {} as Record<string, string>,
  flush: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ editorDrafts: mocks.drafts }) }
}))
vi.mock('./editor-pending-flush', () => ({
  flushPendingEditorChange: mocks.flush
}))

beforeEach(() => {
  mocks.drafts = {}
  mocks.flush.mockReset()
})

function openFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/notes.md',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId: 'worktree-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('Editor artifact upload', () => {
  it('uses the ordinary file path for local and folder workspaces', () => {
    expect(editorArtifactSourceKey(openFile())).toBe('/repo/notes.md')
    expect(createEditorArtifactRequest(openFile(), '# Draft', 'text/markdown')).toEqual({
      sourceKey: '/repo/notes.md',
      content: '# Draft',
      contentType: 'text/markdown',
      fileName: 'notes.md'
    })
  })

  it('isolates source identity by runtime owner', () => {
    const file = openFile({
      runtimeEnvironmentId: 'server-1',
      operationProvenance: {
        ownershipProjection: 'explicit',
        generation: {
          route: {
            runtimeEnvironmentId: 'server-1',
            executionHostId: 'ssh:build-box'
          },
          runtimeConnectionGeneration: 1,
          runtimePairingRevision: 1,
          runtimeSshGeneration: 1,
          nestedSshGeneration: 1,
          directSshGeneration: null
        }
      }
    })
    expect(JSON.parse(editorArtifactSourceKey(file))).toEqual([
      'ssh',
      'build-box',
      '/repo/notes.md'
    ])
  })

  it('keys a host file served by path by its owner and absolute path', () => {
    const hostFile = (environmentId: string, filePath: string) =>
      openFile({
        id: `editor:wt-feat:${environmentId}:${filePath}`,
        filePath,
        relativePath: filePath,
        worktreeId: 'wt-feat',
        runtimeEnvironmentId: environmentId,
        operationProvenance: {
          ownershipProjection: 'explicit',
          generation: {
            route: {
              runtimeEnvironmentId: environmentId,
              executionHostId: `runtime:${environmentId}`
            },
            runtimeConnectionGeneration: 1,
            runtimePairingRevision: 1,
            runtimeSshGeneration: null,
            nestedSshGeneration: null,
            directSshGeneration: null
          }
        }
      })
    const path = '/home/me/state/ab12/report.md'
    const windowsPath = 'C:/Users/me/state/ab12/report.md'

    expect(editorArtifactSourceKey(hostFile('env-a', path))).toBe(
      fileArtifactSourceKey({ executionHostId: 'runtime:env-a', runtimeEnvironmentId: 'env-a' }, path)
    )
    // The same path on another host is another file.
    expect(editorArtifactSourceKey(hostFile('env-b', path))).not.toBe(
      editorArtifactSourceKey(hostFile('env-a', path))
    )
    expect(JSON.parse(editorArtifactSourceKey(hostFile('env-a', windowsPath)))).toEqual([
      'editor',
      'env-a',
      'runtime:env-a',
      'C:\\Users\\me\\state\\ab12\\report.md'
    ])
  })

  it('matches the SSH CLI source identity for external files', () => {
    expect(
      JSON.parse(editorArtifactSourceKey(openFile({ externalSshTargetId: 'build-box' })))
    ).toEqual(['ssh', 'build-box', '/repo/notes.md'])
  })

  it('flushes and reads the latest unsaved editor buffer', () => {
    mocks.flush.mockImplementation((fileId: string) => {
      mocks.drafts[fileId] = '# Latest edit'
    })

    expect(
      createCurrentEditorArtifactRequest(
        openFile(),
        '/repo/notes.md',
        '# Stale content',
        'text/markdown'
      ).content
    ).toBe('# Latest edit')
    expect(mocks.flush).toHaveBeenCalledWith('/repo/notes.md')
  })

  it('shares Markdown and HTML documents only', () => {
    expect(editorArtifactContentType('/repo/notes.md', true)).toBe('text/markdown')
    expect(editorArtifactContentType('/repo/report.html', false)).toBe('text/html')
    expect(editorArtifactContentType('/repo/REPORT.HTM', false)).toBe('text/html')
    // Why: JSP highlights as HTML but is not a page a share link can render.
    expect(editorArtifactContentType('/repo/index.jsp', false)).toBeNull()
    expect(editorArtifactContentType('/repo/main.ts', false)).toBeNull()
  })
})

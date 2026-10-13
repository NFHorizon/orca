import { describe, expect, it } from 'vitest'
import { compile, z, type ZodType } from 'zod'
import { FileOpen, MIXED_FILE_TARGET_MESSAGE } from './files-target-params'
import { RPC_PARAMS_BY_METHOD } from './rpc-params-catalog.generated'

// The schema `files.readDocPreview` had before the host-path form, as older hosts still parse it.
const LEGACY_DOC_PREVIEW_READ = FileOpen.extend({
  entryRelativePath: z.string().min(1),
  implicitRootRelativePath: z.string().nullable(),
  authorizedRootRelativePaths: z.array(z.string())
})

const WORKSPACE_REQUEST = {
  worktree: 'id:wt-1',
  relativePath: 'docs/style.css',
  entryRelativePath: 'docs/index.html',
  implicitRootRelativePath: 'docs',
  authorizedRootRelativePaths: ['assets']
}

const HOST_PATH_REQUEST = {
  path: '/srv/scratch/0123/style.css',
  boundaryPath: '/srv/scratch/0123',
  entryPath: '/srv/scratch/0123/index.html',
  implicitRootPath: null,
  authorizedRootPaths: ['/srv/scratch/0123/assets']
}

// Why compiled too: the dispatcher parses through zod's compiled schema, not the declared one.
function parsers(): ZodType[] {
  const schema: ZodType = RPC_PARAMS_BY_METHOD['files.readDocPreview']
  return [schema, compile(schema)]
}

function firstMessage(schema: ZodType, params: unknown): string | null {
  const result = schema.safeParse(params)
  return result.success ? null : (result.error.issues[0]?.message ?? 'invalid')
}

describe('files.readDocPreview target', () => {
  it('accepts the workspace form unchanged', () => {
    for (const schema of parsers()) {
      expect(schema.parse(WORKSPACE_REQUEST)).toEqual(WORKSPACE_REQUEST)
    }
  })

  it('accepts absolute host paths, with or without a user-file access', () => {
    const windows = {
      path: 'C:\\notes\\index.html',
      access: { kind: 'user-file' },
      boundaryPath: 'C:\\notes',
      entryPath: 'C:\\notes\\index.html',
      implicitRootPath: 'C:\\notes\\docs',
      authorizedRootPaths: []
    }
    for (const schema of parsers()) {
      expect(schema.parse(HOST_PATH_REQUEST)).toEqual(HOST_PATH_REQUEST)
      expect(schema.parse(windows)).toEqual(windows)
    }
  })

  it.each([
    [{ ...WORKSPACE_REQUEST, path: '/srv/a.html' }],
    [{ ...HOST_PATH_REQUEST, worktree: 'id:wt-1' }],
    [{ ...HOST_PATH_REQUEST, relativePath: 'docs/index.html' }],
    [{ ...WORKSPACE_REQUEST, access: { kind: 'user-file' } }]
  ])('refuses a request naming both forms: %j', (request) => {
    for (const schema of parsers()) {
      expect(firstMessage(schema, request)).toBe(MIXED_FILE_TARGET_MESSAGE)
    }
  })

  it.each([
    [{}],
    [{ worktree: 'id:wt-1' }],
    [{ ...WORKSPACE_REQUEST, entryRelativePath: '' }],
    [{ ...WORKSPACE_REQUEST, implicitRootRelativePath: undefined }],
    [{ ...WORKSPACE_REQUEST, authorizedRootRelativePaths: 'assets' }]
  ])('refuses an incomplete workspace request %j with the error older clients get', (request) => {
    const expected = firstMessage(LEGACY_DOC_PREVIEW_READ, request)
    expect(expected).not.toBeNull()
    for (const schema of parsers()) {
      expect(firstMessage(schema, request)).toBe(expected)
    }
  })

  it.each([
    [{ ...HOST_PATH_REQUEST, path: '' }, 'Missing path'],
    [{ ...HOST_PATH_REQUEST, boundaryPath: undefined }, 'Missing boundary path'],
    [{ ...HOST_PATH_REQUEST, entryPath: '' }, 'Missing entry path'],
    [
      { ...HOST_PATH_REQUEST, entryRelativePath: 'index.html', entryPath: undefined },
      'Missing entry path'
    ]
  ])('refuses an incomplete host-path request %j', (request, message) => {
    for (const schema of parsers()) {
      expect(firstMessage(schema, request)).toBe(message)
    }
  })

  it.each([
    [{ ...HOST_PATH_REQUEST, implicitRootPath: undefined }],
    [{ ...HOST_PATH_REQUEST, authorizedRootPaths: undefined }],
    [{ ...HOST_PATH_REQUEST, authorizedRootPaths: [7] }]
  ])('requires the host-path form’s authority fields: %j', (request) => {
    for (const schema of parsers()) {
      expect(firstMessage(schema, request)).not.toBeNull()
    }
  })

  it.each([
    { kind: 'chat-visual' },
    { kind: 'chat-image' },
    { kind: 'document-resource', documentPath: '/srv/doc.html' },
    'user-file'
  ])('refuses access %j', (access) => {
    for (const schema of parsers()) {
      expect(firstMessage(schema, { ...HOST_PATH_REQUEST, access })).not.toBeNull()
    }
  })

  it('an older host refuses the host-path form as a missing worktree', () => {
    expect(firstMessage(LEGACY_DOC_PREVIEW_READ, HOST_PATH_REQUEST)).toBe(
      'Missing worktree selector'
    )
  })
})

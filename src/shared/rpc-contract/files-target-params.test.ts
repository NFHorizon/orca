import { describe, expect, it } from 'vitest'
import { compile, type ZodType } from 'zod'
import { FileTreePath } from './files-params'
import { FileOpen, MIXED_FILE_TARGET_MESSAGE } from './files-target-params'
import { RPC_PARAMS_BY_METHOD } from './rpc-params-catalog.generated'

const METHODS = [
  'files.read',
  'files.readPreview',
  'files.stat',
  'files.readChunk',
  'files.write'
] as const
type HostPathMethod = (typeof METHODS)[number]

// Each method's own fields, so a request is complete apart from its target.
const METHOD_FIELDS: Record<HostPathMethod, Record<string, unknown>> = {
  'files.read': {},
  'files.readPreview': {},
  'files.stat': {},
  'files.readChunk': { offset: 0, length: 16 },
  'files.write': { content: 'saved', expectedExecutionHostId: 'local' }
}

// Why compiled too: the dispatcher parses through zod's compiled schema, not the declared one.
function parsers(method: HostPathMethod): ZodType[] {
  const schema: ZodType = RPC_PARAMS_BY_METHOD[method]
  return [schema, compile(schema)]
}

function firstMessage(schema: ZodType, params: unknown): string | null {
  const result = schema.safeParse(params)
  return result.success ? null : (result.error.issues[0]?.message ?? 'invalid')
}

describe.each(METHODS)('%s target', (method) => {
  const fields = METHOD_FIELDS[method]

  it('accepts the workspace form unchanged', () => {
    for (const schema of parsers(method)) {
      expect(schema.parse({ worktree: 'id:wt-1', relativePath: 'src/a.ts', ...fields })).toEqual({
        worktree: 'id:wt-1',
        relativePath: 'src/a.ts',
        ...fields
      })
    }
  })

  it('accepts an absolute host path, with or without a user-file access', () => {
    for (const schema of parsers(method)) {
      expect(schema.parse({ path: '/srv/notes/a.md', ...fields })).toEqual({
        path: '/srv/notes/a.md',
        ...fields
      })
      expect(
        schema.parse({ path: 'C:\\notes\\a.md', access: { kind: 'user-file' }, ...fields })
      ).toEqual({ path: 'C:\\notes\\a.md', access: { kind: 'user-file' }, ...fields })
    }
  })

  it.each([
    [{ worktree: 'id:wt-1', relativePath: 'a.md', path: '/srv/a.md' }],
    [{ worktree: 'id:wt-1', path: '/srv/a.md' }],
    [{ relativePath: 'a.md', path: '/srv/a.md' }],
    [{ worktree: 'id:wt-1', relativePath: 'a.md', access: { kind: 'user-file' } }]
  ])('refuses a request naming both forms: %j', (target) => {
    for (const schema of parsers(method)) {
      expect(firstMessage(schema, { ...target, ...fields })).toBe(MIXED_FILE_TARGET_MESSAGE)
    }
  })

  it.each([[{}], [{ worktree: 'id:wt-1' }], [{ relativePath: 'a.md' }], [{ worktree: 5 }]])(
    'refuses an incomplete workspace target %j with the error older clients get',
    (target) => {
      const workspaceForm = method === 'files.stat' ? FileTreePath : FileOpen
      const expected = firstMessage(workspaceForm, target)
      expect(expected).not.toBeNull()
      for (const schema of parsers(method)) {
        expect(firstMessage(schema, { ...target, ...fields })).toBe(expected)
      }
    }
  )

  it.each([
    [{ path: '' }, 'Missing path'],
    [{ path: 42 }, 'Missing path'],
    [{ access: { kind: 'user-file' } }, 'Missing path']
  ])('refuses an incomplete host path %j', (target, message) => {
    for (const schema of parsers(method)) {
      expect(firstMessage(schema, { ...target, ...fields })).toBe(message)
    }
  })

  it.each([
    { kind: 'chat-image' },
    { kind: 'document-resource', documentPath: '/srv/doc.md' },
    { kind: 'document-folder', documentPath: '/srv/doc.md' },
    { kind: 'grant-everything' },
    'user-file'
  ])('refuses access %j on a host path', (access) => {
    for (const schema of parsers(method)) {
      expect(firstMessage(schema, { path: '/srv/a.md', access, ...fields })).not.toBeNull()
    }
  })
})

describe('method fields keep their meaning on the host-path form', () => {
  it('still requires a chunk range and write content', () => {
    for (const schema of parsers('files.readChunk')) {
      expect(firstMessage(schema, { path: '/srv/a.bin' })).not.toBeNull()
      expect(firstMessage(schema, { path: '/srv/a.bin', offset: 0, length: 1024 * 1024 })).not.toBe(
        null
      )
    }
    for (const schema of parsers('files.write')) {
      expect(firstMessage(schema, { path: '/srv/a.md' })).toBe('Missing file content')
      expect(firstMessage(schema, { path: '/srv/a.md', content: '' })).toBeNull()
    }
  })
})

describe('mixed versions', () => {
  it('an older host refuses the host-path form as a missing worktree', () => {
    // The pre-host-path `files.read` / `readPreview` / `readChunk` / `write` schemas all start
    // from FileOpen; `files.stat` from the same worktree selector.
    expect(firstMessage(FileOpen, { path: '/srv/a.md' })).toBe('Missing worktree selector')
  })
})

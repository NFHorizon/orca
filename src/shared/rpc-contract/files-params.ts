import { PATH_EXISTENCE_BATCH_MAX } from '../path-existence-batch'
import { z } from 'zod'
import { QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS } from '../quick-open-path-search'
import { RUNTIME_NAVIGATION_TARGETS } from '../runtime-navigation'
import {
  FileOpen,
  HostPathReadTarget,
  HostPathTarget,
  WorktreeSelector,
  workspaceOrHostPathTarget
} from './files-target-params'

export const FilePathsExist = WorktreeSelector.extend({
  relativePaths: z.array(z.string()).max(PATH_EXISTENCE_BATCH_MAX)
})

export const FilePathSearch = WorktreeSelector.extend({
  allowLegacyIncludeIgnored: z.boolean().optional(),
  includeIgnored: z.boolean().optional(),
  followSymlinks: z.boolean().optional(),
  query: z.string().max(QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS).default(''),
  limit: z.number().int().positive().max(32).default(16),
  excludePaths: z.array(z.string()).optional(),
  mode: z.literal('quick-open').optional()
})

export const ResolveTerminalPath = WorktreeSelector.extend({
  pathText: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing path text')),
  terminal: z
    .unknown()
    .transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional(),
  cwd: z
    .unknown()
    .transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional(),
  crossWorkspace: z
    .unknown()
    .transform((v) => v === true)
    .optional(),
  nativeChatContext: z
    .object({
      tabId: z.string().min(1),
      sessionId: z.string().min(1)
    })
    .optional()
})

// Why: absent `navigation` (phones, older CLIs) keeps the original host switch; 'caller'/'clients' open without moving it.
export const FileOpenTab = FileOpen.extend({
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional()
})

export const FileOpenDiff = FileOpenTab.extend({
  staged: z.boolean().optional()
})

/**
 * `files.readDocPreview`: the document's paths relative to its workspace, or each absolute on the
 * host. `boundaryPath` is the preview's request base, which the workspace form takes to be the
 * workspace itself; `path` is the file read.
 */
export const DocPreviewFileRead = workspaceOrHostPathTarget(
  FileOpen.extend({
    entryRelativePath: z.string().min(1),
    implicitRootRelativePath: z.string().nullable(),
    authorizedRootRelativePaths: z.array(z.string())
  }),
  HostPathTarget.extend({
    boundaryPath: z.string({ error: 'Missing boundary path' }).min(1, 'Missing boundary path'),
    entryPath: z.string({ error: 'Missing entry path' }).min(1, 'Missing entry path'),
    implicitRootPath: z.string().nullable(),
    authorizedRootPaths: z.array(z.string())
  })
)

export const FileTreePath = WorktreeSelector.extend({
  followSymlinks: z.boolean().optional(),
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

export const FileStatTarget = workspaceOrHostPathTarget(FileTreePath, HostPathTarget)

export const ServerDirectoryBrowse = z.object({
  path: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

const FileChunkRange = {
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .positive()
    .max(512 * 1024)
}

export const FileReadChunk = workspaceOrHostPathTarget(
  FileOpen.extend(FileChunkRange),
  HostPathTarget.extend(FileChunkRange)
)

/** `files.readPreview`. */
export const FileReadTarget = workspaceOrHostPathTarget(FileOpen, HostPathTarget)

/** `files.read`: the one method a chat-visual access may name. */
export const FileContentReadTarget = workspaceOrHostPathTarget(FileOpen, HostPathReadTarget)

export const FileSearch = WorktreeSelector.extend({
  query: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing search query')),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  useRegex: z.boolean().optional(),
  includePattern: z.string().optional(),
  excludePattern: z.string().optional(),
  maxResults: z.number().int().positive().optional()
})

// Why: `maxResults` is a new optional field (wire rule 1) — an older host strips it and keeps its
// own default. It existed only on the Electron IPC hop, so "the client names its cap and a full page
// means there is more" was true for desktop and merely incidental for web and mobile, which were
// saved by `remoteFileContentBudget` defaulting the cap inside `listRuntimeFiles`.
export const FileListAll = WorktreeSelector.extend({
  candidatePaths: z
    .array(z.string().max(64 * 1024))
    .max(100)
    .optional(),
  includeIgnored: z.boolean().optional(),
  followSymlinks: z.boolean().optional(),
  excludePaths: z.array(z.string()).optional(),
  maxResults: z.number().int().positive().optional()
})

export const FileUnwatch = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

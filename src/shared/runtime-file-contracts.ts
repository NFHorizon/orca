import type { RasterImageDimensions } from './raster-image-dimensions'

export type RuntimeFileListEntry = {
  relativePath: string
  basename: string
  kind: 'text' | 'binary'
}

export type RuntimeFileListResult = {
  worktree: string
  rootPath: string
  files: RuntimeFileListEntry[]
  totalCount: number
  truncated: boolean
  quickOpenSearchVersion?: number
}

export type RuntimeFileOpenResult = {
  worktree: string
  relativePath: string
  kind: 'markdown' | 'text' | 'binary' | 'image'
  opened: boolean
}

export type RuntimeFileReadResult = {
  worktree: string
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
}

/** `files.read` of a host path: the requested path in place of the workspace pair. */
export type RuntimeHostPathFileReadResult = Omit<
  RuntimeFileReadResult,
  'worktree' | 'relativePath'
> & {
  path: string
}

/** `files.stat`, by either target. */
export type RuntimeFileStatResult = {
  size: number
  isDirectory: boolean
  mtime: number
  ctime?: number
}

export type RuntimeTerminalPathOpenTarget =
  | {
      kind: 'worktree-file'
      provider: 'local' | 'ssh'
      relativePath: string
      absolutePath: string
    }
  | {
      kind: 'absolute-file'
      provider: 'local' | 'ssh'
      absolutePath: string
      grantId: string
      readOnly?: true
    }
  | { kind: 'unsupported'; reason: string }

export type RuntimeNativeChatFileContext = {
  tabId: string
  sessionId: string
}

// Why: older hosts ignore crossWorkspace, so their refusal is no proof that no host workspace holds the path.
export const TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY =
  'files.resolve-terminal-path.cross-workspace.v1' as const

// Why: an older host refuses a file named by `path` as a missing worktree. A host advertising this
// serves `{path, access?}` on files.read, readPreview, readChunk, stat, write and readDocPreview,
// and files.read's chat-visual kind. Which paths it reaches is its own rule: today its workspaces
// and its chat scratch folder; widening that is a host rule change under this same capability.
export const FILES_HOST_PATH_RUNTIME_CAPABILITY = 'files.host-path.v1' as const

export const RUNTIME_FILE_CAPABILITIES = [
  'files.pathsExist',
  TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY,
  FILES_HOST_PATH_RUNTIME_CAPABILITY
] as const

export type RuntimeTerminalPathResolution = {
  worktree: string
  relativePath: string | null
  absolutePath: string | null
  exists: boolean
  isDirectory: boolean
  openTarget?: RuntimeTerminalPathOpenTarget
}

export type RuntimeFilePreviewResult = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  imageDimensions?: RasterImageDimensions
}

export type RuntimeFileReadChunkResult = {
  contentBase64: string
  bytesRead: number
  eof: boolean
}

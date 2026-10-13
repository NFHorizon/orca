// Reading one visual by its absolute host path. This is the boundary, not the renderer: the path
// must name a visual file directly inside one chat's folder under this host's scratch root, both
// lexically and canonically, be a regular file reached without a symlink, and be UTF-8 text within
// the byte cap.

import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  NATIVE_CHAT_VISUAL_MAX_BYTES,
  isNativeChatVisualFileName
} from '../../shared/native-chat-visual-directive'
import type {
  AgentSessionReadVisualResult,
  AgentSessionVisualReadError
} from '../../shared/rpc-contract/agent-session-visual-params'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { readLocalFileBounded } from '../ipc/filesystem/local-regular-file-read'

// Why O_NOFOLLOW: refuses a final-component symlink at open, so no swap after a check can redirect
// the read. Windows has no such flag; there the lstat and post-open identity checks hold the line.
const VISUAL_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)

const REVISION_HEX_LENGTH = 32
// The host mints each chat's folder name as 32 lowercase hex (`nativeChatScratchFolderName`).
const CHAT_FOLDER_NAME = /^[0-9a-f]{32}$/

class VisualReadRefusal extends Error {
  constructor(readonly refusal: AgentSessionVisualReadError) {
    super(refusal)
  }
}

function refuse(refusal: AgentSessionVisualReadError): never {
  throw new VisualReadRefusal(refusal)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * The folder and its parent are Orca's own directories below the trusted state directory. Either
 * one replaced by a symlink would aim every read somewhere else, so a link there is refused.
 */
async function canonicalFolder(folder: string): Promise<string> {
  try {
    // Parent first, so the answer for a broken path does not depend on which check settles first.
    const parentStats = await lstat(dirname(folder))
    const owned = [parentStats, await lstat(folder)]
    if (owned.some((stats) => stats.isSymbolicLink())) {
      refuse('outside_folder')
    }
    if (owned.some((stats) => !stats.isDirectory())) {
      refuse('not_found')
    }
    return await realpath(folder)
  } catch (error) {
    if (error instanceof VisualReadRefusal) {
      throw error
    }
    if (isENOENT(error) || errorCode(error) === 'ENOTDIR') {
      refuse('not_found')
    }
    throw error
  }
}

async function openVisual(candidate: string): Promise<FileHandle> {
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      refuse('outside_folder')
    }
    return await open(candidate, VISUAL_OPEN_FLAGS)
  } catch (error) {
    if (error instanceof VisualReadRefusal) {
      throw error
    }
    if (isENOENT(error) || errorCode(error) === 'ENOTDIR') {
      refuse('not_found')
    }
    // ELOOP: the path became a symlink between the lstat and the open.
    if (errorCode(error) === 'ELOOP' || errorCode(error) === 'EMLINK') {
      refuse('outside_folder')
    }
    if (errorCode(error) === 'EISDIR') {
      refuse('not_a_file')
    }
    throw error
  }
}

/**
 * After the open: the handle must still be the file directly inside the canonical folder, and the
 * folder that canonical path names must still be the real directory at Orca's own path (a symlink
 * swapped in and out around the first check would otherwise aim `folderReal` elsewhere).
 */
async function assertStillContained(
  folder: string,
  candidate: string,
  folderReal: string,
  file: string,
  opened: Stats
): Promise<void> {
  let resolved: string
  let current: Stats
  try {
    const [parentNow, folderNow, canonicalFolderNow] = await Promise.all([
      lstat(dirname(folder)),
      lstat(folder),
      lstat(folderReal)
    ])
    if (
      parentNow.isSymbolicLink() ||
      folderNow.isSymbolicLink() ||
      !sameFile(folderNow, canonicalFolderNow)
    ) {
      refuse('outside_folder')
    }
    resolved = await realpath(candidate)
    current = await lstat(candidate)
  } catch (error) {
    if (error instanceof VisualReadRefusal) {
      throw error
    }
    if (isENOENT(error)) {
      refuse('not_found')
    }
    throw error
  }
  // Why compare names case-insensitively: a case-insensitive volume may report the stored case.
  if (
    dirname(resolved) !== folderReal ||
    basename(resolved).toLowerCase() !== file.toLowerCase() ||
    current.isSymbolicLink() ||
    !sameFile(current, opened)
  ) {
    refuse('outside_folder')
  }
}

function decodeVisualText(buffer: Buffer): string {
  if (buffer.includes(0)) {
    refuse('not_text')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return refuse('not_text')
  }
}

export function nativeChatVisualRevision(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, REVISION_HEX_LENGTH)
}

async function readContained(
  folder: string,
  file: string,
  knownRevision: string | undefined
): Promise<AgentSessionReadVisualResult> {
  const folderReal = await canonicalFolder(folder)
  const candidate = join(folderReal, file)
  if (dirname(candidate) !== folderReal) {
    refuse('outside_folder')
  }
  const handle = await openVisual(candidate)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      refuse('not_a_file')
    }
    if (stats.size > NATIVE_CHAT_VISUAL_MAX_BYTES) {
      refuse('too_large')
    }
    await assertStillContained(folder, candidate, folderReal, file, stats)
    let buffer: Buffer
    try {
      buffer = await readLocalFileBounded(handle, NATIVE_CHAT_VISUAL_MAX_BYTES, stats.size)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('File too large')) {
        refuse('too_large')
      }
      throw error
    }
    const html = decodeVisualText(buffer)
    const revision = nativeChatVisualRevision(buffer)
    const sizeBytes = buffer.length
    return knownRevision === revision
      ? { ok: true, revision, sizeBytes, unchanged: true }
      : { ok: true, revision, sizeBytes, html }
  } finally {
    await handle.close()
  }
}

export type NativeChatVisualPathParts = {
  /** The chat's folder name: 32 hex, one segment directly under the scratch root. */
  folderName: string
  /** The bare visual file name inside that folder. */
  file: string
}

/**
 * Splits `filePath` into the chat folder and visual file it names, or null unless it is exactly
 * `<scratchRoot>/<32 hex>/<visual file name>`. Lexical only; the read re-checks on disk. Path syntax
 * follows the root, so a Windows root accepts `\` or `/` separators and compares case-insensitively.
 */
export function nativeChatVisualPathParts(
  scratchRoot: string,
  filePath: string
): NativeChatVisualPathParts | null {
  const flavor = isWindowsAbsolutePathLike(scratchRoot) ? win32 : posix
  const native = flavor === win32 ? filePath.replace(/\//g, '\\') : filePath
  // Why normalized only: `..`, `.`, doubled or trailing separators would let the lexical parent
  // differ from the directory the open walks.
  if (
    !flavor.isAbsolute(native) ||
    flavor.normalize(native) !== native ||
    native.endsWith(flavor.sep)
  ) {
    return null
  }
  const file = flavor.basename(native)
  const folder = flavor.dirname(native)
  const folderName = flavor.basename(folder)
  if (
    !isNativeChatVisualFileName(file) ||
    !CHAT_FOLDER_NAME.test(folderName) ||
    flavor.relative(scratchRoot, flavor.dirname(folder)) !== ''
  ) {
    return null
  }
  return { folderName, file }
}

/**
 * The visual at absolute host path `filePath`, or the refusal the host observed. Any path that is not
 * a visual file directly in a chat folder under `scratchRoot` (this host's
 * `nativeChatScratchRootFor(stateDirectory)`) is `outside_folder` without touching the disk.
 * Unexpected filesystem faults still throw, so the client reads them as unavailable rather than as a
 * verdict about the file; the thrown error names only the error code, never a host path.
 */
export async function readNativeChatVisualPath(
  scratchRoot: string,
  filePath: string,
  knownRevision?: string
): Promise<AgentSessionReadVisualResult> {
  try {
    // Why resolve: the host's data root may be relative, and the shape check needs an absolute root.
    const root = resolve(scratchRoot)
    const parts = nativeChatVisualPathParts(root, filePath)
    if (!parts) {
      refuse('outside_folder')
    }
    // Rebuilt from the validated parts so the disk checks walk the host's own spelling of the root.
    return await readContained(join(root, parts.folderName), parts.file, knownRevision)
  } catch (error) {
    if (error instanceof VisualReadRefusal) {
      return { ok: false, error: error.refusal }
    }
    throw new Error(`visual_read_failed:${errorCode(error) ?? 'unknown'}`, { cause: error })
  }
}

// The `chat-visual` file access: a chat reads its own visual without a click, so the protected
// visual reader answers it, never a project root, and the result looks like any file read.

import { PATH_ACCESS_DENIED_MESSAGE } from '../ipc/filesystem-auth'
import { NOT_A_REGULAR_FILE_MESSAGE } from '../ipc/filesystem/local-regular-file-read'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { AgentSessionVisualReadError } from '../../shared/rpc-contract/agent-session-visual-params'
import { nativeChatScratchRootFor } from './native-chat-scratch-folder'
import { readNativeChatVisualPath } from './native-chat-visual-file-read'

/** The visual's file is not there (also the chat's folder or the scratch root). */
export const CHAT_VISUAL_NOT_FOUND_MESSAGE = 'ENOENT: no such file or directory'

// Why ordinary read errors: a caller tells missing, refused and too large apart as for any file;
// `file_too_large` and `binary_file` are the host's typed refusals for `files.read`.
function refusalMessage(refusal: AgentSessionVisualReadError): string {
  switch (refusal) {
    case 'not_found':
    // Session lookups belong to the legacy endpoint; a path read never produces them.
    case 'session_not_found':
      return CHAT_VISUAL_NOT_FOUND_MESSAGE
    case 'outside_folder':
    case 'unsupported_location':
      return PATH_ACCESS_DENIED_MESSAGE
    case 'not_a_file':
      return NOT_A_REGULAR_FILE_MESSAGE
    case 'too_large':
      return 'file_too_large'
    case 'not_text':
      return 'binary_file'
  }
}

function refusalError(refusal: AgentSessionVisualReadError): Error {
  const error = new Error(refusalMessage(refusal))
  return refusal === 'not_found' ? Object.assign(error, { code: 'ENOENT' }) : error
}

/**
 * The text of the visual at `filePath` on this host: a visual file directly inside one chat's
 * folder under this host's chat scratch root, checked and read by the protected reader. A path
 * anywhere else is refused, even inside a project. Unexpected filesystem faults still throw.
 */
export async function readChatVisualAccessFile(filePath: unknown): Promise<string> {
  if (typeof filePath !== 'string') {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  // Why the profile path: chat hosts and their scratch folders open in it on this process.
  const result = await readNativeChatVisualPath(
    nativeChatScratchRootFor(getProfileUserDataPath()),
    filePath
  )
  if (!result.ok) {
    throw refusalError(result.error)
  }
  // Why the guard: `unchanged` answers only a known revision, which this read never sends.
  if (!('html' in result)) {
    throw new Error('visual_read_failed:unchanged')
  }
  return result.html
}

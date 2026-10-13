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
const REFUSAL_MESSAGES: Record<AgentSessionVisualReadError, string> = {
  not_found: CHAT_VISUAL_NOT_FOUND_MESSAGE,
  outside_folder: PATH_ACCESS_DENIED_MESSAGE,
  not_a_file: NOT_A_REGULAR_FILE_MESSAGE,
  too_large: 'file_too_large',
  not_text: 'binary_file',
  // Session lookups belong to the legacy endpoint; a path read never produces them.
  session_not_found: CHAT_VISUAL_NOT_FOUND_MESSAGE,
  unsupported_location: PATH_ACCESS_DENIED_MESSAGE
}

function refusalError(refusal: AgentSessionVisualReadError): Error {
  const error = new Error(REFUSAL_MESSAGES[refusal])
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

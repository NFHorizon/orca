import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { isNativeChatVisualFileName } from './native-chat-visual-directive'

/**
 * The host path of a chat's visual: `file` directly inside the chat's host-published
 * `scratchDirectory`, joined in the host's own path syntax (clients may run on another OS).
 * Null when `file` is not a valid bare visual name, so no other path is ever built.
 */
export function nativeChatVisualHostPath(scratchDirectory: string, file: string): string | null {
  if (scratchDirectory.length === 0 || !isNativeChatVisualFileName(file)) {
    return null
  }
  const separator = isWindowsAbsolutePathLike(scratchDirectory) ? '\\' : '/'
  return `${scratchDirectory}${separator}${file}`
}

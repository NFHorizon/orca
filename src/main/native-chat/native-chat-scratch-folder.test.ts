import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  legacyNativeChatVisualsRootFor,
  nativeChatScratchFolderFor,
  nativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'

describe('a chat scratch folder', () => {
  it('places each chat in its own hashed folder under the chat-scratch root', () => {
    const alpha = nativeChatScratchFolderFor('/state', 'session-alpha')
    const beta = nativeChatScratchFolderFor('/state', 'session-beta')
    expect(nativeChatScratchRootFor('/state')).toBe(join('/state', 'chat-scratch'))
    expect(alpha).toBe(join('/state', 'chat-scratch', nativeChatScratchFolderName('session-alpha')))
    expect(alpha).not.toBe(beta)
  })

  it('names the folder by the first 32 hex of the session id hash, as before the rename', () => {
    const sessionId = 'chat/with:any\\characters'
    expect(nativeChatScratchFolderName(sessionId)).toBe(
      createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)
    )
    expect(nativeChatScratchFolderName(sessionId)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps the pre-rename root beside it, under the same state directory', () => {
    expect(legacyNativeChatVisualsRootFor('/state')).toBe(join('/state', 'native-chat-visuals'))
  })
})

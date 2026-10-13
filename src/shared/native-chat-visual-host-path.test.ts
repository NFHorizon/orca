import { describe, expect, it } from 'vitest'
import { nativeChatVisualHostPath } from './native-chat-visual-host-path'

const HEX = '0123456789abcdef0123456789abcdef'

describe('nativeChatVisualHostPath', () => {
  it('joins a POSIX host folder with a slash', () => {
    expect(nativeChatVisualHostPath(`/home/me/.config/orca/scratch/${HEX}`, 'chart.html')).toBe(
      `/home/me/.config/orca/scratch/${HEX}/chart.html`
    )
  })

  it('joins a Windows host folder with a backslash, whatever this client runs on', () => {
    expect(
      nativeChatVisualHostPath(`C:\\Users\\me\\AppData\\Roaming\\orca\\scratch\\${HEX}`, 'a.html')
    ).toBe(`C:\\Users\\me\\AppData\\Roaming\\orca\\scratch\\${HEX}\\a.html`)
    expect(nativeChatVisualHostPath(`\\\\server\\share\\orca\\${HEX}`, 'a.html')).toBe(
      `\\\\server\\share\\orca\\${HEX}\\a.html`
    )
  })

  it('builds nothing for a name that is not a bare visual file', () => {
    for (const file of [
      '',
      '../x.html',
      'sub/x.html',
      'sub\\x.html',
      '.hidden.html',
      'x.htm',
      'con.html',
      'a..html'
    ]) {
      expect(nativeChatVisualHostPath(`/state/${HEX}`, file)).toBeNull()
    }
  })

  it('builds nothing without a folder', () => {
    expect(nativeChatVisualHostPath('', 'chart.html')).toBeNull()
  })
})

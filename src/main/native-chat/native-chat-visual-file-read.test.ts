import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NATIVE_CHAT_VISUAL_MAX_BYTES } from '../../shared/native-chat-visual-directive'
import {
  nativeChatVisualsFolderFor,
  nativeChatVisualsFolderName,
  nativeChatVisualsRootFor
} from './native-chat-visuals-folder'
import {
  nativeChatVisualPathParts,
  nativeChatVisualRevision,
  readNativeChatVisualPath
} from './native-chat-visual-file-read'

const posixIt = process.platform === 'win32' ? it.skip : it

let stateDirectory: string
let root: string
let folder: string

function readVisual(name: string, knownRevision?: string) {
  return readNativeChatVisualPath(root, join(folder, name), knownRevision)
}

function readAt(filePath: string) {
  return readNativeChatVisualPath(root, filePath)
}

const OUTSIDE = { ok: false, error: 'outside_folder' } as const

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-visual-read-'))
  root = nativeChatVisualsRootFor(stateDirectory)
  folder = nativeChatVisualsFolderFor(stateDirectory, 'session-alpha')
  await mkdir(folder, { recursive: true })
})

afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('nativeChatVisualsFolderFor', () => {
  it('places each chat in its own hashed folder under the state directory', () => {
    const alpha = nativeChatVisualsFolderFor('/state', 'session-alpha')
    const beta = nativeChatVisualsFolderFor('/state', 'session-beta')
    expect(alpha).toMatch(/native-chat-visuals[\\/][0-9a-f]{32}$/)
    expect(alpha.startsWith(join('/state', 'native-chat-visuals'))).toBe(true)
    expect(alpha).not.toBe(beta)
  })
})

describe('readNativeChatVisualPath', () => {
  it('reads a UTF-8 visual with its revision and size', async () => {
    const html = '<!doctype html><p>Grüße</p>'
    await writeFile(join(folder, 'chart.html'), html)
    const result = await readVisual('chart.html')
    expect(result).toEqual({
      ok: true,
      html,
      revision: nativeChatVisualRevision(Buffer.from(html)),
      sizeBytes: Buffer.byteLength(html)
    })
  })

  it('resolves a visuals root given relative to the working directory', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>a</p>')
    expect(
      await readNativeChatVisualPath(relative(process.cwd(), root), join(folder, 'chart.html'))
    ).toMatchObject({ ok: true, html: '<p>a</p>' })
  })

  it('answers unchanged without the bytes when the client already holds the revision', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>a</p>')
    const first = await readVisual('chart.html')
    if (!first.ok) {
      throw new Error('expected a read')
    }
    const again = await readVisual('chart.html', first.revision)
    expect(again).toEqual({ ok: true, revision: first.revision, sizeBytes: 8, unchanged: true })

    await writeFile(join(folder, 'chart.html'), '<p>b</p>')
    const changed = await readVisual('chart.html', first.revision)
    expect(changed).toMatchObject({ ok: true, html: '<p>b</p>' })
  })

  it('reports a missing file or a missing folder as not_found', async () => {
    expect(await readVisual('nope.html')).toEqual({
      ok: false,
      error: 'not_found'
    })
    const absent = nativeChatVisualsFolderFor(stateDirectory, 'session-never')
    expect(await readAt(join(absent, 'chart.html'))).toEqual({
      ok: false,
      error: 'not_found'
    })
  })

  it('refuses a leaf that is not a bare visual file name, even when the file exists', async () => {
    for (const name of ['chart.txt', '.hidden.html', 'a b.html']) {
      await writeFile(join(folder, name), '<p>x</p>')
      expect(await readAt(`${folder}${sep}${name}`)).toEqual(OUTSIDE)
    }
    // Never created: Windows would map these to a device or strip the trailing dot.
    for (const name of ['CON.html', 'chart.html.']) {
      expect(await readAt(`${folder}${sep}${name}`)).toEqual(OUTSIDE)
    }
  })

  it('refuses a path outside the visuals root, including a root-prefixed sibling', async () => {
    const other = join(stateDirectory, 'other')
    const lookalike = join(`${root}-evil`, nativeChatVisualsFolderName('session-alpha'))
    for (const directory of [other, lookalike]) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'chart.html'), '<p>x</p>')
      expect(await readAt(join(directory, 'chart.html'))).toEqual(OUTSIDE)
    }
    expect(await readAt('/etc/hosts')).toEqual(OUTSIDE)
  })

  it('refuses a parent that is not a host-minted 32-hex folder', async () => {
    const hex = nativeChatVisualsFolderName('session-alpha')
    for (const name of ['chat', hex.toUpperCase(), hex.slice(1), `${hex}0`]) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'chart.html'), '<p>x</p>')
      expect(await readAt(join(root, name, 'chart.html'))).toEqual(OUTSIDE)
    }
  })

  it('refuses a file directly in the root or nested below a chat folder', async () => {
    const hex = nativeChatVisualsFolderName('session-beta')
    await writeFile(join(root, 'chart.html'), '<p>x</p>')
    await mkdir(join(folder, hex), { recursive: true })
    await writeFile(join(folder, hex, 'chart.html'), '<p>x</p>')
    await mkdir(join(folder, 'sub'), { recursive: true })
    await writeFile(join(folder, 'sub', 'chart.html'), '<p>x</p>')
    for (const filePath of [
      join(root, 'chart.html'),
      join(folder, hex, 'chart.html'),
      join(folder, 'sub', 'chart.html')
    ]) {
      expect(await readAt(filePath)).toEqual(OUTSIDE)
    }
  })

  it('refuses traversal and non-normalized spellings of a real visual', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>x</p>')
    const hex = nativeChatVisualsFolderName('session-alpha')
    for (const filePath of [
      `${folder}${sep}..${sep}${hex}${sep}chart.html`,
      `${root}${sep}.${sep}${hex}${sep}chart.html`,
      `${root}${sep}${sep}${hex}${sep}chart.html`,
      `${folder}${sep}chart.html${sep}`,
      join('native-chat-visuals', hex, 'chart.html'),
      `${hex}${sep}chart.html`,
      'chart.html'
    ]) {
      expect(await readAt(filePath)).toEqual(OUTSIDE)
    }
  })

  posixIt('refuses a symlink to a sibling chat folder or another workspace', async () => {
    const sibling = nativeChatVisualsFolderFor(stateDirectory, 'session-beta')
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, 'theirs.html'), '<p>other chat</p>')
    const worktree = join(stateDirectory, 'worktree')
    await mkdir(worktree)
    await writeFile(join(worktree, 'index.html'), '<p>repo</p>')

    await symlink(join(sibling, 'theirs.html'), join(folder, 'theirs.html'))
    await symlink(join(worktree, 'index.html'), join(folder, 'repo.html'))
    await symlink(join(folder, 'missing-target.html'), join(folder, 'dangling.html'))

    for (const name of ['theirs.html', 'repo.html', 'dangling.html']) {
      expect(await readVisual(name)).toEqual({
        ok: false,
        error: 'outside_folder'
      })
    }
  })

  posixIt('refuses a visuals folder replaced by a symlink', async () => {
    const elsewhere = join(stateDirectory, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'chart.html'), '<p>elsewhere</p>')
    await rm(folder, { recursive: true })
    await symlink(elsewhere, folder)
    expect(await readVisual('chart.html')).toEqual({
      ok: false,
      error: 'outside_folder'
    })
  })

  posixIt('refuses when the shared visuals root is a symlink', async () => {
    const root = join(stateDirectory, 'native-chat-visuals')
    const moved = join(stateDirectory, 'moved-root')
    await rm(root, { recursive: true })
    await mkdir(join(moved, 'x'), { recursive: true })
    await symlink(moved, root)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'chart.html'), '<p>a</p>')
    expect(await readVisual('chart.html')).toEqual({
      ok: false,
      error: 'outside_folder'
    })
  })

  it('refuses a directory named like a visual', async () => {
    await mkdir(join(folder, 'dir.html'))
    expect(await readVisual('dir.html')).toEqual({
      ok: false,
      error: 'not_a_file'
    })
  })

  posixIt('refuses a FIFO without waiting for a writer', async () => {
    execFileSync('mkfifo', [join(folder, 'pipe.html')])
    expect(await readVisual('pipe.html')).toEqual({
      ok: false,
      error: 'not_a_file'
    })
  })

  it('refuses a file over the byte cap and accepts one exactly at it', async () => {
    await writeFile(join(folder, 'max.html'), 'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES))
    expect(await readVisual('max.html')).toMatchObject({ ok: true })
    await writeFile(join(folder, 'big.html'), 'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES + 1))
    expect(await readVisual('big.html')).toEqual({
      ok: false,
      error: 'too_large'
    })
  })

  it('refuses binary and invalid UTF-8 content', async () => {
    await writeFile(join(folder, 'zero-byte.html'), Buffer.from([0x3c, 0x00, 0x3e]))
    await writeFile(join(folder, 'latin1.html'), Buffer.from([0x3c, 0xe9, 0x3e]))
    expect(await readVisual('zero-byte.html')).toEqual({
      ok: false,
      error: 'not_text'
    })
    expect(await readVisual('latin1.html')).toEqual({
      ok: false,
      error: 'not_text'
    })
  })

  it('reads a hard link the agent made inside its own folder', async () => {
    // A hard link grants nothing a copy would not: the agent could write the same bytes itself.
    await writeFile(join(folder, 'a.html'), '<p>a</p>')
    await link(join(folder, 'a.html'), join(folder, 'b.html'))
    expect(await readVisual('b.html')).toMatchObject({ ok: true })
  })

  it('reads the replacement after a file is swapped for new content', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>old</p>')
    await rm(join(folder, 'chart.html'))
    await writeFile(join(folder, 'chart.html'), '<p>new</p>')
    expect(await readVisual('chart.html')).toMatchObject({
      ok: true,
      html: '<p>new</p>'
    })
  })

  posixIt('reports an unexpected filesystem fault without the host path', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>a</p>')
    await chmod(join(folder, 'chart.html'), 0o000)
    try {
      const failure = await readVisual('chart.html').then(
        () => null,
        (error: unknown) => error
      )
      // Root reads through the mode bits; everyone else gets the coded fault.
      if (failure !== null) {
        expect(String(failure)).toContain('visual_read_failed:EACCES')
        expect(String(failure)).not.toContain(stateDirectory)
      }
    } finally {
      await chmod(join(folder, 'chart.html'), 0o644)
    }
  })
})

describe('nativeChatVisualPathParts', () => {
  const hex = nativeChatVisualsFolderName('session-alpha')

  it('splits a POSIX visual path and keeps POSIX case sensitivity', () => {
    const posixRoot = '/home/me/.config/orca/native-chat-visuals'
    expect(nativeChatVisualPathParts(posixRoot, `${posixRoot}/${hex}/chart.html`)).toEqual({
      folderName: hex,
      file: 'chart.html'
    })
    expect(
      nativeChatVisualPathParts(
        posixRoot,
        `/HOME/me/.config/orca/native-chat-visuals/${hex}/a.html`
      )
    ).toBeNull()
    expect(nativeChatVisualPathParts(posixRoot, `C:\\x\\${hex}\\chart.html`)).toBeNull()
  })

  it('accepts Windows separators and drive-letter case under a Windows root', () => {
    const windowsRoot = 'C:\\Users\\me\\AppData\\Roaming\\orca\\native-chat-visuals'
    const parts = { folderName: hex, file: 'chart.html' }
    expect(nativeChatVisualPathParts(windowsRoot, `${windowsRoot}\\${hex}\\chart.html`)).toEqual(
      parts
    )
    expect(
      nativeChatVisualPathParts(
        windowsRoot,
        `C:/Users/me/AppData/Roaming/orca/native-chat-visuals/${hex}/chart.html`
      )
    ).toEqual(parts)
    expect(
      nativeChatVisualPathParts(
        windowsRoot,
        `c:\\users\\me\\appdata\\roaming\\orca\\native-chat-visuals\\${hex}\\chart.html`
      )
    ).toEqual(parts)
  })

  it('refuses Windows traversal, other roots and stream or device names', () => {
    const windowsRoot = 'C:\\Users\\me\\AppData\\Roaming\\orca\\native-chat-visuals'
    for (const filePath of [
      `${windowsRoot}\\${hex}\\..\\${hex}\\chart.html`,
      `${windowsRoot}\\${hex}\\sub\\chart.html`,
      `D:\\Users\\me\\AppData\\Roaming\\orca\\native-chat-visuals\\${hex}\\chart.html`,
      `C:Users\\me\\AppData\\Roaming\\orca\\native-chat-visuals\\${hex}\\chart.html`,
      `\\\\?\\${windowsRoot}\\${hex}\\chart.html`,
      `\\\\server\\share\\native-chat-visuals\\${hex}\\chart.html`,
      `${windowsRoot}\\${hex}\\chart.html\\`,
      `${windowsRoot}\\${hex}\\chart.html:stream`,
      `${windowsRoot}\\${hex}\\CON.html`,
      `${windowsRoot}\\${hex}\\chart.html.`,
      `${windowsRoot}\\${hex}\\chart.html `
    ]) {
      expect(nativeChatVisualPathParts(windowsRoot, filePath)).toBeNull()
    }
  })
})

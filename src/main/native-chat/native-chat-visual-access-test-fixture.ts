import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import {
  legacyNativeChatVisualsRootFor,
  nativeChatScratchFolderFor,
  nativeChatScratchFolderName,
  nativeChatScratchRootFor
} from './native-chat-scratch-folder'

export const VISUAL_HTML = '<!doctype html><p>chart ✓</p>\n'

export type ChatVisualAccessFixture = {
  /** A valid visual: `<scratch root>/<32 hex>/chart.html`. */
  visual: string
  scratchFolder: string
  /** Visual-shaped and project files a default (roots) read may serve, but a chat visual never. */
  refused: [label: string, path: string][]
}

/**
 * A state directory with one chat's scratch folder and a project beside it, plus every path a
 * `chat-visual` read must refuse. Symlink cases are POSIX-only (Windows needs privileges).
 */
export async function createChatVisualAccessFixture(
  userData: string,
  project: string
): Promise<ChatVisualAccessFixture> {
  const scratchRoot = nativeChatScratchRootFor(userData)
  const scratchFolder = nativeChatScratchFolderFor(userData, 'session-1')
  const visual = join(scratchFolder, 'chart.html')
  const chatFolderName = nativeChatScratchFolderName('session-1')
  const projectLookalike = join(project, basename(scratchRoot), chatFolderName)
  const legacyFolder = join(legacyNativeChatVisualsRootFor(userData), chatFolderName)
  const nonHexFolder = join(scratchRoot, 'not-a-chat-folder')
  for (const dir of [
    scratchFolder,
    join(scratchFolder, 'nested'),
    projectLookalike,
    legacyFolder,
    nonHexFolder
  ]) {
    await mkdir(dir, { recursive: true })
  }
  const files = [
    visual,
    join(project, 'chart.html'),
    join(projectLookalike, 'chart.html'),
    join(scratchFolder, 'nested', 'chart.html'),
    join(nonHexFolder, 'chart.html'),
    join(scratchRoot, 'chart.html'),
    join(scratchFolder, 'notes.md'),
    join(scratchFolder, '.hidden.html'),
    join(legacyFolder, 'chart.html')
  ]
  for (const file of files) {
    await writeFile(file, VISUAL_HTML)
  }
  const refused: [string, string][] = [
    ['a project file', join(project, 'chart.html')],
    ['a visual-shaped project path', join(projectLookalike, 'chart.html')],
    ['a visual nested deeper', join(scratchFolder, 'nested', 'chart.html')],
    ['a parent that is not 32 hex', join(nonHexFolder, 'chart.html')],
    ['a file directly in the scratch root', join(scratchRoot, 'chart.html')],
    ['a file that is not HTML', join(scratchFolder, 'notes.md')],
    ['an invalid visual file name', join(scratchFolder, '.hidden.html')],
    ['the pre-rename root', join(legacyFolder, 'chart.html')],
    ['a non-normalized path', [scratchFolder, 'nested', '..', 'chart.html'].join(sep)],
    ['a relative path', 'chart.html']
  ]
  if (process.platform !== 'win32') {
    await symlink(join(project, 'chart.html'), join(scratchFolder, 'linked.html'))
    const linkedFolder = join(scratchRoot, 'f'.repeat(32))
    await symlink(projectLookalike, linkedFolder)
    refused.push(
      ['a symlinked visual', join(scratchFolder, 'linked.html')],
      ['a visual in a symlinked chat folder', join(linkedFolder, 'chart.html')]
    )
  }
  return { visual, scratchFolder, refused }
}

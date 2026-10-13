import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    },
    on: vi.fn()
  }
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => true }))
vi.mock('../browser/doc-preview-guest-policy', () => ({ reportDocPreviewLinkClick: vi.fn() }))
vi.mock('../browser/browser-manager', () => ({
  browserManager: { getGuestWebContentsId: () => null }
}))

import {
  registerDocPreviewGrantHandlers,
  type DocPreviewGrantRequest
} from './doc-preview-grant-ipc'
import {
  getDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import { DOC_PREVIEW_MINT_GRANT_CHANNEL } from '../../shared/doc-preview-scheme'

const REQUEST: DocPreviewGrantRequest = {
  owner: { kind: 'host-path', environmentId: 'env-1', worktreeSelector: 'id:wt-1' },
  requestBase: '/home/me/state/ab12',
  root: '/home/me/state/ab12',
  entryRelativePath: 'chart.html',
  browserPageId: 'doc-page-1'
}

function mint(request: DocPreviewGrantRequest): string {
  const handler = mocks.handlers.get(DOC_PREVIEW_MINT_GRANT_CHANNEL)
  if (!handler) {
    throw new Error('mint handler not registered')
  }
  const result: unknown = handler({ sender: { id: 7 } }, request)
  if (typeof result !== 'object' || result === null || !('grantId' in result)) {
    throw new Error('mint returned no grant')
  }
  return String(result.grantId)
}

beforeEach(() => {
  mocks.handlers.clear()
  revokeAllDocPreviewGrants()
  registerDocPreviewGrantHandlers()
})

describe('host-path document preview grants', () => {
  it('mints a grant bounded by the document folder, starting at the entry alone', () => {
    const grant = getDocPreviewGrant(mint(REQUEST))

    expect(grant).toMatchObject({
      owner: REQUEST.owner,
      requestBase: '/home/me/state/ab12',
      root: '/home/me/state/ab12',
      entryRelativePath: 'chart.html',
      authorizedRoots: []
    })
  })

  it('refuses a boundary wider than the document folder', () => {
    expect(() => mint({ ...REQUEST, requestBase: '/home/me/state' })).toThrow(/Invalid/)
    expect(() =>
      mint({ ...REQUEST, requestBase: '/home/me/state', entryRelativePath: 'ab12/chart.html' })
    ).toThrow(/Invalid/)
    expect(() => mint({ ...REQUEST, entryRelativePath: 'sub\\chart.html' })).toThrow(/Invalid/)
  })

  it('refuses an owner that names no host or workspace', () => {
    expect(() =>
      mint({
        ...REQUEST,
        owner: { kind: 'host-path', environmentId: ' ', worktreeSelector: 'id:wt-1' }
      })
    ).toThrow(/Invalid/)
    expect(() =>
      mint({
        ...REQUEST,
        owner: { kind: 'host-path', environmentId: 'env-1', worktreeSelector: '' }
      })
    ).toThrow(/Invalid/)
  })
})

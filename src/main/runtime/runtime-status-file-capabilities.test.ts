import { describe, expect, it, vi } from 'vitest'
import {
  FILES_HOST_PATH_RUNTIME_CAPABILITY,
  TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY
} from '../../shared/runtime-file-contracts'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('file capabilities a host advertises', () => {
  it('advertises host-path files beside the file capabilities it already had', () => {
    const { capabilities } = new OrcaRuntimeService().getStatus()
    expect(capabilities).toContain(FILES_HOST_PATH_RUNTIME_CAPABILITY)
    expect(capabilities).toContain('files.pathsExist')
    expect(capabilities).toContain(TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY)
    expect(FILES_HOST_PATH_RUNTIME_CAPABILITY).toBe('files.host-path.v1')
  })
})

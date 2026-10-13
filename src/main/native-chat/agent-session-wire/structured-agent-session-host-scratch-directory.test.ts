// The host publishes each chat's scratch folder from its own deps, for live and restored chats.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const scratchDirectoryFor = (sessionId: string): string => `/state/chat-scratch/${sessionId}`

describe('a chat scratch folder on the host status', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig({ scratchDirectoryFor })
  })

  afterEach(async () => {
    await rig.dispose()
  })

  it('rides the status of a chat the host runs', async () => {
    await foundRestTestChat(rig)

    expect(rig.host.readStatusSummary(SESSION)?.scratchDirectory).toBe(scratchDirectoryFor(SESSION))
  })

  it('is derived again for a chat a restarted host restores', async () => {
    await foundRestTestChat(rig)
    const restarted = await rig.restart({ scratchDirectoryFor })
    await restarted.restoreReadableSessions([SESSION])

    expect(restarted.readStatusSummary(SESSION)?.scratchDirectory).toBe(
      scratchDirectoryFor(SESSION)
    )
  })

  it('is absent from a host that gives chats none', async () => {
    const bare = await createRestTestRig()
    try {
      await foundRestTestChat(bare)
      expect(bare.host.readStatusSummary(SESSION)).toBeDefined()
      expect(bare.host.readStatusSummary(SESSION)).not.toHaveProperty('scratchDirectory')
    } finally {
      await bare.dispose()
    }
  })
})

import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  nativeChatScratchFolderFor,
  nativeChatScratchFolderName
} from '../native-chat-scratch-folder'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { PI_RPC_AGENT } from '../../pi/rpc-agent-definition'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'

const SESSION = 'session-alpha'
const NOW = 1_800_000_000_000

const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo-1::/repos/one',
  workspaceKind: 'git-worktree'
}
const WSL: AgentSessionExecutionLocation = { ...NATIVE, wslDistro: 'Ubuntu' }

const opencode = acpLaunchSpecFor('opencode')
const DEFINITIONS: readonly StructuredAgentDefinition[] = [
  CLAUDE_STRUCTURED_AGENT,
  CODEX_STRUCTURED_AGENT,
  PI_RPC_AGENT,
  ...(opencode ? [acpStructuredAgentDefinition(opencode)] : [])
]

let root: string
let store: AgentSessionRecordStore
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-status-feed-scratch-'))
  store = await openTestAgentSessionRecordStore(root)
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function reserve(location: AgentSessionExecutionLocation): Promise<void> {
  await store.reserveOwner({
    sessionId: SESSION,
    location,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${'1'.padStart(32, '0')}`,
      fingerprint: 'fp-1'
    },
    now: NOW
  })
}

async function subscribedFeed(
  location: AgentSessionExecutionLocation,
  options: { agent?: string; scratch?: boolean } = {}
) {
  const agent = options.agent ?? 'codex'
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: location.workspaceId,
      hostId: 'local',
      agent,
      providerHandle: agent === 'codex' ? codexProviderHandle('thread-1') : null
    },
    stateDirectory: root
  })
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([[SESSION, { journal, params: { location, provider: agent } }]]),
    getRecord: (sessionId) => store.getRecord(sessionId),
    now: () => NOW,
    ...(options.scratch === false
      ? {}
      : {
          scratchFolders: {
            folderFor: (sessionId: string) => nativeChatScratchFolderFor(root, sessionId),
            receivedBy: (name: string) =>
              DEFINITIONS.find((definition) => definition.agent === name)?.receivesScratchFolder ===
              true
          }
        })
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'renderer', emit: (event) => events.push(event) })
  return { feed, events }
}

function lastSummary(events: readonly AgentSessionStatusEvent[]) {
  const event = events.at(-1)
  if (event?.type === 'status') {
    return event.session
  }
  if (event?.type === 'snapshot') {
    return event.sessions.find((session) => session.sessionId === SESSION)
  }
  throw new Error('no status publication')
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('status feed scratch directory', () => {
  it('reads every agent from its real definition', () => {
    expect(DEFINITIONS.map((definition) => definition.agent)).toEqual([
      'claude',
      'codex',
      'pi',
      'opencode'
    ])
  })

  // The agents whose launches are handed the folder, by their definitions' flag.
  it.each(['claude', 'codex', 'opencode'])(
    'publishes a native %s chat its folder without creating it',
    async (agent) => {
      const { events } = await subscribedFeed(NATIVE, { agent })

      expect(lastSummary(events)).toMatchObject({
        sessionId: SESSION,
        scratchDirectory: nativeChatScratchFolderFor(root, SESSION)
      })
      expect(existsSync(nativeChatScratchFolderFor(root, SESSION))).toBe(false)
    }
  )

  it('omits the folder for a Pi chat, which is never handed one', async () => {
    const { events } = await subscribedFeed(NATIVE, { agent: 'pi' })

    expect(lastSummary(events)).toMatchObject({ sessionId: SESSION, agent: 'pi' })
    expect(lastSummary(events)).not.toHaveProperty('scratchDirectory')
  })

  it('omits the folder for a WSL chat, whose agent is never launched with it', async () => {
    await reserve(WSL)
    const { events } = await subscribedFeed(WSL)

    expect(lastSummary(events)).toMatchObject({ sessionId: SESSION })
    expect(lastSummary(events)).not.toHaveProperty('scratchDirectory')
  })

  it('omits the folder on a host that gives chats none', async () => {
    const { events } = await subscribedFeed(NATIVE, { scratch: false })

    expect(lastSummary(events)).toMatchObject({ sessionId: SESSION })
    expect(lastSummary(events)).not.toHaveProperty('scratchDirectory')
  })

  it('derives the same folder again after a restart and never stores it', async () => {
    await reserve(NATIVE)
    const first = await subscribedFeed(NATIVE)
    first.feed.publish(SESSION)
    const published = lastSummary(first.events)?.scratchDirectory
    expect(published).toBe(nativeChatScratchFolderFor(root, SESSION))

    await journals.closeAll()
    store = await openTestAgentSessionRecordStore(root)
    const restarted = await subscribedFeed(NATIVE)

    expect(lastSummary(restarted.events)?.scratchDirectory).toBe(published)
    expect(store.getRecord(SESSION)).not.toHaveProperty('scratchDirectory')
    // Nothing on disk names the folder: neither the record store nor the journal kept the field.
    const folderName = nativeChatScratchFolderName(SESSION)
    const stored = await Promise.all((await filesUnder(root)).map((file) => readFile(file)))
    // The scan reads where the chat is kept: its id is there.
    expect(stored.some((bytes) => bytes.includes(SESSION))).toBe(true)
    for (const bytes of stored) {
      expect(bytes.includes(folderName)).toBe(false)
      expect(bytes.includes('scratchDirectory')).toBe(false)
    }
    expect(existsSync(nativeChatScratchFolderFor(root, SESSION))).toBe(false)
  })
})

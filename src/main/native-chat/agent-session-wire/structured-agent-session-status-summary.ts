import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import { isNativeLocalLocation } from '../../../shared/execution-host'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { structuredAgentSessionProviderSessionMetadata } from './structured-agent-session-history-result'
import { agentSessionPinnedLaunchDirectory } from '../../runtime/agent-session-record-launch-directory'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'

export function structuredAgentSessionStatusSummary({
  sessionId,
  session,
  journal,
  record,
  state,
  stopping,
  childWork,
  scratchDirectoryFor,
  now
}: {
  sessionId: string
  session: {
    params: { location: AgentSessionRecord['location']; provider: AgentSessionRecord['provider'] }
    child?: Pick<StructuredAgentSessionProviderChild, 'phase'> | null
    restartResume?: AgentSessionStatusSummary['restartResume']
  }
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  state: StructuredAgentSessionStatusState
  /** A person's Stop is still ending the work it stopped. */
  stopping: boolean
  childWork: Pick<AgentSessionStatusSummary, 'children' | 'backgroundTasks'>
  /** This host's scratch folder for a chat; absent on a host that gives chats none. */
  scratchDirectoryFor?: (sessionId: string) => string | undefined
  now: () => number
}): AgentSessionStatusSummary {
  const projected = state.summary
  const providerSession = structuredAgentSessionProviderSessionMetadata(record)
  // The journal has no model: the record's acknowledged options are where a mid-session
  // switch lands, so the row follows whichever is in force.
  const model = normalizeOptionalField(record?.options?.model, AGENT_MODEL_MAX_LENGTH)
  const permissionMode = record?.options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
  // Only a chat running natively on this host is launched with the folder; a WSL agent could not
  // reach a Windows-side path.
  const scratchDirectory = isNativeLocalLocation(session.params.location)
    ? scratchDirectoryFor?.(sessionId)
    : undefined
  return {
    sessionId,
    workspaceId: session.params.location.workspaceId,
    agent: session.params.provider,
    ...(session.child
      ? {
          hostExecutionOwned: true as const,
          hostExecutionPhase: session.child.phase
        }
      : {}),
    ...(session.restartResume ? { restartResume: { phase: session.restartResume.phase } } : {}),
    ...projected,
    // Only a working session is still being stopped; any other status already ended that work.
    ...(stopping && projected.status === 'working' ? { stopping: true as const } : {}),
    ...(record?.rewind?.phase === 'prepared' || record?.rewind?.phase === 'provider-succeeded'
      ? { rewindBlockedReason: 'outcome-unknown' as const }
      : {}),
    ...(model ? { model } : {}),
    ...(isAgentChatPermissionMode(permissionMode) ? { permissionMode } : {}),
    ...childWork,
    ...(providerSession ? { providerSession } : {}),
    ...(launchDirectory ? { launchDirectory } : {}),
    ...(scratchDirectory ? { scratchDirectory } : {}),
    ...(record?.conversationName ? { conversationName: record.conversationName } : {}),
    updatedAt: journal.lastActivityAt() || now()
  }
}

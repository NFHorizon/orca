import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import type { AgentSessionRecord } from './agent-session-record'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentSessionRewindReason } from './agent-session-rewind'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type { AgentTurnOutcome } from './agent-turn-outcome'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'

// Status feed: each session's projected STATE, beside the turn completion feed's EDGES.

/** What a session list needs to know about one session. The host projects it
 *  from the journal so no client has to replay a transcript to learn whether a
 *  turn is running. Additive surface: an older host has no such method. */
export type AgentSessionStatusSummary = {
  rewindBlockedReason?: AgentSessionRewindReason
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
  /** Null until the journal holds a persisted user or assistant message. */
  status: StructuredAgentSessionProjectedStatus | null
  /** Present only while this host has the provider child executing the session. */
  hostExecutionOwned?: true
  /** With `hostExecutionOwned`: whether that child has proven its start. `starting` is a
   *  published session whose provider has not yet answered startup; absent on older hosts. */
  hostExecutionPhase?: 'starting' | 'ready'
  /** This restart action's progress, derived by the live host and never persisted.
   *  Cleared when the action returns; absent on older hosts. */
  restartResume?: {
    phase: 'queued' | 'starting' | 'continued' | 'refused' | 'unconfirmed' | 'skipped'
  }
  latestPrompt: string
  /** Provider model in force for the next turn; absent until the host has read the options. */
  model?: string
  /** The chat's saved permission mode; a client re-reads options when it or `model` moves. */
  permissionMode?: string
  /** The tool the running turn is inside, else the last one it used. Absent unless `status`
   *  is 'working'. */
  toolName?: string
  toolInput?: string
  /** Preview of the newest assistant prose, so a settled row says what the agent said. */
  lastAssistantMessage?: string
  /** The verdict on the latest request: the provider's, or, when it gave none, what the host
   *  observed of the turn's end. Present only while `status` is `idle`: a running or
   *  attention-blocked turn has no verdict yet, and a stale one must not ride along. Absent means
   *  UNKNOWN, never success. Optional for mixed-version hosts; an older client reads an arm it
   *  does not know as no verdict. The agent-status row publishes it as `mainAgent.outcome`. */
  turnOutcome?: AgentTurnOutcome
  /** Present only while `status` is 'working' and a person's Stop is still ending that work: while
   *  the Stop settles, then until the turn it stopped or failed to stop ends. A Stop that settles
   *  having stopped nothing clears it. Derived by the host, never stored. Absent from older hosts;
   *  an older client ignores it. */
  stopping?: true
  /** Live provider-owned background tasks, so session lists can render
   *  subagent children without holding a journal reader open. Optional for
   *  mixed-version hosts. Derived from `children` on hosts that publish it. */
  backgroundTasks?: AgentSessionBackgroundTask[]
  /** The host's running child records for this session, as views: live ones, and a finished one
   *  whose own work still runs (it reads monitoring); finished children ride the background-task
   *  channel only. Absent from older hosts; decode with `decodeAgentChildWorkViews`. Usage is
   *  omitted, and an evidence clock that only ticked does not republish: per-tick freshness rides
   *  the background-task channel. */
  children?: AgentChildWorkView[]
  providerSession?: AgentProviderSessionMetadata
  /** The record's saved conversation name; absent while unnamed and from older hosts. Rides this
   *  feed because a retained summary outlives the chat's tab, so a closed chat keeps its name. */
  conversationName?: string
  /** Host-path directory the session is held to regardless of its workspace's current directory
   *  (a floating chat's pinned folder). Absent means resolve the workspace id; older hosts omit it. */
  launchDirectory?: string
  /** Absolute host-native path of this chat's own scratch folder on its host, where its inline
   *  visuals are written. Derived by the host on every publish, never stored, and not created by
   *  publishing, so the folder may not exist yet. Absent where the host delivers no such folder
   *  (WSL chats) and from older hosts. */
  scratchDirectory?: string
  updatedAt: number
  /** When the session's own agent entered `status`, dated by its own lifecycle edges and never by
   *  row activity: `updatedAt` also moves for a subagent's rows. Absent from older hosts, and when
   *  the journal records no such edge; readers then keep dating the state themselves. */
  statusStartedAt?: number
}

/** A summary outlives its provider child: an evicted idle session is still idle, so the host
 *  keeps the last projection and never retracts one. Tabs, not this feed, decide what is listed. */
export type AgentSessionStatusEvent =
  | { type: 'snapshot'; sessions: AgentSessionStatusSummary[] }
  | { type: 'status'; session: AgentSessionStatusSummary }
  | { type: 'end' }

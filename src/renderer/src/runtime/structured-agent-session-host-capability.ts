import { useEffect, useState } from 'react'
import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

export function structuredAgentSessionHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

/** `unknown` until the host has answered, and after a failed probe: a failed probe is not
 *  evidence about the host. */
export type StructuredAgentSessionHostCapabilityState = 'unknown' | 'supported' | 'unsupported'

/** A host capability answer, and whether the probe that may change it is still running. */
export type StructuredAgentSessionHostCapabilityProbe = {
  state: StructuredAgentSessionHostCapabilityState
  /** Names the probe now running or last settled; a new probe starts on each regained contact. */
  probe: string
  /** From a probe's start until it settles; a failed probe has settled. */
  probing: boolean
}

/** Whether the session's host advertises `capability`. A failed probe stays `unknown` and a remote
 *  host is asked again each time this client regains contact with it. */
export function useStructuredAgentSessionHostCapabilityState(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCapabilityProbe(target, capability).state
}

/** {@link useStructuredAgentSessionHostCapabilityState}, also saying whether its probe still runs. */
export function useStructuredAgentSessionHostCapabilityProbe(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityProbe {
  const key = structuredAgentSessionHostKey(target)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [contact, setContact] = useState(0)
  const probe = `${key}|${capability}|${contact}`
  const [answer, setAnswer] = useState<{
    key: string
    probe: string | null
    state: StructuredAgentSessionHostCapabilityState
  }>(() => ({
    key,
    probe: null,
    state: target.kind === 'local' ? localCapabilityState(capability) : 'unknown'
  }))
  useEffect(() => {
    if (environmentId === null) {
      return
    }
    return subscribeRuntimeHostContactRegained(environmentId, () => setContact((n) => n + 1))
  }, [environmentId])
  useEffect(() => {
    let cancelled = false
    const probing: Promise<StructuredAgentSessionHostCapabilityState> =
      environmentId === null
        ? ensureLocalRuntimeCapabilities().then(() => localCapabilityState(capability))
        : runtimeEnvironmentSupportsCapability(environmentId, capability).then((supported) =>
            supported ? 'supported' : 'unsupported'
          )
    void probing
      .catch((): StructuredAgentSessionHostCapabilityState => 'unknown')
      .then((state) => {
        if (!cancelled) {
          setAnswer((current) =>
            current.key === key && current.state === state && current.probe === probe
              ? current
              : { key, probe, state }
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [capability, environmentId, key, probe])
  return answer.key === key
    ? { state: answer.state, probe, probing: answer.probe !== probe }
    : { state: 'unknown', probe, probing: true }
}

function localCapabilityState(
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  const capabilities = readLocalRuntimeCapabilitiesOrUnknown()
  return capabilities === null
    ? 'unknown'
    : capabilities.includes(capability)
      ? 'supported'
      : 'unsupported'
}

/** Whether the session's host advertises `capability`. False until the host has said so, and for
 *  a failed probe: an older host is handled as it always was. */
export function useStructuredAgentSessionHostCapability(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): boolean {
  return useStructuredAgentSessionHostCapabilityState(target, capability) === 'supported'
}

/** Whether the host takes a Stop naming no turn: the only Stop before the provider opens one. */
export function useStructuredAgentSessionHostStopsConversation(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
  )
}

/** Whether the host settles a rewind left in doubt on the next send, agent running or not: only
 *  then may a client offer a rewind, which hands an in-doubt prompt back for that send. */
export function useStructuredAgentSessionHostRecoversRewindOnSend(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(target, AGENT_SESSION_REWIND_RECOVERY_CAPABILITY)
}

/** Whether the host holds mid-turn sends as drafts: only then may a client send `delivery`. The
 *  published cards and their queuedMessage actions are not gated on it. */
export function useStructuredAgentSessionHostQueuesMessages(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostQueuesMessagesState(target) === 'supported'
}

/** Three-state: only `supported` lets a send ask to be queued; `unknown` holds nothing back. */
export function useStructuredAgentSessionHostQueuesMessagesState(
  target: RuntimeClientTarget
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
  )
}

/** Whether the host holds a /compact sent while the agent works as a queued card: only then may
 *  a client send the command's `delivery`, and only where it also renders the queue's cards. */
export function useStructuredAgentSessionHostQueuesCommands(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY
  )
}

/** Whether the host edits a queued card in place and holds it from delivery while edited. Until
 *  it says so, and against an older host, a card offers no Edit. */
export function useStructuredAgentSessionHostEditsQueuedMessages(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY
  )
}

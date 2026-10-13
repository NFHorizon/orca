import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type { StructuredAgentTranscriptImport } from '../native-chat/structured-agent-cli-conversations'

export const OMP_TRANSCRIPT_IMPORT: StructuredAgentTranscriptImport = {
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  // Where OMP itself keeps the account's sessions, which is not always under it (XDG_DATA_HOME).
  findTranscript: async ({ providerSessionId, accountHomePath, launchEnv }) => {
    const sessionsDir = resolveOmpSessionsDir({
      env: { ...launchEnv, PI_CODING_AGENT_DIR: accountHomePath },
      homeDir: launchEnv.HOME ?? launchEnv.USERPROFILE
    })
    return sessionsDir
      ? resolveSessionFilePath('omp', providerSessionId, { ompSessionsDir: sessionsDir })
      : null
  }
}

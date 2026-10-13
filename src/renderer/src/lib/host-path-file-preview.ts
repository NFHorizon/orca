import { webClientDocPreviewRefusal } from '@/lib/doc-preview-web-client'
import type { WorkspaceFilePreviewPlan } from '@/lib/file-preview'
import { statHostPathFile } from '@/components/terminal-pane/terminal-host-workspace-file'
import type { AppState } from '@/store/types'

type OutsideWorktreePlan = Extract<WorkspaceFilePreviewPlan, { reason: 'outside-worktree' }>

/** A paired document outside its workspace, once its host has said it serves that path. */
export function hostPathFilePreviewPlan(): WorkspaceFilePreviewPlan {
  return webClientDocPreviewRefusal() ?? { status: 'doc-preview' }
}

/**
 * Asks the host that refused a document outside its workspace whether it serves that path (today:
 * its chat scratch folder). Any other path, an older host or a failed check keeps the refusal.
 */
export async function resolveHostPathFilePreviewPlan(
  state: AppState,
  document: { worktreeId: string; filePath: string },
  refusal: OutsideWorktreePlan
): Promise<WorkspaceFilePreviewPlan> {
  try {
    const served = await statHostPathFile(
      {
        target: { kind: 'environment', environmentId: refusal.environmentId },
        worktreeId: document.worktreeId,
        worktreePath: state.getKnownWorktreeById(document.worktreeId)?.path ?? null
      },
      document.filePath
    )
    return served && !served.isDirectory ? hostPathFilePreviewPlan() : refusal
  } catch {
    return refusal
  }
}

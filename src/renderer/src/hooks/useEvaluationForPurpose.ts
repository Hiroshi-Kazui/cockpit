// Tracks a single purpose's current evaluation (M9, ADR-0010): loads the latest row on mount, then stays
// live via the evaluationUpdated push channel main/evaluation/evaluationCoordinator.ts fires on every
// pending -> ok/error/skipped transition (and report_state follow-up) -- same "load once + subscribe push,
// filter by id" convention as useMirrorStatus.ts / App.tsx's purposesByPane.
import { useEffect, useState } from 'react'
import type { EvaluationSummary } from '@shared/ipc'

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface UseEvaluationForPurposeResult {
  /** null while loading, or when the purpose has never had an evaluation run for it yet. */
  evaluation: EvaluationSummary | null
  loadError: string | null
}

export function useEvaluationForPurpose(purposeId: string | null): UseEvaluationForPurposeResult {
  const [evaluation, setEvaluation] = useState<EvaluationSummary | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    setEvaluation(null)
    setLoadError(null)
    if (!purposeId) return
    let cancelled = false
    window.cockpit.evaluation
      .getForPurpose({ purposeId })
      .then((result) => {
        if (!cancelled) setEvaluation(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [purposeId])

  useEffect(() => {
    const unsubscribe = window.cockpit.evaluation.onUpdated((summary) => {
      if (purposeId && summary.purposeId === purposeId) setEvaluation(summary)
    })
    return unsubscribe
  }, [purposeId])

  return { evaluation, loadError }
}

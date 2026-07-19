// Implements spec §4.2's "目的が空で開始した場合" (M4 extension): watches the same raw JSONL batches
// SessionCoordinator/UsageCoordinator already consume (independent consumer, same pattern as
// usageCoordinator.ts -- see main/index.ts's wiring) for a session whose purpose is still pending
// (created with empty text, active, not yet decided), and hands the first non-command human chat turn
// found off to PurposeCoordinator.decidePurposeFromFirstMessage to persist + generate a title from.
//
// Deliberately stateless/query-driven rather than caching "which purposeIds are pending" in memory: it
// re-derives that straight from the store (via the injected getPendingPurposeId) on every batch, so it
// can never drift out of sync with a decision that has already landed -- including one made from a
// *different* session under the same active purpose after a `/clear` (TD-2 keeps the purpose, not the
// session, as the long-lived unit), or a purpose that has since been "完了"-ed without the user ever
// speaking (spec §4.2: "ユーザーが一度も発言せずセッションを終えた場合、目的は未設定のまま" -- once
// completed, getPendingPurposeId's `status === 'active'` check makes this permanently a no-op for that
// purpose, so stray late transcript activity can never resurrect a decision after the fact).
//
// FIX (minor, origin-drift diagnostic -- purity pass): shared/jsonl.ts is a pure parser and must stay
// that way, so the origin-drift diagnostic (a future claude CLI version silently no longer tagging genuine
// human turns with `origin.kind==='human'`, which would make spec §4.2's purpose auto-detection a silent
// permanent no-op) lives here instead: this coordinator already scans every batch's ParsedJsonlEntry[], so
// it tallies `isUserTurnMissingHumanOrigin` occurrences across calls (instance-held counter, this class's
// only mutable state) and emits a low-frequency `warn` per `shouldLogOriginDrift`'s sampling. Does not
// change purpose-detection behavior in any way -- purely observational, same as the diagnostic it replaces.
import { findFirstPurposeCandidate } from '../../shared/purposeDetection'
import { shouldLogOriginDrift, type ParsedJsonlEntry } from '../../shared/jsonl'

export interface PurposeDetectionDeps {
  /** Returns the purposeId to try to decide for this session's JSONL activity, or null if there is
   * nothing pending: the session isn't linked to a purpose, that purpose already has decided (non-empty)
   * text, or the purpose has since been completed. */
  getPendingPurposeId: (sessionId: string) => string | null
  onPurposeDecided: (purposeId: string, text: string) => void
  /** Sink for the origin-drift diagnostic message (see file header). Defaults to `console.warn`; tests
   * inject a fake to assert on without polluting test output. */
  warn?: (message: string) => void
}

export class PurposeDetectionCoordinator {
  private readonly warn: (message: string) => void
  private originDriftOccurrences = 0

  constructor(private readonly deps: PurposeDetectionDeps) {
    this.warn = deps.warn ?? ((message) => console.warn(message))
  }

  /** Call with every batch of newly-parsed JSONL entries for a session (the same batch SessionCoordinator
   * and UsageCoordinator already receive via the archiver, see main/index.ts's wiring). No-op if the
   * session has no pending (empty, active, undecided) purpose, or if no qualifying candidate is found in
   * this batch (the caller will simply be called again with the next batch). */
  onJsonlEntries(sessionId: string, entries: readonly ParsedJsonlEntry[]): void {
    this.recordOriginDriftDiagnostics(entries)

    const purposeId = this.deps.getPendingPurposeId(sessionId)
    if (!purposeId) return
    const candidate = findFirstPurposeCandidate(entries)
    if (candidate === null) return
    this.deps.onPurposeDecided(purposeId, candidate)
  }

  /** See file header. Runs over every batch this coordinator sees (independent of whether the session has
   * a pending purpose), mirroring the coverage of the diagnostic this replaced. */
  private recordOriginDriftDiagnostics(entries: readonly ParsedJsonlEntry[]): void {
    for (const entry of entries) {
      if (!entry.isUserTurnMissingHumanOrigin) continue
      this.originDriftOccurrences++
      if (!shouldLogOriginDrift(this.originDriftOccurrences)) continue
      this.warn(
        `[jsonl] observed a type==='user' transcript turn without origin.kind==='human' ` +
          `(occurrence #${this.originDriftOccurrences}, sampled). Usually expected and harmless ` +
          `(tool_result echoes, task-notifications, sdk turns all look like this by design) -- worth ` +
          `investigating only if genuine human turns have stopped carrying origin.kind==='human' after a ` +
          `claude CLI upgrade (spec §4.2 purpose auto-detection would silently stop working).`
      )
    }
  }
}

// Write-through of the M9 evaluation report (Markdown + JSON) to the user-configured output root
// (ADR-0010 D-5). Every write is temp-file-then-rename so a crash/power-loss mid-write can never leave a
// half-written report at the final path, and every file is named solely after the (always-fresh, UUID)
// evaluation id (shared/evaluationReport.ts's evaluationReportFileNames) -- there is no overwrite/delete
// path here at all (R-5 "既存ファイルの上書き・削除経路がない").
import fs from 'node:fs'
import path from 'node:path'
import { evaluationReportFileNames } from '../../shared/evaluationReport'

export type WriteEvaluationReportResult = { ok: true } | { ok: false; reason: string }

async function writeFileAtomic(finalPath: string, content: string): Promise<void> {
  const tmpPath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.tmp-${process.pid}-${Date.now()}`
  )
  const handle = await fs.promises.open(tmpPath, 'w')
  try {
    await handle.writeFile(content, 'utf-8')
  } finally {
    await handle.close()
  }
  await fs.promises.rename(tmpPath, finalPath)
}

/** D-5 i18n precedent (fsSink.ts's describeProbeErrno): the rest of the UI is Japanese, so a bare
 * English/errno message would read as untranslated. */
function describeError(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined
  const detail = err instanceof Error ? err.message : String(err)
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `評価レポートの出力先に書き込めません（アクセス権限がありません）: ${detail}`
    case 'ENOSPC':
      return `評価レポートの出力先に書き込めません（空き容量が不足しています）: ${detail}`
    case 'EROFS':
      return `評価レポートの出力先に書き込めません（読み取り専用です）: ${detail}`
    default:
      return `評価レポートの書き出しに失敗しました: ${detail}`
  }
}

/**
 * Writes `<root>/<evalId>.md` and `<root>/<evalId>.json`. Never throws -- returns a discriminated result
 * so the caller (evaluationCoordinator.ts) can record `report_state='error'` without ever failing the
 * evaluation itself (R-5 "レポート書き出し失敗は評価自体を error にせず").
 */
export async function writeEvaluationReportFiles(
  root: string,
  evalId: string,
  markdown: string,
  json: string
): Promise<WriteEvaluationReportResult> {
  try {
    await fs.promises.mkdir(root, { recursive: true })
    const names = evaluationReportFileNames(evalId)
    await writeFileAtomic(path.join(root, names.markdown), markdown)
    await writeFileAtomic(path.join(root, names.json), json)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: describeError(err) }
  }
}

// Pure helper for building safe SQL LIKE patterns (M5, spec §4.4 "検索"). SQLite's LIKE operator treats
// `%` and `_` as wildcards; a search string that happens to contain either would otherwise silently
// behave as a wildcard match rather than a literal one. This escapes all three characters LIKE assigns
// special meaning to (`%`, `_`, and the escape character `\` itself) so the caller can bind the result as
// a literal-text-containing pattern via `LIKE ? ESCAPE '\'`.
//
// This function only prevents *wildcard-meaning* injection (a user typing a literal `%`/`_` searching as
// a wildcard instead of literal text). It is not itself the SQL-injection defense -- the caller
// (main/db/sessionRepo.ts) must still always pass the resulting pattern through a parameter-bound
// placeholder (`?`), never string-concatenated into the SQL text; escaping alone does not substitute for
// parameter binding.
export function escapeLikePattern(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** Wraps an escaped search term in `%...%` for a "contains" LIKE match. */
export function buildContainsLikePattern(text: string): string {
  return `%${escapeLikePattern(text)}%`
}

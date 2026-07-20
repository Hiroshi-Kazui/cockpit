// The ArchiveSink abstraction (ADR-0008/D-3): where mirrored bytes actually land. Today the only
// implementation is fsSink.ts (a local path or a cloud sync client's mounted/synced folder, Tier 1
// support). Isolating the write surface behind this interface is what lets a future `DriveApiSink`
// (direct Google Drive API upload, Tier 2, explicitly out of scope for M6) be added later without any
// change to mirrorCoordinator.ts or the archive_mirror schema (ADR-0008 "帰結").
export interface ArchiveSink {
  /** Current size (bytes) of the destination transcript.jsonl for a session, or null if it does not
   * exist yet at the destination. Throws only for a genuine I/O error (destination unreachable/offline) --
   * callers must treat that as a mirror-sync failure (archive_mirror.state = 'error'), never silently. */
  statTranscript(sessionId: string): Promise<number | null>
  /** Appends `buffer` to the destination transcript.jsonl. Implementations must verify the destination
   * file's actual current size equals `offset` immediately before writing, and throw rather than
   * overwrite/truncate if it does not (append-only enforcement at the mirror destination, spec §4.4 /
   * ADR-0008/D-4 -- this is what "ミラー先がスプールより大きい場合は上書きせずエラー化" means in practice). */
  appendTranscript(sessionId: string, offset: number, buffer: Buffer): Promise<void>
  /** Overwrites metadata.json at the destination. Not append-only -- metadata.json is app-owned derived
   * data on the spool side too (see main/archive/metadataWriter.ts's header comment for why overwriting
   * it does not violate the append-only invariant, which applies to transcript.jsonl only). */
  writeMetadata(sessionId: string, json: string): Promise<void>
  /** Reads back the first `length` bytes of the destination transcript.jsonl. Used only to *verify*
   * (content, not just size) that an already-present destination file is a genuine prefix of the spool
   * before automatic sync resumes writing to it (mirrorCoordinator.ts's rebaselineSession) -- two
   * different byte ranges of the same length are otherwise indistinguishable from `statTranscript` alone,
   * which is exactly the gap a root-switch-back-and-forth (A -> B -> A) can otherwise silently fall into. */
  readTranscriptPrefix(sessionId: string, length: number): Promise<Buffer>
}

/**
 * A source item (Linear issue or Attio task) normalized into the shape the
 * reconciler needs. The reconciler is source-agnostic — it only sees these.
 */
export interface SourceItem {
  /** Stable dedupe key embedded in the Google task notes, e.g. "linear:<id>". */
  key: string;
  /** Google task title (already includes the identifier prefix where available). */
  title: string;
  /** Human identifier, e.g. "CORE-123". Linear only; null for Attio. */
  identifier: string | null;
  /** Whether the source item is done (completed or canceled). */
  done: boolean;
  /** RFC 3339 timestamp for the Google `due` field, or null. */
  due: string | null;
  /** Links rendered into the notes body. */
  links: { label: string; url: string }[];
  /** Extra freeform lines added to the notes (e.g. the Attio task id). */
  extraNotes?: string[];
}

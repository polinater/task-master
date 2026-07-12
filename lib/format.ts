/** Format an ISO timestamp as "YYYY-MM-DD HH:MM:SS UTC" for task notes. */
export function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

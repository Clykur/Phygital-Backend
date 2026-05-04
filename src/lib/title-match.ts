/**
 * Normalize title for request ↔ copy matching (JS + DB regexp_replace should stay aligned
 * where possible; this also catches Unicode variants SQL lower() may not fold the same way).
 */
export function normalizeBookTitle(title: string): string {
  try {
    return title
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  } catch {
    return title.trim().toLowerCase().replace(/\s+/g, " ");
  }
}

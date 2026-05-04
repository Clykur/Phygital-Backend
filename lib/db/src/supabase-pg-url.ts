export function withSupabasePgCompat(connectionString: string): string {
  if (!/supabase\.(co|com)/i.test(connectionString)) {
    return connectionString;
  }
  const qIndex = connectionString.indexOf("?");
  const base = qIndex === -1 ? connectionString : connectionString.slice(0, qIndex);
  const query = qIndex === -1 ? "" : connectionString.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  if (!params.has("uselibpqcompat")) {
    params.set("uselibpqcompat", "true");
  }
  if (!params.has("sslmode")) {
    params.set("sslmode", "require");
  }
  const next = params.toString();
  return next ? `${base}?${next}` : base;
}

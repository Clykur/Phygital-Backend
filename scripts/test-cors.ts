const BACKEND_ORIGIN = "https://phygital-backend-qatz.onrender.com";
type OriginRule =
  | { kind: "exact"; origin: string }
  | { kind: "wildcard"; scheme: "http" | "https"; suffix: string };

function parseAllowedOrigins(): OriginRule[] {
  const raw = process.env.ALLOWED_ORIGINS?.trim();
  if (!raw) {
    return [
      { kind: "exact", origin: "https://phygitallibrary.vercel.app" },
      { kind: "wildcard", scheme: "https", suffix: ".vercel.app" },
      { kind: "exact", origin: "http://localhost:5173" },
      { kind: "exact", origin: "http://localhost:5174" },
      { kind: "exact", origin: "http://localhost:3000" },
      { kind: "exact", origin: "http://127.0.0.1:3000" },
      { kind: "exact", origin: BACKEND_ORIGIN },
    ];
  }

  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): OriginRule => {
      if (s.includes("*")) {
        const m = /^(https?):\/\/\*\.(.+)$/i.exec(s);
        if (!m) return { kind: "exact", origin: s };
        return {
          kind: "wildcard",
          scheme: m[1]!.toLowerCase() as "http" | "https",
          suffix: `.${m[2]}`,
        };
      }
      return { kind: "exact", origin: s };
    });

  if (!parsed.some((r) => r.kind === "exact" && r.origin === BACKEND_ORIGIN)) {
    parsed.push({ kind: "exact", origin: BACKEND_ORIGIN });
  }
  return parsed;
}

function isAllowedOrigin(origin: string, rules: OriginRule[]): boolean {
  for (const r of rules) {
    if (r.kind === "exact") {
      if (origin === r.origin) return true;
      continue;
    }
    try {
      const u = new URL(origin);
      if (u.protocol !== `${r.scheme}:`) continue;
      if (!u.hostname.endsWith(r.suffix)) continue;
      const host = u.hostname.toLowerCase();
      if (host === r.suffix.slice(1)) continue;
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

console.log("Allowed:", isAllowedOrigin("http://localhost:3000", parseAllowedOrigins()));
console.log("RAW env:", process.env.ALLOWED_ORIGINS);

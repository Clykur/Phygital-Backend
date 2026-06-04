import fs from 'fs';

let content = fs.readFileSync('src/middleware/cors.ts', 'utf8');

const newParse = `function parseAllowedOrigins(): OriginRule[] {
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
        const m = /^(https?):\\/\\/\\*\\.(.+)$/i.exec(s);
        if (!m) return { kind: "exact", origin: s };
        return { kind: "wildcard", scheme: m[1]!.toLowerCase() as "http" | "https", suffix: \`.\${m[2]}\` };
      }
      return { kind: "exact", origin: s };
    });

  if (!parsed.some((r) => r.kind === "exact" && r.origin === "http://localhost:3000")) {
    parsed.push({ kind: "exact", origin: "http://localhost:3000" });
  }
  if (!parsed.some((r) => r.kind === "exact" && r.origin === BACKEND_ORIGIN)) {
    parsed.push({ kind: "exact", origin: BACKEND_ORIGIN });
  }
  return parsed;
}`;

content = content.replace(/function parseAllowedOrigins\(\): OriginRule\[\] \{[\s\S]*?return \[\n[\s\S]*?\];\n\}/, newParse);
fs.writeFileSync('src/middleware/cors.ts', content);

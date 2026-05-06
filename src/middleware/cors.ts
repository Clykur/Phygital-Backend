import type { Request, Response, NextFunction } from "express";

const ALLOW_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type";
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
      { kind: "exact", origin: BACKEND_ORIGIN },
    ];
  }

  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): OriginRule => {
      if (s.includes("*")) {
        // Supports: https://*.vercel.app
        const m = /^(https?):\/\/\*\.(.+)$/i.exec(s);
        if (!m) return { kind: "exact", origin: s };
        return { kind: "wildcard", scheme: m[1]!.toLowerCase() as "http" | "https", suffix: `.${m[2]}` };
      }
      return { kind: "exact", origin: s };
    });

  // Never allow the backend origin to be accidentally omitted.
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
      // Require at least one label before the suffix, so *.vercel.app matches foo.vercel.app, not vercel.app.
      const host = u.hostname.toLowerCase();
      if (host === r.suffix.slice(1)) continue;
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function allowCredentials(): boolean {
  return (
    process.env.CORS_ALLOW_CREDENTIALS === "1" ||
    process.env.CORS_ALLOW_CREDENTIALS === "true"
  );
}

/**
 * Global CORS middleware.
 * - Runs before auth so even 401/500 responses include CORS headers.
 * - Handles `/api/*` preflight OPTIONS with 204 and required headers.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") {
    // Non-browser clients (curl/Postman) typically omit Origin.
    next();
    return;
  }

  const rules = parseAllowedOrigins();
  if (!isAllowedOrigin(origin, rules)) {
    // For disallowed origins, do not set ACAO; browser will block.
    if (req.method === "OPTIONS" && (req.originalUrl || req.url || "").startsWith("/api/")) {
      res.status(204).end();
      return;
    }
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
  if (allowCredentials()) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  if (req.method === "OPTIONS" && (req.originalUrl || req.url || "").startsWith("/api/")) {
    res.status(204).end();
    return;
  }

  next();
}


import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { loadAuthUser } from "../lib/auth-user";
import type { AuthUser } from "../lib/rbac/types";

declare global {
  namespace Express {
    interface Request {
      auth: AuthUser | null;
    }
  }
}

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  req.auth = null;
  const h = req.headers.authorization;
  const token = h?.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) {
    next();
    return;
  }
  try {
    const payload = await verifyToken(token);
    const user = await loadAuthUser(payload.sub);
    req.auth = user;
  } catch {
    req.auth = null;
  }
  next();
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function normalizePathname(url: string): string {
  const p = url.split("?")[0] ?? "";
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

/**
 * Unauthenticated access is only allowed for sign-in / sign-up and CORS preflight.
 * All other `/api/*` requests require a valid `Authorization: Bearer` session.
 */
const PUBLIC_API: { method: string; path: string }[] = [
  { method: "POST", path: "/api/auth/login" },
  { method: "POST", path: "/api/auth/register" },
];

export function requireApiAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  const pathname = normalizePathname(req.originalUrl || req.url || "");
  if (
    PUBLIC_API.some(
      (r) => r.method === req.method && r.path === pathname,
    )
  ) {
    next();
    return;
  }
  requireAuth(req, res, next);
}

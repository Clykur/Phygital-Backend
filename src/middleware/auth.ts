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

import { logger } from "../lib/logger";


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

    if (!user) {
      logger.warn(
        {
          authFlow: true,
          tokenSub: payload.sub,
          baseRole: payload.baseRole,
          reason: "token_valid_but_user_not_loaded_or_account_inactive",
        },
        "auth middleware: token verified but user missing/inactive",
      );
    }
  } catch (err) {
    logger.warn(
      {
        authFlow: true,
        err: err instanceof Error ? err.message : String(err),
      },
      "auth middleware: token verification failed",
    );
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
 * Paths that never require a bearer token (public browse + auth entry).
 * Portals and mutations still require `requireAuth` on individual routes.
 */
const PUBLIC_AUTH: { method: string; path: string }[] = [
  { method: "POST", path: "/api/auth/login" },
  { method: "POST", path: "/api/auth/register" },
];

const PUBLIC_GET_PATHS = new Set([
  "/api/healthz",
  "/api/ready",
  "/api/catalog/books",
  "/api/catalog/hubs",
  "/api/p2p/listings",
  "/api/placeholder-book-cover-url",
]);

function isPublicUnauthenticated(pathname: string, method: string): boolean {
  if (PUBLIC_AUTH.some((r) => r.method === method && r.path === pathname)) {
    return true;
  }
  if (method === "GET" && PUBLIC_GET_PATHS.has(pathname)) {
    return true;
  }
  return false;
}

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
  if (isPublicUnauthenticated(pathname, req.method)) {
    next();
    return;
  }
  requireAuth(req, res, next);
}

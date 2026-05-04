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

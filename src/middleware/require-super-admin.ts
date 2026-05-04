import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "./auth";

/**
 * `requireAuth` then ensure {@link import("../lib/rbac/types").AuthUser} has `baseRole === "super_admin"`.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.auth!.baseRole !== "super_admin") {
      res.status(403).json({ error: "Super admin only" });
      return;
    }
    next();
  });
}

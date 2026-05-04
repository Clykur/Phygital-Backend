import type { Request, Response, NextFunction } from "express";

const buckets = new Map<string, number[]>();

function windowMs(): number {
  const raw = process.env["API_RATE_LIMIT_WINDOW_MS"];
  const n = raw ? Number(raw) : 60_000;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function maxForUser(): number {
  const raw = process.env["API_RATE_LIMIT_USER_MAX"];
  const n = raw ? Number(raw) : 120;
  return Number.isFinite(n) && n > 0 ? n : 120;
}

function maxForIp(): number {
  const raw = process.env["API_RATE_LIMIT_IP_MAX"];
  const n = raw ? Number(raw) : 60;
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function clientIp(req: Request): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0]!.trim() || "unknown";
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * Sliding-window request cap: per authenticated user, else per IP.
 */
export function apiRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === "GET" && (req.path === "/healthz" || req.path.endsWith("/healthz"))) {
    next();
    return;
  }
  const w = windowMs();
  const now = Date.now();
  const auth = req.auth;
  const key = auth ? `u:${auth.userId}` : `ip:${clientIp(req)}`;
  const max = auth ? maxForUser() : maxForIp();

  const arr = (buckets.get(key) ?? []).filter((t) => now - t < w);
  if (arr.length >= max) {
    res.status(429).json({
      error: "Too many requests. Slow down and try again shortly.",
    });
    return;
  }
  arr.push(now);
  buckets.set(key, arr);
  next();
}

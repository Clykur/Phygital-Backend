import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

const buckets = new Map<string, number[]>();

let pruneCounter = 0;

function normalizePathname(url: string): string {
  const p = url.split("?")[0] ?? "";
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

function windowMs(): number {
  const raw = process.env["API_RATE_LIMIT_WINDOW_MS"];
  const n = raw ? Number(raw) : 60_000;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function maxForUser(): number {
  const raw = process.env["API_RATE_LIMIT_USER_MAX"];
  const n = raw ? Number(raw) : 200;
  return Number.isFinite(n) && n > 0 ? n : 200;
}

function maxForIp(): number {
  const raw = process.env["API_RATE_LIMIT_IP_MAX"];
  const n = raw ? Number(raw) : 100;
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** Tighter cap for unauthenticated `POST /api/auth/login` & `register` (per IP). */
function authWindowMs(): number {
  const raw = process.env["API_RATE_LIMIT_AUTH_WINDOW_MS"];
  const n = raw ? Number(raw) : 900_000;
  return Number.isFinite(n) && n > 0 ? n : 900_000;
}

function maxForAuthIp(): number {
  const raw = process.env["API_RATE_LIMIT_AUTH_IP_MAX"];
  const n = raw ? Number(raw) : 20;
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function clientIp(req: Request): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0]!.trim() || "unknown";
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isAuthCredentialPath(method: string, pathname: string): boolean {
  return (
    method === "POST" &&
    (pathname === "/api/auth/login" || pathname === "/api/auth/register")
  );
}

function isHealthPath(path: string | undefined): boolean {
  if (!path) return false;
  return path === "/healthz" || path.endsWith("/healthz");
}

function maybePruneBuckets(w: number, now: number): void {
  pruneCounter += 1;
  if (pruneCounter < 2000 && buckets.size < 20_000) return;
  pruneCounter = 0;
  const cutoff = now - 2 * w;
  for (const [key, times] of buckets) {
    const next = times.filter((t) => t > cutoff);
    if (next.length === 0) buckets.delete(key);
    else buckets.set(key, next);
  }
}

function resetApprox(now: number, arr: number[], w: number): number {
  const oldest = arr.length ? Math.min(...arr) : now;
  return Math.ceil((oldest + w) / 1000);
}

/**
 * Sliding-window caps:
 * - Authenticated: per userId (`API_RATE_LIMIT_USER_MAX` / `API_RATE_LIMIT_WINDOW_MS`)
 * - Anonymous: per IP (`API_RATE_LIMIT_IP_MAX`)
 * - Login/register only: stricter per IP (`API_RATE_LIMIT_AUTH_IP_MAX` / `API_RATE_LIMIT_AUTH_WINDOW_MS`)
 */
export function apiRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  if (req.method === "GET" && isHealthPath(req.path)) {
    next();
    return;
  }

  const pathname = normalizePathname(req.originalUrl || req.url || "");
  const authTier = isAuthCredentialPath(req.method, pathname);
  const w = authTier ? authWindowMs() : windowMs();
  const now = Date.now();
  maybePruneBuckets(Math.max(windowMs(), authWindowMs()), now);

  const auth = req.auth;
  let key: string;
  let max: number;

  if (authTier) {
    key = `auth:${clientIp(req)}`;
    max = maxForAuthIp();
  } else if (auth) {
    key = `u:${auth.userId}`;
    max = maxForUser();
  } else {
    key = `ip:${clientIp(req)}`;
    max = maxForIp();
  }

  const arr = (buckets.get(key) ?? []).filter((t) => now - t < w);
  if (arr.length >= max) {
    const resetSec = resetApprox(now, arr, w);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", "0");
    res.setHeader("RateLimit-Reset", String(resetSec));
    res.setHeader("Retry-After", String(Math.max(1, resetSec - Math.floor(now / 1000))));
    logger.warn(
      { key: key.split(":")[0], ip: clientIp(req), path: pathname, max },
      "rate limit exceeded",
    );
    res.status(429).json({
      error: "Too many requests. Slow down and try again shortly.",
      retryAfterSeconds: Math.max(1, resetSec - Math.floor(now / 1000)),
    });
    return;
  }

  arr.push(now);
  buckets.set(key, arr);

  res.setHeader("RateLimit-Limit", String(max));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, max - arr.length)));
  res.setHeader(
    "RateLimit-Reset",
    String(resetApprox(now, arr, w)),
  );

  next();
}

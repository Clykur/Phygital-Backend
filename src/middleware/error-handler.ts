import type { ErrorRequestHandler, RequestHandler } from "express";
import { logger } from "../lib/logger";

export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .type("application/json")
    .json({ error: "Not Found", path: req.path });
};

function httpStatusFromError(err: unknown): number {
  // Common DB connectivity failures should not be reported as generic 500s.
  // These are transient infra/config issues (DB down, network, DNS, etc.).
  const msg = (() => {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    if (typeof err === "object" && err !== null && "message" in err) {
      const m = (err as { message?: unknown }).message;
      return typeof m === "string" ? m : "";
    }
    return "";
  })();

  const stackOrString = (() => {
    if (err instanceof Error) return `${err.name}: ${err.message}\n${err.stack ?? ""}`;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })();

  const isDbDown =
    /ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(stackOrString) ||
    /timeout exceeded when trying to connect/i.test(msg) ||
    /Connection terminated/i.test(msg);

  if (isDbDown) return 503;

  if (typeof err === "object" && err !== null) {
    const o = err as { status?: unknown; statusCode?: unknown };
    if (typeof o.status === "number" && o.status >= 400 && o.status < 600)
      return o.status;
    if (typeof o.statusCode === "number" && o.statusCode >= 400 && o.statusCode < 600)
      return o.statusCode;
  }
  return 500;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const code = httpStatusFromError(err);
  const message =
    code === 503
      ? "Service temporarily unavailable (database unreachable)"
      : err instanceof Error
        ? err.message
        : "Internal Server Error";

  logger.error(
    { err, method: req.method, path: req.path, status: code },
    "request failed",
  );

  const body: Record<string, unknown> = { error: message, status: code };
  if (process.env["NODE_ENV"] !== "production" && err instanceof Error) {
    body["stack"] = err.stack;
  }
  res.status(code).type("application/json").json(body);
};

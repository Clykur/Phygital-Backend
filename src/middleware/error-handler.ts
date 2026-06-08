import type { ErrorRequestHandler, RequestHandler } from "express";
import { logger } from "../lib/logger";

export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .type("application/json")
    .json({ error: "Not Found", path: req.path });
};

/** Walk `Error.cause` (Drizzle/pg often nest the real failure here). */
function errorChainText(err: unknown): { message: string; detail: string } {
  const messages: string[] = [];
  const details: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    if (e instanceof Error) {
      messages.push(e.message);
      details.push(`${e.name}: ${e.message}\n${e.stack ?? ""}`);
      e = (e as Error & { cause?: unknown }).cause;
    } else if (typeof e === "object" && e !== null && "message" in e) {
      const m = (e as { message?: unknown }).message;
      const s = typeof m === "string" ? m : "";
      messages.push(s);
      try {
        details.push(JSON.stringify(e));
      } catch {
        details.push(String(e));
      }
      break;
    } else {
      details.push(String(e));
      break;
    }
  }
  return { message: messages.join(" | "), detail: details.join("\n---cause---\n") };
}

function httpStatusFromError(
  err: unknown,
  chain: { message: string; detail: string },
): number {
  // Common DB connectivity failures should not be reported as generic 500s.
  // These are transient infra/config issues (DB down, network, DNS, etc.).
  const { message: msg, detail: stackOrString } = chain;

  const isDbDown =
    /ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(stackOrString) ||
    /timeout exceeded when trying to connect/i.test(msg) ||
    /Connection terminated/i.test(msg) ||
    /no pg_hba\.conf entry/i.test(msg) ||
    /SSL connection is required/i.test(msg);

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

  const chain = errorChainText(err);
  let code = httpStatusFromError(err, chain);

  // Normalize a few common cases to align with desired API semantics.
  const msg = chain.message.toLowerCase();
  if (code === 500) {
    if (msg.includes("unauthorized") || msg.includes("invalid token")) code = 401;
    else if (msg.includes("forbidden")) code = 403;
    else if (msg.includes("not found") || msg.includes("no rows")) code = 404;
  }

  const chainMsg = chain.message;
  const message =
    code === 503
      ? "Service temporarily unavailable (database unreachable)"
      : err instanceof Error
        ? chainMsg || err.message
        : "Internal Server Error";

  logger.error(
    {
      err,
      method: req.method,
      path: req.path,
      status: code,
      // Helpful when debugging 500s from nested drivers.
      chain: chain.message,
    },
    "request failed",
  );

  const body: Record<string, unknown> = { error: message, status: code };
  if (process.env["NODE_ENV"] !== "production" && err instanceof Error) {
    body["stack"] = err.stack;
  }
  res.status(code).type("application/json").json(body);
};


import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index";
import uploadsRouter from "./routes/uploads";
import { logger } from "./lib/logger";
import { authMiddleware, requireApiAuth } from "./middleware/auth";
import { apiRateLimitMiddleware } from "./middleware/api-rate-limit";
import { ensureUploadDir } from "./lib/upload-dir";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";

/**
 * CORS origins = browser sites allowed to call this API (not the API hostname alone).
 * Defaults: production student app + API host (Postman/curl often send no Origin).
 * Override with `CORS_ORIGINS` (comma-separated) on Render if you add previews or domains.
 */
const DEFAULT_CORS_ORIGINS = [
  "https://phygitallibrary.vercel.app",
  "https://phygital-backend-qatz.onrender.com",
] as const;

function parseCorsAllowlist(): string[] {
  const raw = process.env["CORS_ORIGINS"]?.trim();
  if (!raw) return [...DEFAULT_CORS_ORIGINS];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsOriginHandler(): CorsOptions["origin"] {
  const allowlist = parseCorsAllowlist();
  return (requestOrigin, callback) => {
    if (!requestOrigin) {
      callback(null, true);
      return;
    }
    if (allowlist.includes(requestOrigin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };
}

const app: Express = express();
/** Render / proxies set `X-Forwarded-For`; needed for accurate per-IP rate limits. */
app.set("trust proxy", 1);
const uploadDir = ensureUploadDir();

app.use(
  cors({
    origin: corsOriginHandler(),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  }),
);

app.use(
  pinoHttp({
    logger,
    autoLogging: true,
    customReceivedMessage: (req, _res) =>
      `${req.method} ${req.url?.split("?")[0] ?? ""} received`,
    customSuccessMessage: (req, res, _responseTime) =>
      `${req.method} ${req.url?.split("?")[0] ?? ""} ${res.statusCode}`,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.get("/", (_req, res) => {
  res.type("application/json").json({ status: "ok", service: "phygital-api" });
});

/** Cover uploads: flat mount so `POST /api/uploads/book-cover` matches under Express 5. */
app.use(
  "/api/uploads",
  authMiddleware,
  apiRateLimitMiddleware,
  requireApiAuth,
  uploadsRouter,
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadDir));

app.use("/api", authMiddleware, apiRateLimitMiddleware, requireApiAuth, router);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes/index";
import uploadsRouter from "./routes/uploads";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middleware/auth";
import { apiRateLimitMiddleware } from "./middleware/api-rate-limit";
import { ensureUploadDir } from "./lib/upload-dir";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { corsMiddleware } from "./middleware/cors";

const app: Express = express();
/** Render / proxies set `X-Forwarded-For`; needed for accurate per-IP rate limits. */
app.set("trust proxy", 1);
const uploadDir = ensureUploadDir();

app.use(corsMiddleware);

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
  uploadsRouter,
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadDir));

app.use("/api", authMiddleware, apiRateLimitMiddleware, router);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

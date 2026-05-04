import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index";
import uploadsRouter from "./routes/uploads";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middleware/auth";
import { apiRateLimitMiddleware } from "./middleware/api-rate-limit";
import { ensureUploadDir } from "./lib/upload-dir";

const app: Express = express();
const uploadDir = ensureUploadDir();

app.use(
  cors({
    origin: "https://phygitallibrary.vercel.app",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(
  pinoHttp({
    logger,
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
/** Cover uploads: flat mount so `POST /api/uploads/book-cover` matches under Express 5. */
app.use("/api/uploads", authMiddleware, uploadsRouter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadDir));

app.use("/api", authMiddleware, apiRateLimitMiddleware, router);

app.get("/", (_req, res) => {
  res.type("application/json").json({
    service: "phygital-api",
    healthz: "/api/healthz",
    note: "The student UI is served by Vite (npm run dev at repo root), not this port.",
  });
});

export default app;
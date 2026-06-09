/**
 * API surface:
 * - Mounted **before** `requireAuth`: public marketplace browse — health, auth entry,
 *   `GET /catalog/*`, `GET /p2p/listings`, placeholder cover URL.
 * - Mounted **after** `requireAuth`: authenticated flows — shelf/checkout, hub ops,
 *   notifications, admin, and all P2P mutations (create listing, buy, borrow, etc.).
 */
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import catalogRouter from "./catalog";
import booksRouter from "./books";
import bookRequestsRouter from "./book-requests";
import notificationsRouter from "./notifications";
import p2pRouter from "./p2p";
import hubRouter from "./hub";
import activityRouter from "./activity";
import adminRouter from "./admin";
import walletRouter from "./wallet";
import subscriptionsRouter from "./subscriptions";
import studentRouter from "./student";
import bountyRouter from "./bounty";
import { getPlaceholderBookCoverPublicUrl } from "../lib/book-cover-storage";
import { requireAuth } from "../middleware/auth";

const router: IRouter = Router();

router.get("/placeholder-book-cover-url", (req, res) => {
  res.json({ url: getPlaceholderBookCoverPublicUrl() });
});

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/catalog", catalogRouter);
router.use("/p2p", p2pRouter);

// Everything below requires a valid bearer token.
router.use(requireAuth);

router.use("/books", booksRouter);
router.use("/book-requests", bookRequestsRouter);
router.use("/notifications", notificationsRouter);
router.use("/hub", hubRouter);
router.use("/activity", activityRouter);
router.use("/admin", adminRouter);
router.use("/wallet", walletRouter);
router.use("/subscriptions", subscriptionsRouter);
router.use("/student", studentRouter);
router.use("/bounty", bountyRouter);
export default router;

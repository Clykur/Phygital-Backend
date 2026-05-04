import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import multer from "multer";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { saveBookCoverImage } from "../lib/book-cover-storage";
import { saveUserProfileImage } from "../lib/profile-image-storage";
import { requireAuth } from "../middleware/auth";

const router: IRouter = Router();

const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowed.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only JPEG, PNG, WebP, or GIF images are allowed."));
  },
});

router.post("/book-cover", requireAuth, (req, res) => {
  upload.single("image")(req, res, (err: unknown) => {
    void (async () => {
      if (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        res.status(400).json({ error: msg });
        return;
      }
      const file = req.file;
      if (!file?.buffer) {
        res.status(400).json({ error: "Missing image file (field name: image)" });
        return;
      }
      try {
        const url = await saveBookCoverImage({
          buffer: file.buffer,
          mimetype: file.mimetype,
        });
        res.status(201).json({ url });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        res.status(500).json({ error: msg });
      }
    })();
  });
});

router.post("/profile-image", requireAuth, (req, res) => {
  upload.single("image")(req, res, (err: unknown) => {
    void (async () => {
      if (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        res.status(400).json({ error: msg });
        return;
      }
      const file = req.file;
      if (!file?.buffer) {
        res.status(400).json({ error: "Missing image file (field name: image)" });
        return;
      }
      const auth = req.auth!;
      try {
        const storagePath = await saveUserProfileImage({
          userId: auth.userId,
          buffer: file.buffer,
          mimetype: file.mimetype,
        });
        await db
          .update(users)
          .set({
            avatarStoragePath: storagePath,
            avatarUpdatedAt: new Date(),
          })
          .where(eq(users.id, auth.userId));
        res.status(201).json({ ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        res.status(500).json({ error: msg });
      }
    })();
  });
});

export default router;

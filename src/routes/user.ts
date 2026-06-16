import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import multer from "multer";
import { z } from "zod";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { loadAuthUser } from "../lib/auth-user";
import { saveUserProfileImage } from "../lib/profile-image-storage";
import { requireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";
import { getSupabaseAdminClient, supabaseAuthConfigured } from "../lib/supabase-auth";

const router: IRouter = Router();

function useSupabaseAuth(): boolean {
  return supabaseAuthConfigured() && Boolean(process.env.SUPABASE_ANON_KEY?.trim());
}

const updateProfileSchema = z.object({
  name: z.string().min(1, "Name cannot be empty"),
  email: z.string().email("Invalid email format"),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only JPEG, PNG, WebP, or GIF images are allowed."));
  },
});

router.get("/profile", requireAuth, async (req, res) => {
  try {
    const authUser = await loadAuthUser(req.auth!.userId);
    if (!authUser) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }

    // Load full user details including address
    const [user] = await db
      .select({
        address: users.address,
      })
      .from(users)
      .where(eq(users.id, req.auth!.userId))
      .limit(1);

    res.json({
      ...authUser,
      address: user?.address ?? null,
    });
  } catch (error: any) {
    logger.error({ err: error }, "Failed to get user profile");
    res.status(500).json({ error: "Failed to retrieve user profile" });
  }
});

router.put("/profile", requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { name, email, phone, address } = parsed.data;

  try {
    const userId = req.auth!.userId;
    const [existingUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (!existingUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Update locally
    await db
      .update(users)
      .set({
        name,
        email,
        phone: phone ?? null,
        address: address ?? null,
      })
      .where(eq(users.id, userId));

    // Update in Supabase Auth if linked
    if (existingUser.authUserId && useSupabaseAuth()) {
      try {
        const admin = getSupabaseAdminClient();
        await admin.auth.admin.updateUserById(existingUser.authUserId, {
          email,
          user_metadata: { name, full_name: name },
        });
        logger.info(
          `[Profile Update] Synced details to Supabase Auth for authUserId ${existingUser.authUserId}`,
        );
      } catch (sbErr: any) {
        logger.error({ err: sbErr }, "Failed to update profile details in Supabase Auth");
      }
    }

    const updatedUser = await loadAuthUser(userId);
    res.json({
      ok: true,
      message: "Profile updated successfully.",
      user: {
        ...updatedUser,
        address: address ?? null,
      },
    });
  } catch (error: any) {
    logger.error({ err: error }, "Failed to update profile");
    res.status(500).json({ error: "Failed to update user profile" });
  }
});

router.post("/profile/upload-image", requireAuth, (req, res) => {
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

        res.status(201).json({ ok: true, message: "Avatar uploaded successfully" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        res.status(500).json({ error: msg });
      }
    })();
  });
});

export default router;

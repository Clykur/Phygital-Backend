import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ensureUploadDir } from "./upload-dir";
import { logger } from "./logger";

const extMap: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function extensionForMimetype(mimetype: string): string {
  return extMap[mimetype] ?? ".img";
}

function profileBucket(): string {
  return process.env["SUPABASE_PROFILE_IMAGES_BUCKET"]?.trim() || "profile-images";
}

export function supabaseProfileStorageConfigured(): boolean {
  return Boolean(
    process.env["SUPABASE_URL"]?.trim() &&
      process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim() &&
      profileBucket(),
  );
}

let supabaseClient: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
  if (supabaseClient) return supabaseClient;
  const url = process.env["SUPABASE_URL"]!.trim();
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"]!.trim();
  supabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabaseClient;
}

/**
 * Saves a profile image to private Supabase Storage or local disk.
 * Returns the storage key stored in `users.avatar_storage_path`.
 */
export async function saveUserProfileImage(opts: {
  userId: string;
  buffer: Buffer;
  mimetype: string;
}): Promise<string> {
  const ext = extensionForMimetype(opts.mimetype);
  const objectName = `${randomUUID()}${ext}`;
  const storagePath = `${opts.userId}/${objectName}`;

  if (supabaseProfileStorageConfigured()) {
    const bucket = profileBucket();
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(bucket).upload(storagePath, opts.buffer, {
      contentType: opts.mimetype,
      upsert: true,
    });
    if (error) {
      logger.error({ err: error, bucket, storagePath }, "Supabase profile image upload failed");
      throw new Error(error.message);
    }
    return storagePath;
  }

  const dir = path.join(ensureUploadDir(), "profiles", opts.userId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, objectName);
  await fs.writeFile(filePath, opts.buffer);
  return path.join("profiles", opts.userId, objectName).replace(/\\/g, "/");
}

export async function readUserProfileImage(storagePath: string): Promise<{
  buffer: Buffer;
  contentType: string;
} | null> {
  if (!storagePath.trim()) return null;

  if (supabaseProfileStorageConfigured()) {
    const bucket = profileBucket();
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(bucket).download(storagePath);
    if (error || !data) {
      logger.warn({ err: error, storagePath }, "Supabase profile image download failed");
      return null;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    const contentType = data.type || "application/octet-stream";
    return { buffer: buf, contentType };
  }

  const filePath = path.join(ensureUploadDir(), storagePath);
  try {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(storagePath).toLowerCase();
    const contentType =
      ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/jpeg";
    return { buffer, contentType };
  } catch {
    return null;
  }
}

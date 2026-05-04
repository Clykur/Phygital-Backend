export const PLACEHOLDER_BOOK_COVER_NAME = "Book_Placeholder.jpg";

/**
 * Returns the public URL for the placeholder book cover image.
 * Assumes the placeholder image is already uploaded to the configured Supabase bucket.
 */
export function getPlaceholderBookCoverPublicUrl(): string {
  if (!supabaseBookStorageConfigured()) {
    // Fallback for local development without Supabase configured
    return "/book_placeholder.webp";
  }
  const bucket = process.env["SUPABASE_BOOK_IMAGES_BUCKET"]!.trim();
  const prefix = process.env["SUPABASE_BOOK_IMAGES_PREFIX"]?.trim();
  const storagePath = prefix
    ? `${prefix.replace(/\/$/, "")}/${PLACEHOLDER_BOOK_COVER_NAME}`
    : PLACEHOLDER_BOOK_COVER_NAME;

  const supabase = getSupabaseAdmin();
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data.publicUrl;
}import { randomUUID } from "node:crypto";
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

function supabaseBookStorageConfigured(): boolean {
  return Boolean(
    process.env["SUPABASE_URL"]?.trim() &&
      process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim() &&
      process.env["SUPABASE_BOOK_IMAGES_BUCKET"]?.trim(),
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
 * Persists a book cover image: Supabase Storage (public bucket) when configured,
 * otherwise local `upload-data/uploads` + `/uploads/...` URL.
 */
export async function saveBookCoverImage(opts: {
  buffer: Buffer;
  mimetype: string;
}): Promise<string> {
  const ext = extensionForMimetype(opts.mimetype);
  const objectName = `${randomUUID()}${ext}`;

  if (supabaseBookStorageConfigured()) {
    const bucket = process.env["SUPABASE_BOOK_IMAGES_BUCKET"]!.trim();
    const prefix = process.env["SUPABASE_BOOK_IMAGES_PREFIX"]?.trim();
    const storagePath = prefix ? `${prefix.replace(/\/$/, "")}/${objectName}` : objectName;

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(bucket).upload(storagePath, opts.buffer, {
      contentType: opts.mimetype,
      upsert: false,
    });

    if (error) {
      logger.error({ err: error, bucket, storagePath }, "Supabase storage upload failed");
      throw new Error(error.message);
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
    return data.publicUrl;
  }

  const dir = ensureUploadDir();
  const filePath = path.join(dir, objectName);
  await fs.writeFile(filePath, opts.buffer);
  return `/uploads/${objectName}`;
}
import { z } from "zod";

/** Hub-hosted upload path (see POST /api/uploads/book-cover) or any http(s) URL. */
export const uploadedCoverPathSchema = z
  .string()
  .regex(/^\/uploads\/[A-Za-z0-9._-]+$/);

export const coverImageUrlCreateSchema = z
  .union([z.string().url(), uploadedCoverPathSchema])
  .optional();

export const coverImageUrlPatchSchema = z
  .union([z.string().url(), uploadedCoverPathSchema, z.literal("")])
  .optional();

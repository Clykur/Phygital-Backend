import fs from "node:fs";
import path from "node:path";

export function ensureUploadDir(): string {
  const dir =
    process.env["UPLOAD_DIR"] ??
    path.join(process.cwd(), "upload-data", "uploads");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

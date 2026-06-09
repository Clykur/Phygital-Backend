import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { config } = require("dotenv");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, ".."); // phygital-backend root (parent of src/)
const isProd = process.env["NODE_ENV"] === "production";

if (isProd) {
  config({ path: path.join(repoRoot, ".env.production") });
} else {
  config({ path: path.join(repoRoot, ".env") });
  config({ path: path.join(repoRoot, ".env.local"), override: true });
}

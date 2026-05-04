import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises"; // Removed readdir as it's causing issues
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

const external = [
  "*.node",
  "sharp",
  "better-sqlite3",
  "sqlite3",
  "canvas",
  "bcrypt",
  "argon2",
  "fsevents",
  "re2",
  "farmhash",
  "xxhash-addon",
  "bufferutil",
  "utf-8-validate",
  "ssh2",
  "cpu-features",
  "dtrace-provider",
  "isolated-vm",
  "lightningcss",
  "pg-native",
  "oracledb",
  "mongodb-client-encryption",
  "nodemailer",
  "handlebars",
  "knex",
  "typeorm",
  "protobufjs",
  "onnxruntime-node",
  "@tensorflow/*",
  "@prisma/client",
  "@mikro-orm/*",
  "@grpc/*",
  "@swc/*",
  "@aws-sdk/*",
  "@azure/*",
  "@opentelemetry/*",
  "@google-cloud/*",
  "@google/*",
  "googleapis",
  "firebase-admin",
  "@parcel/watcher",
  "@sentry/profiling-node",
  "@tree-sitter/*",
  "aws-sdk",
  "classic-level",
  "dd-trace",
  "ffi-napi",
  "grpc",
  "hiredis",
  "kerberos",
  "leveldown",
  "miniflare",
  "mysql2",
  "newrelic",
  "odbc",
  "piscina",
  "realm",
  "ref-napi",
  "rocksdb",
  "sass-embedded",
  "sequelize",
  "serialport",
  "snappy",
  "tinypool",
  "usb",
  "workerd",
  "wrangler",
  "zeromq",
  "zeromq-prebuilt",
  "playwright",
  "puppeteer",
  "puppeteer-core",
  "electron",
  "express",
  "dotenv",
  "pino",
  "pino-http",
];

function buildOptions(distDir) {
  return {
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external,
    sourcemap: "linked",
    plugins: [
      esbuildPluginPino(),
    ],
  };
}

async function main() {
  const isWatch = process.argv.includes("--watch");
  const distDir = path.join(artifactDir, "dist");

  // Explicitly define workspace package paths
  const workspacePackagePaths = [
    path.resolve(artifactDir, "lib/api-zod"),
    path.resolve(artifactDir, "lib/db"),
  ];

  // Build all workspace packages first
  for (const pkgPath of workspacePackagePaths) {
    const pkgName = path.basename(pkgPath);
    console.log(`[build] Building workspace package: ${pkgName}`);
    try {
      // Clean dist directory for the package
      await rm(path.join(pkgPath, "dist"), { recursive: true, force: true });
      execSync("npm run build", { cwd: pkgPath, stdio: "inherit" });
    } catch (error) {
      console.error(`Failed to build ${pkgName}:`, error.message);
      process.exit(1);
    }
  }

  // No need to remove distDir if it's the artifactDir itself
  if (!isWatch) {
    await rm(distDir, { recursive: true, force: true });
  }

  const opts = buildOptions(distDir);

  if (isWatch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log("[api-server build] watching — edit src/ to rebuild; node --watch will restart the API");
  } else {
    await esbuild.build(opts);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
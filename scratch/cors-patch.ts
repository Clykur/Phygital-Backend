import fs from "fs";

let content = fs.readFileSync("src/middleware/cors.ts", "utf8");

// Replace the parseAllowedOrigins function
const newParse = `function parseAllowedOrigins(): OriginRule[] {
  return [
    { kind: "exact", origin: "https://phygitallibrary.vercel.app" },
    { kind: "wildcard", scheme: "https", suffix: ".vercel.app" },
    { kind: "exact", origin: "http://localhost:5173" },
    { kind: "exact", origin: "http://localhost:5174" },
    { kind: "exact", origin: "http://localhost:3000" },
    { kind: "exact", origin: "http://127.0.0.1:3000" },
    { kind: "exact", origin: BACKEND_ORIGIN },
  ];
}`;

content = content.replace(
  /function parseAllowedOrigins\(\): OriginRule\[\] \{[\s\S]*?return parsed;\n\}/,
  newParse,
);

fs.writeFileSync("src/middleware/cors.ts", content);
console.log("Patched cors.ts");

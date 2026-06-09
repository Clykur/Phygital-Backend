const fs = require("fs");
const path = require("path");
const repoRoot = path.resolve(__dirname, "..");
const targetPath = path.join(repoRoot, "src/seed.ts");
let code = fs.readFileSync(targetPath, "utf8");

if (!code.includes("subscriptionPlans")) {
  code = code.replace(/import {.*?from "@workspace\/db\/schema";/s, (match) => {
    if (match.includes("subscriptionPlans")) return match;
    return match.replace(
      '} from "@workspace/db/schema";',
      ', subscriptionPlans } from "@workspace/db/schema";',
    );
  });

  const insertPlans = `
    const [{ c: planCount }] = await db.select({ c: count() }).from(subscriptionPlans);
    if (Number(planCount) === 0) {
      await db.insert(subscriptionPlans).values([
        { tier: 'free', name: 'Student Free', target: 'student', price: 0, creditReward: 0, isActive: 1 },
        { tier: 'pro', name: 'Student Premium', target: 'student', price: 299, creditReward: 50, isActive: 1 },
        { tier: 'hub_basic', name: 'Hub Basic', target: 'hub', price: 0, creditReward: 0, isActive: 1 },
        { tier: 'hub_pro', name: 'Hub Pro', target: 'hub', price: 999, creditReward: 0, isActive: 1 }
      ]);
    }
  `;

  code = code.replace(
    "export async function seedIfEmpty(): Promise<void> {\n  try {\n",
    "export async function seedIfEmpty(): Promise<void> {\n  try {\n" + insertPlans,
  );

  fs.writeFileSync(targetPath, code);
}

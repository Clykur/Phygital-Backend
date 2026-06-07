import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hubTsPath = path.join(repoRoot, 'src/routes/hub.ts');
let code = fs.readFileSync(hubTsPath, 'utf8');

code = code.replace(
  'logger.error("Error fetching hub students", { error, hubId });',
  'logger.error({ error, hubId }, "Error fetching hub students");'
);

code = code.replace(
  'logger.error("Error fetching hub student analytics", { error, hubId });',
  'logger.error({ error, hubId }, "Error fetching hub student analytics");'
);

code = code.replace(
  'const result = await Promise.all(studentMemberships.map(async (row) => {',
  'const result = await Promise.all(studentMemberships.map(async (row: any) => {'
);

fs.writeFileSync(hubTsPath, code);

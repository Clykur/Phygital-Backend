import fs from 'fs';

const hubTsPath = '/Users/karthiknaramala/Desktop/Phygital-Backend/src/routes/hub.ts';
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

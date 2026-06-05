const fs = require('fs');
let code = fs.readFileSync('src/lib/auth-user.ts', 'utf8');

code = code.replace(
  'hubs, memberships, subscriptions, users',
  'hubs, memberships, userSubscriptions, users'
);

code = code.replace(
  'sub: { status: string; premiumUntil: Date } | undefined',
  'sub: { status: string; currentPeriodEnd: Date } | undefined'
);

code = code.replace(
  'return sub.premiumUntil.getTime() > Date.now();',
  'return sub.currentPeriodEnd.getTime() > Date.now();'
);

code = code.replace(
  '.from(subscriptions)',
  '.from(userSubscriptions)'
);

code = code.replace(
  '.where(eq(subscriptions.userId, userId))',
  '.where(eq(userSubscriptions.userId, userId))'
);

code = code.replace(
  'sub && sub.premiumUntil.getTime() > 1 ? sub.premiumUntil.toISOString() : null;',
  'sub && sub.currentPeriodEnd.getTime() > 1 ? sub.currentPeriodEnd.toISOString() : null;'
);

fs.writeFileSync('src/lib/auth-user.ts', code);

const fs = require('fs');
const path = require('path');
const repoRoot = path.resolve(__dirname, '..');
const targetPath = path.join(repoRoot, 'src/routes/auth.ts');
let content = fs.readFileSync(targetPath, 'utf8');

const oldGoogleAuth = `router.post("/google", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: "Missing Google token" });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      res.status(400).json({ error: "Invalid Google payload" });
      return;
    }

    const email = payload.email;
    const name = payload.name || email.split('@')[0];

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    let userId = user?.id;
    let isNewUser = false;

    if (!user) {
      // Register new user automatically via Google
      const passwordHash = await hashPassword(Math.random().toString(36).slice(-8) + "google!");
      userId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            name,
            email,
            passwordHash,
            baseRole: "user",
            publicId: await nextUserPublicId("user"),
          })
          .returning({ id: users.id });
        await tx.insert(subscriptions).values({
          userId: row.id,
          status: "canceled",
          premiumUntil: new Date(0),
        });

        // Provision wallet
        await tx.insert(wallets).values({
          userId: row.id,
          balance: 0,
        });

        // Set default subscription
        const [freePlan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.tier, "free")).limit(1);
        if (freePlan) {
          await tx.insert(userSubscriptions).values({
            userId: row.id,
            planId: freePlan.id,
            status: "active",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 10)),
          });
        }

        return row.id;
      });
      isNewUser = true;
    }

    const authUser = await loadAuthUser(userId!);
    if (!authUser) {
      res.status(403).json({ error: "Account restricted." });
      return;
    }

    const jwtToken = await signToken(authUser);
    res.status(isNewUser ? 201 : 200).json({ token: jwtToken, user: authUser });
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(401).json({ error: "Google authentication failed" });
  }
});`;

const newGoogleAuth = `router.post("/google", async (req, res) => {
  const { token, accountType, hubLocation, hubName, hubKind } = req.body;
  if (!token) {
    res.status(400).json({ error: "Missing Google token" });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      res.status(400).json({ error: "Invalid Google payload" });
      return;
    }

    const email = payload.email;
    const name = payload.name || email.split('@')[0];

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    let userId = user?.id;
    let isNewUser = false;

    if (!user) {
      // Register new user automatically via Google
      const passwordHash = await hashPassword(Math.random().toString(36).slice(-8) + "google!");
      const actualAccountType = accountType || "user";
      
      userId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            name,
            email,
            passwordHash,
            baseRole: actualAccountType === "super_admin" ? "super_admin" : actualAccountType === "hub" ? "hub" : "user",
            publicId: await nextUserPublicId(actualAccountType === "super_admin" ? "super_admin" : actualAccountType === "hub" ? "hub" : "user"),
          })
          .returning({ id: users.id });
          
        await tx.insert(subscriptions).values({
          userId: row.id,
          status: "canceled",
          premiumUntil: new Date(0),
        });

        // Provision wallet
        await tx.insert(wallets).values({
          userId: row.id,
          balance: 0,
        });

        // Set default subscription
        const [freePlan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.tier, "free")).limit(1);
        if (freePlan) {
          await tx.insert(userSubscriptions).values({
            userId: row.id,
            planId: freePlan.id,
            status: "active",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 10)),
          });
        }

        // Set up memberships based on accountType
        if (actualAccountType === "hub" || (actualAccountType === "super_admin" && hubName)) {
          const hName = hubName?.trim() || name;
          const hLocation = hubLocation?.trim() || "Unknown";
          const hKind = hubKind || "college";
          const [hub] = await tx
            .insert(hubs)
            .values({
              name: hName,
              location: hLocation,
              kind: hKind,
              publicId: await nextHubPublicId(),
            })
            .returning({ id: hubs.id });
            
          await tx.insert(memberships).values({
            userId: row.id,
            hubId: hub.id,
            role: "hub_admin",
          });
        } else if (actualAccountType === "student" && hubLocation) {
          const hubLoc = hubLocation.trim();
          // Try to find the hub by publicId or location
          let [hub] = await tx.select().from(hubs).where(eq(hubs.publicId, hubLoc)).limit(1);
          if (!hub) {
            [hub] = await tx.select().from(hubs).where(eq(hubs.location, hubLoc)).limit(1);
          }
          if (hub) {
            await tx.insert(memberships).values({
              userId: row.id,
              hubId: hub.id,
              role: "student",
            });
          }
        }

        return row.id;
      });
      isNewUser = true;
    }

    const authUser = await loadAuthUser(userId!);
    if (!authUser) {
      res.status(403).json({ error: "Account restricted." });
      return;
    }

    const jwtToken = await signToken(authUser);
    res.status(isNewUser ? 201 : 200).json({ token: jwtToken, user: authUser });
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(401).json({ error: "Google authentication failed" });
  }
});`;

content = content.replace(oldGoogleAuth, newGoogleAuth);
fs.writeFileSync(targetPath, content);

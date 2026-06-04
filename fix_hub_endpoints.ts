import fs from 'fs';

const hubTsPath = '/Users/karthiknaramala/Desktop/Phygital-Backend/src/routes/hub.ts';
let code = fs.readFileSync(hubTsPath, 'utf8');

const regex = /router\.get\("\/students".*?export default router;/s;
const newEndpoints = `router.get("/students", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff access required." });
    return;
  }
  const hubId = typeof req.query["hubId"] === "string" ? req.query["hubId"] : auth.hubStaffHubIds[0];
  if (!auth.hubStaffHubIds.includes(hubId) && auth.baseRole !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const studentMemberships = await db
      .select({
        user: users,
        wallet: wallets,
        subscription: userSubscriptions,
        plan: subscriptionPlans,
      })
      .from(memberships)
      .where(and(eq(memberships.hubId, hubId), eq(memberships.role, "student")))
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(wallets, eq(wallets.userId, users.id))
      .leftJoin(userSubscriptions, eq(userSubscriptions.userId, users.id))
      .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, userSubscriptions.planId))
      .limit(limit)
      .offset(offset);

    const result = await Promise.all(studentMemberships.map(async (row) => {
      let earned = 0;
      let spent = 0;
      if (row.wallet) {
        const txs = await db.select().from(walletTransactions).where(eq(walletTransactions.walletId, row.wallet.id));
        txs.forEach((t: any) => {
          if (t.type === 'credit') earned += t.amount;
          if (t.type === 'debit') spent += t.amount;
        });
      }
      
      const [lastEvt] = await db.select().from(lifecycleEvents)
        .where(eq(lifecycleEvents.userId, row.user.id))
        .orderBy(sql\`created_at DESC\`)
        .limit(1);

      return {
        id: row.user.id,
        publicId: row.user.publicId,
        name: row.user.name,
        email: row.user.email,
        phone: row.user.phone,
        accountStatus: row.user.accountStatus,
        createdAt: row.user.createdAt,
        walletBalance: row.wallet?.balance || 0,
        creditsEarned: earned,
        creditsSpent: spent,
        subscriptionStatus: row.subscription?.status || "none",
        subscriptionPlan: row.plan?.name || "Free",
        lastActivityDate: lastEvt?.createdAt || row.user.createdAt,
      };
    }));

    const [{ count: total }] = await db
      .select({ count: sql\`count(*)\`.mapWith(Number) })
      .from(memberships)
      .where(and(eq(memberships.hubId, hubId), eq(memberships.role, "student")));

    res.json({
      students: result,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    logger.error("Error fetching hub students", { error, hubId });
    res.status(500).json({ error: "Failed to fetch students" });
  }
});

router.get("/students/analytics", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff access required." });
    return;
  }
  const hubId = typeof req.query["hubId"] === "string" ? req.query["hubId"] : auth.hubStaffHubIds[0];
  if (!auth.hubStaffHubIds.includes(hubId) && auth.baseRole !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  try {
    const studentMemberships = await db
      .select({
        user: users,
        wallet: wallets,
        subscription: userSubscriptions,
        plan: subscriptionPlans,
      })
      .from(memberships)
      .where(and(eq(memberships.hubId, hubId), eq(memberships.role, "student")))
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(wallets, eq(wallets.userId, users.id))
      .leftJoin(userSubscriptions, eq(userSubscriptions.userId, users.id))
      .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, userSubscriptions.planId));

    let totalStudents = studentMemberships.length;
    let activeSubscriptions = 0;
    let expiredSubscriptions = 0;
    let totalCreditsIssued = 0;
    let totalCreditsRedeemed = 0;

    for (const row of studentMemberships) {
      if (row.subscription?.status === 'active') activeSubscriptions++;
      if (row.subscription?.status === 'canceled' && row.subscription?.premiumUntil && new Date(row.subscription.premiumUntil) < new Date()) {
        expiredSubscriptions++;
      }
      if (row.wallet) {
        const txs = await db.select().from(walletTransactions).where(eq(walletTransactions.walletId, row.wallet.id));
        txs.forEach((t: any) => {
          if (t.type === 'credit') totalCreditsIssued += t.amount;
          if (t.type === 'debit') totalCreditsRedeemed += t.amount;
        });
      }
    }

    res.json({
      totalStudents,
      activeSubscriptions,
      expiredSubscriptions,
      totalCreditsIssued,
      totalCreditsRedeemed,
      walletActivityTrends: {
        issued: totalCreditsIssued,
        redeemed: totalCreditsRedeemed,
        net: totalCreditsIssued - totalCreditsRedeemed
      }
    });
  } catch (error) {
    logger.error("Error fetching hub student analytics", { error, hubId });
    res.status(500).json({ error: "Failed to fetch student analytics" });
  }
});

export default router;`;

code = code.replace(regex, newEndpoints);
fs.writeFileSync(hubTsPath, code);

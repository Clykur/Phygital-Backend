import fs from 'fs';

const path = '/Users/karthiknaramala/Desktop/Phygital-Backend/src/routes/auth.ts';
let code = fs.readFileSync(path, 'utf8');

const replacement = `      if (accountType === "hub" || (accountType === "super_admin" && parsed.data.hubName)) {
        const hubName = parsed.data.hubName!.trim();
        const hubLocation = parsed.data.hubLocation!.trim();
        const hubKind = parsed.data.hubKind!;
        const [hub] = await tx
          .insert(hubs)
          .values({
            name: hubName,
            location: hubLocation,
            kind: hubKind,
            publicId: await nextHubPublicId(),
          })
          .returning({ id: hubs.id });
        await tx.insert(memberships).values({
          userId: row.id,
          hubId: hub.id,
          role: "hub_admin",
        });
      } else if (accountType === "student" && parsed.data.hubLocation) {
        const hubLoc = parsed.data.hubLocation!.trim();
        // Try to find the hub by publicId or location
        const [hub] = await tx.select().from(hubs).where(eq(hubs.publicId, hubLoc)).limit(1);
        if (hub) {
          await tx.insert(memberships).values({
            userId: row.id,
            hubId: hub.id,
            role: "student",
          });
        } else {
          // fallback search by location
          const [hubByLoc] = await tx.select().from(hubs).where(eq(hubs.location, hubLoc)).limit(1);
          if (hubByLoc) {
            await tx.insert(memberships).values({
              userId: row.id,
              hubId: hubByLoc.id,
              role: "student",
            });
          }
        }
      }`;

code = code.replace(/      if \(accountType === "hub".*?role: "hub_admin",\n        \}\);\n      \}/s, replacement);
fs.writeFileSync(path, code);

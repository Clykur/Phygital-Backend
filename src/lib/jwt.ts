import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { AuthUser } from "./rbac/types";

const getSecret = () => {
  const s = process.env["JWT_SECRET"];
  if (!s || s.length < 16) {
    throw new Error("JWT_SECRET must be set (min 16 chars)");
  }
  return new TextEncoder().encode(s);
};

export type TokenPayload = JWTPayload & {
  sub: string;
  baseRole: string;
  premiumActive: boolean;
  hubStaffHubIds: string[];
};

export async function signToken(user: AuthUser): Promise<string> {
  return new SignJWT({
    baseRole: user.baseRole,
    premiumActive: user.premiumActive,
    hubStaffHubIds: user.hubStaffHubIds,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, getSecret());
  const sub = payload.sub;
  if (!sub) throw new Error("Invalid token");
  return {
    ...payload,
    sub,
    baseRole: String(payload["baseRole"] ?? "user"),
    premiumActive: Boolean(payload["premiumActive"]),
    hubStaffHubIds: Array.isArray(payload["hubStaffHubIds"])
      ? (payload["hubStaffHubIds"] as string[])
      : Array.isArray(payload["hubAdminHubIds"])
        ? (payload["hubAdminHubIds"] as string[])
        : [],
  } as TokenPayload;
}

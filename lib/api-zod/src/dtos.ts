import { z } from "zod";

export const hubKindSchema = z.enum(["college", "public", "government", "private", "other"]);

export const registerSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    accountType: z.enum(["student", "hub", "user", "super_admin"]).optional(),
    isPremium: z.boolean().optional(),
    hubName: z.string().optional(),
    hubLocation: z.string().optional(),
    hubKind: hubKindSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const t = data.accountType ?? "student";
    if (t !== "hub") return;
    if (!data.hubName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Hub name is required",
        path: ["hubName"],
      });
    }
    if (!data.hubLocation?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Hub location is required",
        path: ["hubLocation"],
      });
    }
    if (!data.hubKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Hub type is required",
        path: ["hubKind"],
      });
    }
  });

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const patchBookSchema = z.object({
  title: z.string().min(1).optional(),
  condition: z.enum(["new", "good", "fair"]).optional(),
  status: z.enum(["available", "checked_out", "reserved", "unavailable", "sold"]).optional(),
});

export const hubPurchaseBodySchema = z.object({
  acquireForHubId: z.string().uuid().optional(),
});

export const userDtoSchema = z.object({
  id: z.string().uuid(),
  publicId: z.string().nullable(),
  name: z.string(),
  email: z.string().email(),
  baseRole: z.string(),
  accountStatus: z.string(),
  avatarStoragePath: z.string().nullable(),
  phone: z.string().nullable().optional(),
  createdAt: z.string().or(z.date()),
});

export const bookDtoSchema = z.object({
  id: z.string().uuid(),
  refId: z.string().nullable(),
  title: z.string(),
  author: z.string().nullable().optional(),
  isbn: z.string().nullable().optional(),
  coverImageUrl: z.string().nullable(),
  hubId: z.string().uuid(),
  status: z.string(),
  condition: z.string(),
  source: z.string(),
  buyPrice: z.number(),
  borrowPrice: z.number(),
  borrowerUserId: z.string().nullable(),
  dueAt: z.string().or(z.date()).nullable(),
  returnedAt: z.string().or(z.date()).nullable(),
  updatedAt: z.string().or(z.date()),
  createdAt: z.string().or(z.date()),
});

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type PatchBookRequest = z.infer<typeof patchBookSchema>;
export type HubPurchaseBodyRequest = z.infer<typeof hubPurchaseBodySchema>;
export type UserDto = z.infer<typeof userDtoSchema>;
export type BookDto = z.infer<typeof bookDtoSchema>;

export const walletDtoSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  balance: z.number(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
});

export const walletTransactionDtoSchema = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  type: z.string(),
  amount: z.number(),
  description: z.string(),
  createdAt: z.string().or(z.date()),
});

export const subscriptionPlanDtoSchema = z.object({
  id: z.string().uuid(),
  tier: z.string(),
  name: z.string(),
  price: z.number(),
  creditReward: z.number(),
  isActive: z.number(),
});

export const userSubscriptionDtoSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  planId: z.string().uuid(),
  status: z.string(),
  currentPeriodStart: z.string().or(z.date()),
  currentPeriodEnd: z.string().or(z.date()),
});

export type WalletDto = z.infer<typeof walletDtoSchema>;
export type WalletTransactionDto = z.infer<typeof walletTransactionDtoSchema>;
export type SubscriptionPlanDto = z.infer<typeof subscriptionPlanDtoSchema>;
export type UserSubscriptionDto = z.infer<typeof userSubscriptionDtoSchema>;

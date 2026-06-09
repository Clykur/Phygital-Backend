import {
  createClient,
  type SupabaseClient,
  type User as SupabaseUser,
} from "@supabase/supabase-js";

let authClient: SupabaseClient | null = null;
let adminClient: SupabaseClient | null = null;

export function supabaseAuthConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
    (process.env.SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
  );
}

/** Public anon client — preferred for sign-in / sign-up validation. */
export function getSupabaseAuthClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const anon = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anon) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required for Supabase Auth");
  }
  if (!authClient) {
    authClient = createClient(url, anon, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return authClient;
}

export function getSupabaseAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  if (!adminClient) {
    adminClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}

export async function validateSupabaseAccessToken(accessToken: string): Promise<SupabaseUser> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data.user) {
    throw new Error(error?.message ?? "Invalid Supabase session");
  }
  return data.user;
}

export type SupabaseGoogleSignIn = {
  user: SupabaseUser;
  isNewUser: boolean;
};

export async function signInWithGoogleIdToken(idToken: string): Promise<SupabaseGoogleSignIn> {
  const client = getSupabaseAuthClient();
  const { data, error } = await client.auth.signInWithIdToken({
    provider: "google",
    token: idToken,
  });
  if (error || !data.user) {
    throw new Error(error?.message ?? "Google sign-in failed");
  }
  return {
    user: data.user,
    isNewUser: Boolean(data.user.created_at && data.session),
  };
}

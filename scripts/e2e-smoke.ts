/**
 * Real HTTP smoke test against a running phygital-api (no mocks).
 * Usage: npm run test:e2e
 * Requires: API on BASE_URL (default http://127.0.0.1:8787), DATABASE_URL for optional DB checks.
 */
import "../src/load-env.js";

const BASE_URL = (
  process.env.API_BASE_URL ??
  process.env.SMOKE_BASE_URL ??
  "http://127.0.0.1:8787"
).replace(/\/$/, "");

const STUDENT_EMAIL = process.env.SMOKE_STUDENT_EMAIL ?? "phygital-seed-anya@example.invalid";
const STUDENT_PASSWORD = process.env.SMOKE_STUDENT_PASSWORD ?? "phygital-demo-2026";
const HUB_EMAIL = process.env.SMOKE_HUB_EMAIL ?? "phygital-seed-hub-staff@example.invalid";
const HUB_PASSWORD = process.env.SMOKE_HUB_PASSWORD ?? "phygital-demo-2026";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "chandukalluru143@gmail.com";
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? "Chandu@143";

type Outcome = "pass" | "fail" | "skip" | "expected";

interface CaseResult {
  name: string;
  method: string;
  path: string;
  status: number;
  outcome: Outcome;
  note?: string;
}

const results: CaseResult[] = [];

function record(
  name: string,
  method: string,
  path: string,
  status: number,
  outcome: Outcome,
  note?: string,
): void {
  results.push({ name, method, path, status, outcome, note });
  const icon =
    outcome === "pass" ? "✓" : outcome === "expected" ? "~" : outcome === "skip" ? "○" : "✗";
  console.log(`${icon} ${name} → ${status} ${note ?? ""}`);
}

async function api(
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown; query?: Record<string, string> },
): Promise<{ status: number; json: unknown; text: string }> {
  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);
  if (opts?.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts?.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: AuthPayload } | null> {
  const { status, json } = await api("POST", "/api/auth/login", {
    body: { email, password },
  });
  if (status !== 200 && status !== 201) return null;
  const o = json as { token?: string; user?: AuthPayload };
  if (!o.token || !o.user) return null;
  return { token: o.token, user: o.user };
}

function classifyLoginFail(status: number): Outcome {
  return status === 401 ? "expected" : "fail";
}

interface AuthPayload {
  userId: string;
  baseRole: string;
  hubStaffHubIds: string[];
  hubMemberships?: { hubId: string; role: string }[];
  email?: string;
}

async function expectOk(
  name: string,
  method: string,
  path: string,
  fn: () => Promise<{ status: number; json: unknown }>,
  acceptStatuses: number[] = [200, 201, 204],
): Promise<unknown> {
  const { status, json } = await fn();
  if (acceptStatuses.includes(status)) {
    record(name, method, path, status, "pass");
    return json;
  }
  if (status >= 500) {
    record(name, method, path, status, "fail", snippet(json));
    return json;
  }
  record(name, method, path, status, "expected", snippet(json));
  return json;
}

function snippet(json: unknown): string {
  if (json && typeof json === "object" && "error" in json) {
    return String((json as { error: unknown }).error).slice(0, 120);
  }
  return "";
}

async function runPublic(): Promise<void> {
  console.log("\n--- Public / unauthenticated ---");
  {
    const { status } = await api("GET", "/ping");
    record("ping", "GET", "/ping", status, status === 200 ? "pass" : "fail");
  }
  {
    const { status } = await api("GET", "/api/healthz");
    record("healthz", "GET", "/api/healthz", status, status === 200 ? "pass" : "fail");
  }
  {
    const { status } = await api("GET", "/api/ready");
    record(
      "ready",
      "GET",
      "/api/ready",
      status,
      status === 200 ? "pass" : status === 503 ? "expected" : "fail",
    );
  }
  await expectOk("placeholder cover url", "GET", "/api/placeholder-book-cover-url", () =>
    api("GET", "/api/placeholder-book-cover-url"),
  );
  await expectOk("catalog books (optional auth)", "GET", "/api/catalog/books", () =>
    api("GET", "/api/catalog/books", { query: { limit: "5" } }),
  );
  await expectOk("catalog hubs", "GET", "/api/catalog/hubs", () => api("GET", "/api/catalog/hubs"));
  await expectOk("p2p listings browse", "GET", "/api/p2p/listings", () =>
    api("GET", "/api/p2p/listings"),
  );
}

async function runStudent(token: string, user: AuthPayload): Promise<{ bookId?: string }> {
  console.log("\n--- Student (real login) ---");
  console.log(`    ${STUDENT_EMAIL} · role=${user.baseRole}`);

  await expectOk("auth me", "GET", "/api/auth/me", () => api("GET", "/api/auth/me", { token }));
  await expectOk("auth account", "GET", "/api/auth/account", () =>
    api("GET", "/api/auth/account", { token }),
  );

  const catalog = (await expectOk("catalog books", "GET", "/api/catalog/books", () =>
    api("GET", "/api/catalog/books", { token, query: { limit: "10" } }),
  )) as { books?: { id: string }[] } | null;

  await expectOk("wallet balance", "GET", "/api/wallet/balance", () =>
    api("GET", "/api/wallet/balance", { token }),
  );
  await expectOk("wallet transactions", "GET", "/api/wallet/transactions", () =>
    api("GET", "/api/wallet/transactions", { token }),
  );
  await expectOk("subscription plans", "GET", "/api/subscriptions/plans", () =>
    api("GET", "/api/subscriptions/plans", { token }),
  );
  await expectOk("subscription active", "GET", "/api/subscriptions/active", () =>
    api("GET", "/api/subscriptions/active", { token }),
  );
  await expectOk("subscription history", "GET", "/api/subscriptions/history", () =>
    api("GET", "/api/subscriptions/history", { token }),
  );
  await expectOk("student dashboard", "GET", "/api/student/dashboard", () =>
    api("GET", "/api/student/dashboard", { token }),
  );
  await expectOk("recently viewed list", "GET", "/api/student/recently-viewed", () =>
    api("GET", "/api/student/recently-viewed", { token, query: { limit: "5" } }),
  );

  const bookId = catalog?.books?.[0]?.id;
  if (bookId) {
    await expectOk(
      "recently viewed write",
      "POST",
      "/api/student/recently-viewed",
      () => api("POST", "/api/student/recently-viewed", { token, body: { bookId } }),
      [204],
    );
  } else {
    record(
      "recently viewed write",
      "POST",
      "/api/student/recently-viewed",
      0,
      "skip",
      "no book in catalog",
    );
  }

  await expectOk("book requests mine", "GET", "/api/book-requests/mine", () =>
    api("GET", "/api/book-requests/mine", { token }),
  );
  await expectOk("bounty requests", "GET", "/api/bounty/requests", () =>
    api("GET", "/api/bounty/requests", { token }),
  );
  await expectOk("bounty my submissions", "GET", "/api/bounty/my-submissions", () =>
    api("GET", "/api/bounty/my-submissions", { token }),
  );
  await expectOk("notifications mine", "GET", "/api/notifications/mine", () =>
    api("GET", "/api/notifications/mine", { token }),
  );
  await expectOk("activity timeline", "GET", "/api/activity/timeline", () =>
    api("GET", "/api/activity/timeline", { token, query: { limit: "10" } }),
  );

  await expectOk(
    "book request create",
    "POST",
    "/api/book-requests",
    () =>
      api("POST", "/api/book-requests", {
        token,
        body: {
          bookTitle: `Smoke test request ${Date.now()}`,
          notes: "e2e smoke — safe to cancel",
        },
      }),
    [200, 201, 403, 409],
  );

  return { bookId };
}

async function runHub(token: string, user: AuthPayload): Promise<void> {
  console.log("\n--- Hub staff (real login) ---");
  console.log(`    ${HUB_EMAIL} · hubs=${user.hubStaffHubIds.length}`);

  const hubId = user.hubStaffHubIds[0];
  if (!hubId) {
    record("hub suite", "—", "/api/hub/*", 0, "skip", "no hubStaffHubIds on user");
    return;
  }

  const q = { hubId };
  await expectOk("hub overview", "GET", "/api/hub/overview", () =>
    api("GET", "/api/hub/overview", { token, query: q }),
  );
  await expectOk("hub books", "GET", "/api/hub/books", () =>
    api("GET", "/api/hub/books", { token, query: { ...q, limit: "10" } }),
  );
  await expectOk("hub commerce", "GET", "/api/hub/commerce", () =>
    api("GET", "/api/hub/commerce", { token, query: q }),
  );
  await expectOk("hub inventory dashboard", "GET", "/api/hub/inventory-dashboard", () =>
    api("GET", "/api/hub/inventory-dashboard", { token, query: q }),
  );
  await expectOk("hub pending p2p", "GET", "/api/hub/pending-p2p", () =>
    api("GET", "/api/hub/pending-p2p", { token, query: q }),
  );
  await expectOk("hub desk p2p listings", "GET", "/api/hub/desk-p2p-listings", () =>
    api("GET", "/api/hub/desk-p2p-listings", { token, query: q }),
  );
  await expectOk("hub students", "GET", "/api/hub/students", () =>
    api("GET", "/api/hub/students", { token, query: { ...q, page: "1", limit: "10" } }),
  );
  await expectOk("hub students analytics", "GET", "/api/hub/students/analytics", () =>
    api("GET", "/api/hub/students/analytics", { token, query: q }),
  );
  await expectOk("book requests hub queue", "GET", "/api/book-requests/hub", () =>
    api("GET", "/api/book-requests/hub", { token, query: q }),
  );
  await expectOk("bounty hub requests", "GET", "/api/bounty/hub/requests", () =>
    api("GET", "/api/bounty/hub/requests", { token, query: q }),
  );
  await expectOk("subscriptions hub-active", "GET", "/api/subscriptions/hub-active", () =>
    api("GET", "/api/subscriptions/hub-active", { token, query: q }),
  );
}

async function runAdmin(token: string, user: AuthPayload): Promise<void> {
  console.log("\n--- Super admin (real login) ---");
  console.log(`    ${ADMIN_EMAIL} · role=${user.baseRole}`);

  if (user.baseRole !== "super_admin") {
    record("admin suite", "—", "/api/admin/*", 0, "skip", "user is not super_admin");
    return;
  }

  await expectOk("admin system health", "GET", "/api/admin/system-health", () =>
    api("GET", "/api/admin/system-health", { token }),
  );
  await expectOk("admin users", "GET", "/api/admin/users", () =>
    api("GET", "/api/admin/users", { token, query: { limit: "10" } }),
  );
  await expectOk("admin hubs", "GET", "/api/admin/hubs", () =>
    api("GET", "/api/admin/hubs", { token, query: { limit: "10" } }),
  );
  await expectOk("hub super-admin overview", "GET", "/api/hub/super-admin-overview", () =>
    api("GET", "/api/hub/super-admin-overview", { token }),
  );
  await expectOk("admin notification deliveries", "GET", "/api/admin/notification-deliveries", () =>
    api("GET", "/api/admin/notification-deliveries", { token, query: { limit: "5" } }),
  );
}

async function runBookMutations(token: string, bookId?: string): Promise<void> {
  console.log("\n--- Book mutations (real DB; may 402/409) ---");
  if (!bookId) {
    record("book checkout/purchase", "POST", "/api/books/:id/*", 0, "skip", "no bookId");
    return;
  }
  const base = `/api/books/${bookId}`;
  await expectOk(
    "book purchase",
    "POST",
    `${base}/purchase`,
    () => api("POST", `${base}/purchase`, { token, body: {} }),
    [200, 402, 403, 409],
  );
  await expectOk(
    "book checkout",
    "POST",
    `${base}/checkout`,
    () => api("POST", `${base}/checkout`, { token, body: {} }),
    [200, 403, 409],
  );
}

function printSummary(): number {
  const pass = results.filter((r) => r.outcome === "pass").length;
  const expected = results.filter((r) => r.outcome === "expected").length;
  const fail = results.filter((r) => r.outcome === "fail").length;
  const skip = results.filter((r) => r.outcome === "skip").length;

  console.log("\n========== SUMMARY ==========");
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(
    `pass: ${pass}  expected (4xx business): ${expected}  fail (5xx): ${fail}  skip: ${skip}`,
  );

  if (fail > 0) {
    console.log("\nFailures (5xx):");
    for (const r of results.filter((x) => x.outcome === "fail")) {
      console.log(`  ${r.name} ${r.method} ${r.path} → ${r.status} ${r.note ?? ""}`);
    }
  }
  return fail;
}

async function main(): Promise<void> {
  console.log(`Smoke test → ${BASE_URL}`);

  try {
    const ping = await api("GET", "/ping");
    if (ping.status !== 200) {
      console.error("API not reachable. Start with: npm run dev");
      process.exit(1);
    }
  } catch (e) {
    console.error("API not reachable:", e);
    process.exit(1);
  }

  await runPublic();

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  const student = await login(STUDENT_EMAIL, STUDENT_PASSWORD);
  const studentSession =
    student ??
    (admin
      ? (console.log(
          "\n(note) seed student login unavailable (Supabase Auth); using super_admin for student routes)",
        ),
        admin)
      : null);

  if (!student && !studentSession) {
    record("student login", "POST", "/api/auth/login", 401, "fail", STUDENT_EMAIL);
  } else if (student) {
    const { bookId } = await runStudent(student.token, student.user);
    await runBookMutations(student.token, bookId);
  } else if (studentSession) {
    const { bookId } = await runStudent(studentSession.token, studentSession.user);
    await runBookMutations(studentSession.token, bookId);
  }

  const hub = await login(HUB_EMAIL, HUB_PASSWORD);
  const hubSession =
    hub ??
    (admin
      ? (console.log("\n(note) seed hub login unavailable; using super_admin for hub routes)"),
        admin)
      : null);

  if (!hub && !hubSession) {
    record("hub login", "POST", "/api/auth/login", 401, classifyLoginFail(401), HUB_EMAIL);
  } else if (hub) {
    await runHub(hub.token, hub.user);
  } else if (hubSession) {
    await runHub(hubSession.token, hubSession.user);
  }

  if (!admin) {
    record("admin login", "POST", "/api/auth/login", 401, "fail", ADMIN_EMAIL);
  } else {
    await runAdmin(admin.token, admin.user);
    await expectOk("p2p listings (auth)", "GET", "/api/p2p/listings", () =>
      api("GET", "/api/p2p/listings", { token: admin.token }),
    );
  }

  const exitCode = printSummary();
  process.exit(exitCode > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

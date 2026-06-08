import "../src/load-env";
import { pool } from "@workspace/db";
import { hashPassword } from "../src/lib/password";

const email = "codex-login-test@example.invalid";
const password = "PhygitalTest2026!";

try {
  const passwordHash = await hashPassword(password);
  await pool.query(
    `
      insert into public.users (name, email, password_hash, base_role, account_status, public_id)
      values ($1, $2, $3, 'user', 'active', 'STD-CODEX-LOGIN')
      on conflict (email) do update set
        password_hash = excluded.password_hash,
        name = excluded.name,
        base_role = 'user',
        account_status = 'active'
    `,
    ["Codex Login Test", email, passwordHash],
  );
  const { rows } = await pool.query(
    `
      select id, email, base_role, account_status, password_hash is not null as has_password_hash
      from public.users
      where email = $1
    `,
    [email],
  );
  console.table(rows);
  console.log(`Test login: ${email} / ${password}`);
} finally {
  await pool.end();
}

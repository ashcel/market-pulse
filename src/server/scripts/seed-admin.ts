import { sql } from "../db/client";
import { countUsers, createUser, getUserByEmail, mintLoginToken } from "../auth/store";

/**
 * Seed the first admin user (invite-only means someone has to exist first),
 * then print a one-time login link token so the admin can open a session on
 * any device without a password.
 *
 *   bun run src/server/scripts/seed-admin.ts --email you@example.com --name "You"
 */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const email = arg("email", "admin@market-pulse.local")!;
  const name = arg("name", "Admin")!;

  let user = await getUserByEmail(email);
  if (!user) {
    const first = (await countUsers()) === 0;
    user = await createUser({ email, displayName: name, isAdmin: first });
    console.log(`✓ created ${first ? "admin " : ""}user ${user.email} (${user.id})`);
  } else {
    console.log(`user ${user.email} already exists (${user.id})`);
  }

  const loginToken = await mintLoginToken(user.id);
  const base = process.env.APP_URL ?? "http://localhost:3000";
  console.log(`\nLogin link (valid 30m):\n  ${base}/login?token=${loginToken}\n`);
}

main()
  .then(() => sql.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

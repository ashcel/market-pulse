import { sql } from "../db/client";
import { getUserByEmail, mintInvite } from "../auth/store";

/**
 * Mint an invite token for a closed-beta tester. Optionally bind it to an
 * email (that address is then locked in at redeem). Prints the redeem link.
 *
 *   bun run src/server/scripts/mint-invite.ts --email tester@example.com --by admin@market-pulse.local
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg("email");
  const byEmail = arg("by");
  const createdBy = byEmail ? ((await getUserByEmail(byEmail))?.id ?? null) : null;

  const token = await mintInvite({ email, createdBy });
  const base = process.env.APP_URL ?? "http://localhost:3000";
  console.log(`✓ invite minted${email ? ` for ${email}` : ""}`);
  console.log(`\nRedeem link (valid 14d):\n  ${base}/login?invite=${token}\n`);
}

main()
  .then(() => sql.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

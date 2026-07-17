import { randomBytes } from "node:crypto";

import { sql } from "../db/client";

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
}

const INVITE_TTL_HOURS = 24 * 14;
const LOGIN_TOKEN_TTL_MINUTES = 30;
const SESSION_TTL_DAYS = 60;

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    email: r.email as string,
    displayName: r.display_name as string,
    isAdmin: r.is_admin as boolean,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function countUsers(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from users`;
  return Number(row.n);
}

export async function getUserById(id: string): Promise<User | null> {
  const rows = await sql`select * from users where id = ${id}`;
  return rows.length ? rowToUser(rows[0] as Record<string, unknown>) : null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const rows = await sql`select * from users where email = ${email.toLowerCase()}`;
  return rows.length ? rowToUser(rows[0] as Record<string, unknown>) : null;
}

export async function createUser(input: {
  email: string;
  displayName: string;
  isAdmin?: boolean;
  invitedBy?: string | null;
}): Promise<User> {
  const [row] = await sql`
    insert into users (email, display_name, is_admin, invited_by)
    values (${input.email.toLowerCase()}, ${input.displayName}, ${input.isAdmin ?? false}, ${input.invitedBy ?? null})
    returning *
  `;
  return rowToUser(row as Record<string, unknown>);
}

// ── Invites ──────────────────────────────────────────────────────────────────

export async function mintInvite(input: {
  email?: string;
  createdBy?: string | null;
  ttlHours?: number;
}): Promise<string> {
  const t = token();
  const ttl = input.ttlHours ?? INVITE_TTL_HOURS;
  await sql`
    insert into invites (token, email, created_by, expires_at)
    values (${t}, ${input.email?.toLowerCase() ?? null}, ${input.createdBy ?? null},
            now() + (${ttl} || ' hours')::interval)
  `;
  return t;
}

/**
 * Redeems an invite → creates (or returns) the user. Transactional: a valid,
 * unredeemed, unexpired token creates the account and is marked spent.
 */
export async function redeemInvite(
  inviteToken: string,
  profile: { email: string; displayName: string },
): Promise<User> {
  return sql.begin(async (tx) => {
    const [invite] = await tx`
      select * from invites where token = ${inviteToken}
      for update
    `;
    if (!invite) throw new Error("invalid invite");
    if (invite.redeemed_at) throw new Error("invite already redeemed");
    if (new Date(invite.expires_at as string) < new Date()) throw new Error("invite expired");

    const email = (invite.email as string | null) ?? profile.email.toLowerCase();
    const existing = await tx`select * from users where email = ${email.toLowerCase()}`;
    const user = existing.length
      ? rowToUser(existing[0] as Record<string, unknown>)
      : rowToUser(
          (
            await tx`
              insert into users (email, display_name, invited_by)
              values (${email.toLowerCase()}, ${profile.displayName}, ${invite.created_by as string | null})
              returning *
            `
          )[0] as Record<string, unknown>,
        );

    await tx`
      update invites set redeemed_at = now(), redeemed_user = ${user.id}
      where token = ${inviteToken}
    `;
    return user;
  });
}

// ── Login tokens (passwordless re-auth on a new device) ──────────────────────

export async function mintLoginToken(
  userId: string,
  ttlMinutes = LOGIN_TOKEN_TTL_MINUTES,
): Promise<string> {
  const t = token();
  await sql`
    insert into login_tokens (token, user_id, expires_at)
    values (${t}, ${userId}, now() + (${ttlMinutes} || ' minutes')::interval)
  `;
  return t;
}

export async function consumeLoginToken(loginToken: string): Promise<string | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      select * from login_tokens where token = ${loginToken} for update
    `;
    if (!row || row.used_at || new Date(row.expires_at as string) < new Date()) return null;
    await tx`update login_tokens set used_at = now() where token = ${loginToken}`;
    return row.user_id as string;
  });
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(userId: string, deviceLabel?: string): Promise<string> {
  const t = token();
  await sql`
    insert into sessions (token, user_id, device_label, expires_at)
    values (${t}, ${userId}, ${deviceLabel ?? null}, now() + (${SESSION_TTL_DAYS} || ' days')::interval)
  `;
  return t;
}

export async function getValidSession(sessionToken: string): Promise<User | null> {
  const rows = await sql`
    select u.* from sessions s
    join users u on u.id = s.user_id
    where s.token = ${sessionToken}
      and s.revoked_at is null
      and s.expires_at > now()
  `;
  if (!rows.length) return null;
  await sql`update sessions set last_seen_at = now() where token = ${sessionToken}`;
  return rowToUser(rows[0] as Record<string, unknown>);
}

export async function revokeSession(sessionToken: string): Promise<void> {
  await sql`update sessions set revoked_at = now() where token = ${sessionToken}`;
}

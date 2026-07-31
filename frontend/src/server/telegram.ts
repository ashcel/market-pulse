import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Telegram Mini App initData verification for the web tier.
 *
 * Server-only (node:crypto + the bot token). The Mini App page hands us a
 * string signed by the bot; this proves it was signed by *our* bot, that it is
 * fresh, and that the signing Telegram user is the owner — before the tier
 * mints a session cookie for the Market Pulse owner account.
 *
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * The hash is HMAC-SHA256 over the sorted "key=value" lines, keyed by
 * HMAC-SHA256("WebAppData", botToken). Ported from notifier-bot's
 * dashboard/server.js so both services agree byte for byte.
 */

// Rejecting anything older than this limits replay of a leaked initData string.
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export interface InitDataCheck {
  ok: boolean;
  /** Never send this to the client — it helps an attacker forge a better one. */
  reason?: string;
  user?: TelegramUser | null;
}

export function telegramBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? "";
}

export function telegramAllowedUserId(): string {
  return process.env.TELEGRAM_ALLOWED_USER_ID ?? "";
}

export function verifyInitData(
  initData: string,
  botToken = telegramBotToken(),
  allowedUserId = telegramAllowedUserId(),
): InitDataCheck {
  if (!initData || !botToken) return { ok: false, reason: "missing initData or bot token" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "unparseable initData" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash in initData" };
  params.delete("hash");

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest("hex");

  // Constant-time compare — a plain === leaks how much of the hash matched.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "hash mismatch" };
  }

  const authDate = Number(params.get("auth_date") ?? 0);
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || age > INIT_DATA_MAX_AGE_SECONDS) {
    return { ok: false, reason: `initData too old (${age}s)` };
  }

  let user: TelegramUser | null = null;
  try {
    const raw = params.get("user");
    user = raw ? (JSON.parse(raw) as TelegramUser) : null;
  } catch {
    user = null;
  }

  // A valid signature proves "a real Telegram user", not "the owner".
  if (allowedUserId && String(user?.id ?? "") !== String(allowedUserId)) {
    return { ok: false, reason: "user is not the configured owner" };
  }

  return { ok: true, user };
}

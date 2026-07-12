import { getValidSession, type User } from "./store";

export const SESSION_COOKIE = "mp_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 60;

/** Parse a single cookie value out of a request's Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Serialize the session cookie (httpOnly, secure in prod, lax). */
export function sessionCookie(value: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export interface AuthContext {
  user: User;
  sessionToken: string;
}

/** Resolve the authenticated user from the session cookie, or null. */
export async function getAuth(request: Request): Promise<AuthContext | null> {
  const sessionToken = readCookie(request, SESSION_COOKIE);
  if (!sessionToken) return null;
  const user = await getValidSession(sessionToken);
  return user ? { user, sessionToken } : null;
}

/** Auth gate for API handlers: returns the context or a 401 Response to return. */
export async function requireAuth(request: Request): Promise<AuthContext | Response> {
  const auth = await getAuth(request);
  if (!auth) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return auth;
}

export function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Sign-in page. Primary mode is email + password (verified server-side by
 * FastAPI against users.hashed_password; the web tier then mints its session
 * cookie). The legacy link flows remain as entry points:
 *   /login?token=<loginToken>   → establish a session on this device
 *   /login?invite=<inviteToken> → redeem an invite (asks name/email), then a session
 */
export const Route = createFileRoute("/login")({ component: LoginPage });

async function postAuth(body: Record<string, unknown>): Promise<Response> {
  return fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Where to land after signing in. The route guard redirects anonymous visitors
 * here with `?redirect=<path>`; only same-origin absolute paths are honoured so
 * the parameter can never bounce a user to another site.
 */
function postLoginTarget(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("redirect");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function LoginPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const loginToken = params.get("token");
    const inviteToken = params.get("invite");
    if (loginToken) {
      setStatus("working");
      postAuth({ action: "login", token: loginToken, deviceLabel: navigator.userAgent })
        .then(async (r) => {
          if (r.ok) {
            setStatus("done");
            setMessage(t("login.signedInRedirecting"));
            setTimeout(() => (window.location.href = postLoginTarget()), 800);
          } else {
            const j = await r.json().catch(() => ({}));
            setStatus("error");
            setMessage(j.error ?? t("login.loginLinkInvalid"));
          }
        })
        .catch(() => {
          setStatus("error");
          setMessage(t("login.networkError"));
        });
    } else if (inviteToken) {
      setInvite(inviteToken);
    }
    // Intentionally run-once on mount (URL params don't change) — re-running on
    // a `t` reference change would re-POST the login token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async () => {
    if (!email.trim() || !password) {
      setStatus("error");
      setMessage(t("login.enterEmailPassword"));
      return;
    }
    setStatus("working");
    setMessage("");
    try {
      const r = await postAuth({
        action: "password-login",
        email: email.trim(),
        password,
        deviceLabel: navigator.userAgent,
      });
      if (r.ok) {
        setStatus("done");
        setMessage(t("login.signedInRedirecting"));
        setTimeout(() => (window.location.href = postLoginTarget()), 600);
      } else {
        const j = await r.json().catch(() => ({}));
        setStatus("error");
        setMessage(j.error ?? t("login.invalidEmailPassword"));
      }
    } catch {
      setStatus("error");
      setMessage(t("login.networkError"));
    }
  };

  const redeem = async () => {
    if (!invite) return;
    setStatus("working");
    const r = await postAuth({
      action: "redeem",
      token: invite,
      email,
      displayName,
      deviceLabel: navigator.userAgent,
    });
    if (r.ok) {
      setStatus("done");
      setMessage(t("login.welcomeAboardRedirecting"));
      setTimeout(() => (window.location.href = postLoginTarget()), 800);
    } else {
      const j = await r.json().catch(() => ({}));
      setStatus("error");
      setMessage(j.error ?? t("login.couldNotRedeemInvite"));
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold">Market Pulse</h1>
        <p className="text-muted-foreground text-sm">
          {invite ? t("login.closedBeta") : t("login.signInToAccount")}
        </p>
      </div>

      {invite && status !== "done" ? (
        <div className="flex flex-col gap-3">
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder={t("login.emailPlaceholder")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder={t("login.displayNamePlaceholder")}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button
            className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
            disabled={status === "working"}
            onClick={redeem}
          >
            {t("login.redeemInvite")}
          </button>
        </div>
      ) : null}

      {!invite && status !== "done" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn();
          }}
        >
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder={t("login.emailPlaceholder")}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder={t("login.passwordPlaceholder")}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
            type="submit"
            disabled={status === "working"}
          >
            {status === "working" ? t("login.signingIn") : t("login.signIn")}
          </button>
          <p className="text-muted-foreground text-xs">{t("login.changePasswordNote")}</p>
        </form>
      ) : null}

      {message ? (
        <p className={status === "error" ? "text-destructive text-sm" : "text-sm"}>{message}</p>
      ) : null}
    </div>
  );
}

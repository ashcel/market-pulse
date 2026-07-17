import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * Passwordless auth landing (Phase B). Two entry points, both link-based:
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

function LoginPage() {
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [email, setEmail] = useState("");
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
            setMessage("Signed in. Redirecting…");
            setTimeout(() => (window.location.href = "/"), 800);
          } else {
            const j = await r.json().catch(() => ({}));
            setStatus("error");
            setMessage(j.error ?? "Login link invalid or expired.");
          }
        })
        .catch(() => {
          setStatus("error");
          setMessage("Network error.");
        });
    } else if (inviteToken) {
      setInvite(inviteToken);
    }
  }, []);

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
      setMessage("Welcome aboard. Redirecting…");
      setTimeout(() => (window.location.href = "/"), 800);
    } else {
      const j = await r.json().catch(() => ({}));
      setStatus("error");
      setMessage(j.error ?? "Could not redeem invite.");
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold">Market Pulse</h1>
        <p className="text-muted-foreground text-sm">Closed beta — invite only.</p>
      </div>

      {invite && status !== "done" ? (
        <div className="flex flex-col gap-3">
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button
            className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
            disabled={status === "working"}
            onClick={redeem}
          >
            Redeem invite
          </button>
        </div>
      ) : null}

      {!invite && status === "idle" ? (
        <p className="text-muted-foreground text-sm">
          Open the login link from your invite email to sign in.
        </p>
      ) : null}

      {message ? (
        <p className={status === "error" ? "text-destructive text-sm" : "text-sm"}>{message}</p>
      ) : null}
    </div>
  );
}

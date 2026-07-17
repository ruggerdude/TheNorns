import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "./auth";
import {
  acceptInvite,
  bootstrap,
  completePasswordRecovery,
  describeAuthError,
  login,
  requestPasswordRecovery,
} from "./auth";
import { Alert, Brand, Button, Field, Input } from "./ui";

export type LoginMode = "login" | "bootstrap" | "invite" | "recovery";

export function Login({
  mode,
  inviteToken,
  recoveryToken,
  onAuthenticated,
  onRecoveryComplete,
  error: externalError,
}: {
  mode: LoginMode;
  inviteToken?: string | null;
  recoveryToken?: string | null;
  onAuthenticated: (session: AuthSession) => void;
  onRecoveryComplete?: () => void;
  error: string | null;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [deployToken, setDeployToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [requestMode, setRequestMode] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const error = formError ?? externalError;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      if (requestMode) {
        await requestPasswordRecovery(email.trim());
        setRecoverySent(true);
        setSubmitting(false);
        return;
      }
      if (mode === "recovery") {
        await completePasswordRecovery(recoveryToken ?? "", password);
        setSubmitting(false);
        onRecoveryComplete?.();
        return;
      }
      const session =
        mode === "bootstrap"
          ? await bootstrap(deployToken.trim(), email.trim(), password, name.trim() || undefined)
          : mode === "invite"
            ? await acceptInvite(inviteToken ?? "", password)
            : await login(email.trim(), password);
      onAuthenticated(session);
    } catch (err) {
      setFormError(describeAuthError(err));
      setSubmitting(false);
    }
  };

  const heading =
    mode === "bootstrap"
      ? "Set up the first admin account"
      : mode === "invite"
        ? "Accept your invite"
        : mode === "recovery"
          ? "Reset your password"
          : requestMode
            ? "Recover your account"
            : "Enter your workspace";
  const subhead =
    mode === "bootstrap"
      ? "This runs once. Use the deploy setup key to create the first admin."
      : mode === "invite"
        ? "Choose a password to activate your account."
        : mode === "recovery"
          ? "Choose a new password. Every existing session will be revoked."
          : requestMode
            ? "We'll email a one-hour reset link if this account exists."
            : "Sign in with your email and password.";
  const eyebrow =
    mode === "bootstrap"
      ? "First-time setup"
      : mode === "invite"
        ? "Welcome"
        : mode === "recovery" || requestMode
          ? "Account recovery"
          : "Welcome back";
  const submitLabel =
    mode === "bootstrap"
      ? "Create admin account"
      : mode === "invite"
        ? "Activate account"
        : mode === "recovery"
          ? "Reset password"
          : requestMode
            ? "Send recovery link"
            : "Sign in";

  const canSubmit =
    mode === "bootstrap"
      ? deployToken.trim().length > 0 && email.trim().length > 0 && password.length >= 8
      : mode === "invite"
        ? password.length >= 8
        : mode === "recovery"
          ? password.length >= 8
          : requestMode
            ? email.trim().length > 0
            : email.trim().length > 0 && password.length > 0;

  return (
    <main className="login">
      <section className="login-art">
        <Brand />
        <div className="login-copy">
          <div className="eyebrow">AI program management</div>
          <h1>
            Shape the work.
            <br />
            Keep the thread.
          </h1>
          <p>
            Turn an objective into an accountable execution graph—with a second model reviewing
            every plan before it ships.
          </p>
        </div>
        <div className="meta">HUMAN-GATED · CROSS-PROVIDER · AUDITABLE</div>
      </section>
      <section className="login-panel">
        <form className="login-card card" onSubmit={(e) => void submit(e)}>
          <div className="eyebrow">{eyebrow}</div>
          <h2>{heading}</h2>
          <p className="muted">{subhead}</p>

          {mode === "bootstrap" ? (
            <Field label="Deploy setup key">
              <Input
                ref={firstRef}
                type="password"
                value={deployToken}
                onChange={(e) => setDeployToken(e.target.value)}
                placeholder="NORNS_TOKEN"
                autoComplete="off"
              />
            </Field>
          ) : null}

          {mode !== "invite" && mode !== "recovery" ? (
            <Field label="Email">
              <Input
                ref={mode === "login" ? firstRef : undefined}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
              />
            </Field>
          ) : null}

          {mode === "bootstrap" ? (
            <Field label="Name (optional)">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </Field>
          ) : null}

          {!requestMode ? (
            <Field label={mode === "login" ? "Password" : "Choose a password"}>
              <Input
                ref={mode === "invite" || mode === "recovery" ? firstRef : undefined}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "login" ? "Enter password" : "At least 8 characters"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </Field>
          ) : null}

          {error ? <Alert testId="login-error">{error}</Alert> : null}
          {recoverySent ? (
            <Alert>If the account exists, a recovery link has been sent.</Alert>
          ) : null}
          <Button
            variant="primary"
            className="btn-block"
            type="submit"
            disabled={!canSubmit || submitting}
          >
            {submitting ? "Working…" : submitLabel}
          </Button>
          {mode === "login" ? (
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setRequestMode((current) => !current);
                setRecoverySent(false);
                setFormError(null);
              }}
            >
              {requestMode ? "Back to sign in" : "Forgot password?"}
            </Button>
          ) : null}
        </form>
      </section>
    </main>
  );
}

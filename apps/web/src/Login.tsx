import { useEffect, useRef, useState } from "react";
import { Alert, Brand, Button, Field, Input } from "./ui";

export function Login({
  onLogin,
  error,
}: { onLogin: (token: string) => void; error: string | null }): React.ReactElement {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
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
        <form
          className="login-card card"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) {
              setSubmitting(true);
              onLogin(value.trim());
            }
          }}
        >
          <div className="eyebrow">Welcome back</div>
          <h2>Enter your workspace</h2>
          <p className="muted">
            Use your access token to continue. It stays in this browser session.
          </p>
          <Field label="Access token">
            <Input
              ref={ref}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter access token"
              autoComplete="current-password"
            />
          </Field>
          {error ? <Alert testId="login-error">{error}</Alert> : null}
          <Button
            variant="primary"
            className="btn-block"
            type="submit"
            disabled={!value.trim() || submitting}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
}

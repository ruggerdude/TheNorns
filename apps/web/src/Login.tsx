import { useEffect, useRef, useState } from "react";

export function Login({
  onLogin,
  error,
}: {
  onLogin: (token: string) => void;
  error: string | null;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "ui-monospace, monospace",
        background: "#111",
        color: "#ddd",
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onLogin(value.trim());
        }}
        style={{
          border: "1px solid #333",
          borderRadius: 10,
          padding: 32,
          width: 340,
          background: "#181818",
        }}
      >
        <h1 style={{ marginTop: 0, fontSize: 20 }}>TheNorns</h1>
        <p style={{ color: "#999", fontSize: 13 }}>Enter your access token to continue.</p>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="access token"
          aria-label="access token"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            marginBottom: 10,
            background: "#000",
            border: "1px solid #444",
            borderRadius: 6,
            color: "#ddd",
            fontFamily: "inherit",
          }}
        />
        <button
          type="submit"
          style={{
            width: "100%",
            padding: "8px 10px",
            background: "#d97706",
            border: "none",
            borderRadius: 6,
            color: "#111",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Sign in
        </button>
        {error ? (
          <div data-testid="login-error" style={{ color: "#f87171", marginTop: 10, fontSize: 13 }}>
            {error}
          </div>
        ) : null}
      </form>
    </div>
  );
}

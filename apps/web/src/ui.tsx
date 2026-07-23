import { forwardRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
}) {
  return <button {...props} className={`btn btn-${variant} ${className}`} />;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the child component renders its control inside this label.
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} {...props} className={`input ${props.className ?? ""}`} />;
  },
);
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`textarea ${props.className ?? ""}`} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`select ${props.className ?? ""}`} />;
}
export function Alert({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="alert" data-testid={testId}>
      <span className="alert-body">{children}</span>
    </div>
  );
}
/**
 * POLISH P3 — neutral guidance, visually distinct from `Alert`. The resume
 * payload's `next_recommended_action` is a suggestion ("Analyze the
 * repository…", "Create the project's next phase"), and rendering it in the
 * red exclamation-icon alert made routine guidance read as a failure. Real
 * problems keep using `Alert`; this is for what to do next.
 */
export function NextStep({
  children,
  action,
  testId,
}: {
  children: ReactNode;
  /** Optional inline control that performs the step (e.g. an Analyze button). */
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="next-step" data-testid={testId}>
      <span className="next-step-label">Next step</span>
      <span className="next-step-body">{children}</span>
      {action ? <div className="next-step-action">{action}</div> : null}
    </div>
  );
}
/**
 * EXECUTION E13 — a plain, one-time explanation that a human can dismiss for
 * good (persisted in localStorage under `storageKey`), matching the register
 * FRONT DOOR/EXECUTION established elsewhere: honest and factual, no
 * marketing, dismissible rather than nagging on every visit. Best-effort
 * around localStorage (a private-browsing tab, or storage disabled, just
 * means it re-shows next time — never a thrown error).
 */
export function DismissibleNote({
  storageKey,
  children,
  testId,
}: {
  storageKey: string;
  children: ReactNode;
  testId?: string;
}) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="dismissible-note" data-testid={testId}>
      <span className="alert-body">{children}</span>
      <button
        type="button"
        className="dismissible-note-close"
        aria-label="Dismiss this note"
        onClick={() => {
          setDismissed(true);
          try {
            window.localStorage.setItem(storageKey, "1");
          } catch {
            /* best effort — storage may be unavailable */
          }
        }}
      >
        ×
      </button>
    </div>
  );
}
export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {label}
    </div>
  );
}
export function Badge({
  children,
  tone = "default",
}: { children: ReactNode; tone?: "default" | "success" | "warn" | "danger" | "info" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">◈</span>TheNorns
    </div>
  );
}

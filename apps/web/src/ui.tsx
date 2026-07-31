import { forwardRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { BraidMark } from "./BraidMark";
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
export function Alert({
  children,
  testId,
  tone = "danger",
}: {
  children: ReactNode;
  testId?: string;
  tone?: "danger" | "info" | "success";
}) {
  return (
    <div className={`alert alert-${tone}`} data-testid={testId}>
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
/**
 * DESIGN R2 — the braided-threads mark (see BraidMark.tsx): three strands
 * — indigo, gold, silver — woven with true over/under crossings. `BrandMark`
 * keeps its legacy `{ size }` API by scaling the topbar braid recipe
 * (64×26, lead 14, period 34) so existing call sites keep working.
 */
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  const scale = size / 26;
  return (
    <BraidMark
      width={Math.round(64 * scale)}
      height={size}
      lead={14 * scale}
      period={34 * scale}
      strokeWidth={4.5 * scale}
      className={className}
    />
  );
}
/**
 * DESIGN R2 — the brand lockup. `topbar` (default): a compact 64×26 braid
 * beside the wordmark at 20px. `hero` (login-scale): the wordmark at
 * 40px stacked above a 300×34 braid with a long lead-in.
 */
export function Brand({
  variant = "topbar",
  onHome,
}: {
  variant?: "topbar" | "hero";
  onHome?: () => void;
}) {
  if (variant === "hero") {
    return (
      <div className="brand brand-hero">
        <span className="brand-word">The Norns</span>
        <BraidMark width={300} height={34} lead={96} period={78} strokeWidth={6} />
      </div>
    );
  }
  const lockup = (
    <>
      <BraidMark width={64} height={26} lead={14} period={34} strokeWidth={4.5} />
      <span className="brand-word">The Norns</span>
    </>
  );
  return onHome ? (
    <button
      type="button"
      className="brand brand-home"
      aria-label="Go to Portfolio"
      onClick={onHome}
    >
      {lockup}
    </button>
  ) : (
    <div className="brand">{lockup}</div>
  );
}
/**
 * DESIGN P1 — canonical page intro. Every page header converges on this:
 * eyebrow (uppercase brand ink), h1 (--text-2xl / 800), optional lede, and
 * an optional right-aligned actions slot.
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header-copy">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {lede ? <p className="page-header-lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  );
}

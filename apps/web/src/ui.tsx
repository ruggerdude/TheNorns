import { forwardRef } from "react";
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

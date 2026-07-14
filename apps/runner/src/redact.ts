// Secret redaction (PRD R4 §Security): applied to every log chunk BEFORE it
// leaves the runner — buffered events are already redacted, so no secret is
// ever persisted or transmitted. Pattern-based redaction is heuristic by
// design; defense in depth is the sandbox limiting what can reach logs
// (ADR-003). The runner also registers every credential it injects, so known
// secrets are removed exactly.
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // API secret keys (Anthropic/OpenAI style)
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PATs
  /gho_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM keys
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, // key=value leaks
];

export const REDACTED = "[REDACTED]";

export class Redactor {
  private readonly known: string[] = [];

  /** Register a credential the runner injected — removed exactly, always. */
  registerSecret(secret: string): void {
    if (secret.length >= 6 && !this.known.includes(secret)) this.known.push(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.known) {
      out = out.split(secret).join(REDACTED);
    }
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }
}
